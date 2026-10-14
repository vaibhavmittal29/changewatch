import crypto from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { env } from '../config.js';
import { politeness, PolitenessManager } from './politeness.js';
import { checkRobotsPermission } from './robots.js';
import { atomicClaimJob, heartbeatJob, startJob, completeJob, failOrRetryJob, recoverExpiredLeases } from './jobs.js';
import { capturePage } from '../capture/playwrightCapture.js';
import { CaptureConfigSchema } from '../capture/captureConfig.js';
import { classifyCheck } from '../capture/classifier.js';

export interface WorkerCandidateRow {
  id: string;
  kind: 'CHECK' | 'PROBE';
  target_id: string;
  capture_fingerprint: string | null;
  subscription_id: string | null;
  hostname: string;
  canonical_url: string;
}

interface SubscriptionRow {
  id: string;
  target_id: string;
  interval_minutes: number;
  capture_config: string;
  capture_fingerprint: string;
  next_check_at: string;
}

interface ObservationRow {
  id: string;
  captured_at: string;
}

/**
 * Inserts an execution record into check_runs table.
 */
function recordCheckRun(
  db: Database,
  subscriptionId: string | null,
  targetId: string,
  jobId: string,
  outcome: 'OK' | 'ERROR' | 'BLOCKED',
  reason: string | null,
  httpStatus: number | null,
  durationMs: number,
  wasDeduplicated: boolean
): void {
  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT INTO check_runs (
      id, subscription_id, target_id, job_id, outcome, reason,
      http_status, duration_ms, was_deduplicated, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, subscriptionId, targetId, jobId, outcome, reason,
    httpStatus, durationMs, wasDeduplicated ? 1 : 0, nowIso
  );
}

export class WorkerPool {
  private isRunning = false;
  private loopTimer: NodeJS.Timeout | null = null;
  private activeJobsCount = 0;
  public readonly workerId: string;

  constructor(
    private readonly db: Database,
    private readonly concurrency: number = env.WORKER_CONCURRENCY,
    private readonly pollIntervalMs: number = 1000
  ) {
    this.workerId = `worker-${crypto.randomUUID().slice(0, 8)}`;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Crash recovery: reclaim any expired leases on startup
    const recovered = recoverExpiredLeases(this.db);
    if (recovered > 0) {
      console.log(`[WORKER] Recovered ${recovered} expired job lease(s) on startup.`);
    }

    this.scheduleNextPoll();
  }

  public stop(): void {
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    this.isRunning = false;
  }

  private scheduleNextPoll(): void {
    if (!this.isRunning) return;
    this.loopTimer = setTimeout(async () => {
      try {
        await this.pollAndExecute();
      } catch (err) {
        console.error('[WORKER] Error in poll loop:', err);
      } finally {
        this.scheduleNextPoll();
      }
    }, this.pollIntervalMs);
  }

  /**
   * Finds eligible queued jobs whose domains are not locked/within quiet period,
   * claims them atomically, and processes them concurrently.
   */
  public async pollAndExecute(): Promise<number> {
    if (this.activeJobsCount >= this.concurrency) return 0;

    const nowIso = new Date().toISOString();
    const candidates = this.db.prepare(`
      SELECT j.id, j.kind, j.target_id, j.capture_fingerprint, j.subscription_id,
             t.hostname, t.canonical_url
      FROM jobs j
      JOIN targets t ON j.target_id = t.id
      WHERE j.status = 'QUEUED' AND j.scheduled_at <= ?
      ORDER BY j.scheduled_at ASC
      LIMIT 20
    `).all(nowIso) as WorkerCandidateRow[];

    let executed = 0;

    for (const candidate of candidates) {
      if (this.activeJobsCount >= this.concurrency) break;

      if (!politeness.canFetchDomain(candidate.hostname)) {
        continue;
      }

      const claimed = atomicClaimJob(this.db, this.workerId, 30_000, candidate.id);
      if (!claimed) continue;

      if (!politeness.acquireDomain(candidate.hostname)) {
        // Domain became busy concurrently, reset job status back to QUEUED
        this.db.prepare("UPDATE jobs SET status = 'QUEUED', locked_by = NULL, lease_expires_at = NULL WHERE id = ?").run(claimed.id);
        continue;
      }

      this.activeJobsCount++;
      executed++;

      // Execute asynchronously in background
      this.executeJob(candidate)
        .catch((err) => console.error(`[WORKER] Unhandled job error ${candidate.id}:`, err))
        .finally(() => {
          this.activeJobsCount--;
        });
    }

    return executed;
  }

