import crypto from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { env } from '../config.js';
import { politeness } from './politeness.js';
import { checkRobotsPermission } from './robots.js';
import { atomicClaimJob, heartbeatJob, startJob, completeJob, recoverExpiredLeases } from './jobs.js';
import { capturePage } from '../capture/playwrightCapture.js';
import { captureHttpDom } from '../capture/httpDomCapture.js';
import { CaptureConfigSchema } from '../capture/captureConfig.js';
import { classifyCheck } from '../capture/classifier.js';
import {
  type WorkerCandidateRow,
  type SubscriptionRow,
  type ObservationRow,
  handleBlockedByRobots,
  processOkOutcome,
  handleFailedCapture,
} from './workerHandlers.js';

export { type WorkerCandidateRow, type SubscriptionRow, type ObservationRow } from './workerHandlers.js';

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

  public async waitForIdle(timeoutMs = 30000): Promise<void> {
    const start = Date.now();
    while (this.activeJobsCount > 0) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('WorkerPool waitForIdle timed out');
      }
      await new Promise(r => setTimeout(r, 50));
    }
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
        handleBlockedByRobots(this.db, candidate, robots.reason ?? 'robots_disallowed');
        return;
      }

      // 2. Due-only evaluation (Acceptance Matrix AA)
      const nowIso = new Date().toISOString();
      const dueSubs = this.db.prepare(`
        SELECT id, target_id, interval_minutes, capture_config, capture_fingerprint,
               next_check_at, include_selectors, ignore_selectors, sensitivity,
               noise_filters, learned_ignore_patterns, keyword_rules
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
        SELECT id, sanitized_dom, raw_text, captured_at FROM observations
        WHERE target_id = ? AND capture_fingerprint = ? AND captured_at >= ?
        ORDER BY captured_at DESC LIMIT 1
      `).get(targetId, fingerprint, reuseCutoff) as ObservationRow | undefined;

      if (existingObs) {
        processOkOutcome(this.db, dueSubs, jobId, targetId, 0, true, existingObs);
        return;
      }

      // 4. Capture with Playwright or Cheerio http_dom
      const startTime = Date.now();
      const config = CaptureConfigSchema.parse(JSON.parse(dueSubs[0].capture_config));
      const captureResult = config.engine === 'http_dom'
        ? await captureHttpDom(canonicalUrl, config)
        : await capturePage(canonicalUrl, config);
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
            http_status, sanitized_dom, raw_text, screenshot_path,
            subresource_count, top_level_navigations, captured_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          captureResult.observationId, targetId, fingerprint, config.engine, captureResult.finalUrl,
          captureResult.httpStatus, captureResult.sanitizedDom, captureResult.rawText, captureResult.screenshotPath,
          captureResult.subresourceCount, captureResult.topLevelNavigations, capturedAt
        );

        this.db.prepare('UPDATE targets SET last_fetched_at = ?, last_fetch_outcome = ? WHERE id = ?')
          .run(capturedAt, 'OK', targetId);

        const newObs: ObservationRow = {
          id: captureResult.observationId,
          sanitized_dom: captureResult.sanitizedDom,
          raw_text: captureResult.rawText,
          captured_at: capturedAt,
        };

        processOkOutcome(this.db, dueSubs, jobId, targetId, durationMs, false, newObs);
      } else {
        handleFailedCapture(
          this.db, dueSubs, jobId, targetId, classification.outcome, classification.reason,
          captureResult.httpStatus, durationMs
        );
      }
    } finally {
      clearInterval(heartbeatTimer);
      politeness.releaseDomain(hostname, Date.now());
    }
  }
}