  /**
   * Orchestrates job execution, robots check, shared capture reuse, and failure accounting.
   */
  public async executeJob(candidate: WorkerCandidateRow): Promise<void> {
    const { id: jobId, target_id: targetId, capture_fingerprint: fingerprint, hostname, canonical_url: canonicalUrl } = candidate;

    const heartbeatTimer = setInterval(() => {
      heartbeatJob(this.db, jobId, this.workerId, 30_000);
    }, 10_000);

    startJob(this.db, jobId, this.workerId);

    try {
      // 1. Robots.txt evaluation
      const robots = await checkRobotsPermission(this.db, canonicalUrl);
      if (!robots.allowed) {
        await this.handleBlockedByRobots(candidate, robots.reason ?? 'robots_disallowed');
        return;
      }

      // 2. Due-only evaluation (Acceptance Matrix AA)
      const nowIso = new Date().toISOString();
      const dueSubs = this.db.prepare(`
        SELECT id, target_id, interval_minutes, capture_config, capture_fingerprint, next_check_at
        FROM subscriptions
        WHERE target_id = ? AND capture_fingerprint = ? AND is_paused = 0 AND next_check_at <= ?
      `).all(targetId, fingerprint, nowIso) as SubscriptionRow[];

      if (dueSubs.length === 0) {
        completeJob(this.db, jobId);
        return;
      }

      // 3. Shared capture reuse window (Acceptance Matrix S, 15s TTL)
      const reuseCutoff = new Date(Date.now() - env.SHARED_CAPTURE_TTL_MS).toISOString();
      const existingObs = this.db.prepare(`
        SELECT id, captured_at FROM observations
        WHERE target_id = ? AND capture_fingerprint = ? AND captured_at >= ?
        ORDER BY captured_at DESC LIMIT 1
      `).get(targetId, fingerprint, reuseCutoff) as ObservationRow | undefined;

      if (existingObs) {
        // Reuse cached capture
        this.processOkOutcome(dueSubs, jobId, targetId, 0, true);
        return;
      }

      // 4. Capture with Playwright
      const startTime = Date.now();
      const config = CaptureConfigSchema.parse(JSON.parse(dueSubs[0].capture_config));
      const captureResult = await capturePage(canonicalUrl, config);
      const durationMs = Date.now() - startTime;

      const classification = classifyCheck({
        httpStatus: captureResult.httpStatus,
        rawText: captureResult.rawText,
        sanitizedDom: captureResult.sanitizedDom,
        errorMessage: captureResult.errorMessage,
        isTimeout: captureResult.isTimeout,
        pageTooLarge: captureResult.pageTooLarge,
      });

      if (classification.outcome === 'OK') {
        const capturedAt = new Date().toISOString();

        this.db.prepare(`
          INSERT INTO observations (
            id, target_id, capture_fingerprint, engine_used, final_url,
            http_status, sanitized_dom, raw_text, screenshot_path, subresource_count, captured_at
          ) VALUES (?, ?, ?, 'playwright', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          captureResult.observationId, targetId, fingerprint, captureResult.finalUrl,
          captureResult.httpStatus, captureResult.sanitizedDom, captureResult.rawText, captureResult.screenshotPath,
          captureResult.subresourceCount, capturedAt
        );

        this.db.prepare('UPDATE targets SET last_fetched_at = ?, last_fetch_outcome = ? WHERE id = ?')
          .run(capturedAt, 'OK', targetId);

        this.processOkOutcome(dueSubs, jobId, targetId, durationMs, false);
      } else {
        await this.handleFailedCapture(
          dueSubs, jobId, targetId, classification.outcome, classification.reason,
          captureResult.httpStatus, durationMs
        );
      }
    } finally {
      clearInterval(heartbeatTimer);
      politeness.releaseDomain(hostname, Date.now());
    }
  }

  private handleBlockedByRobots(candidate: WorkerCandidateRow, reason: string): void {
    const dueSubs = this.db.prepare(`
      SELECT id, interval_minutes FROM subscriptions
      WHERE target_id = ? AND capture_fingerprint = ? AND is_paused = 0
    `).all(candidate.target_id, candidate.capture_fingerprint) as { id: string; interval_minutes: number }[];

    for (const sub of dueSubs) {
      recordCheckRun(this.db, sub.id, candidate.target_id, candidate.id, 'BLOCKED', reason, null, 0, false);
      this.incrementFailureAndAdvance(sub.id, sub.interval_minutes);
    }

    failOrRetryJob(this.db, candidate.id, reason, false);
  }

  private processOkOutcome(
    dueSubs: SubscriptionRow[],
    jobId: string,
    targetId: string,
    durationMs: number,
    wasDeduplicated: boolean
  ): void {
    for (const sub of dueSubs) {
      recordCheckRun(this.db, sub.id, targetId, jobId, 'OK', null, 200, durationMs, wasDeduplicated);
      this.db.prepare('UPDATE sub_state SET consecutive_failures = 0 WHERE subscription_id = ?').run(sub.id);

      const nextMs = Date.now() + PolitenessManager.addJitter(sub.interval_minutes * 60 * 1000, 0.1);
      this.db.prepare('UPDATE subscriptions SET next_check_at = ? WHERE id = ?')
        .run(new Date(nextMs).toISOString(), sub.id);
    }

    completeJob(this.db, jobId);
  }

  private async handleFailedCapture(
    dueSubs: SubscriptionRow[],
    jobId: string,
    targetId: string,
    outcome: 'ERROR' | 'BLOCKED',
    reason: string | null,
    httpStatus: number | null,
    durationMs: number
  ): Promise<void> {
    for (const sub of dueSubs) {
      recordCheckRun(this.db, sub.id, targetId, jobId, outcome, reason, httpStatus, durationMs, false);
    }

    const isTransient = outcome === 'ERROR' && (reason === 'timeout' || reason === 'network_error' || (httpStatus !== null && httpStatus >= 500));
    const retryResult = failOrRetryJob(this.db, jobId, reason ?? outcome, isTransient);

    // Acceptance Matrix AK: Only increment consecutive_failures when job is permanently exhausted or non-transient
    if (retryResult.exhausted || !retryResult.retried) {
      for (const sub of dueSubs) {
        this.incrementFailureAndAdvance(sub.id, sub.interval_minutes);
      }
    }
  }

  private incrementFailureAndAdvance(subId: string, intervalMinutes: number): void {
    this.db.prepare('UPDATE sub_state SET consecutive_failures = consecutive_failures + 1 WHERE subscription_id = ?')
      .run(subId);

    const nextMs = Date.now() + PolitenessManager.addJitter(intervalMinutes * 60 * 1000, 0.1);
    this.db.prepare('UPDATE subscriptions SET next_check_at = ? WHERE id = ?')
      .run(new Date(nextMs).toISOString(), subId);
  }
}
