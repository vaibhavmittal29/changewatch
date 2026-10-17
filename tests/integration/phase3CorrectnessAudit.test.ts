import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { extractNumericValue } from '../../src/server/routes/stretchFeatures.js';
import { getDb } from '../../src/server/db/index.js';
import { migrate } from '../../src/server/db/migrate.js';
import { processOkOutcome, type SubscriptionRow, type ObservationRow } from '../../src/server/queue/workerHandlers.js';
import { env } from '../../src/server/config.js';
import * as geminiModule from '../../src/server/engine/geminiSummary.js';
import { WorkerPool } from '../../src/server/queue/worker.js';
import * as jobsModule from '../../src/server/queue/jobs.js';
import { politeness } from '../../src/server/queue/politeness.js';

describe('Phase 3 Correctness Audit: Numeric Labels, Gemini Race, Heartbeat Cleanup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('3A: Numeric Extraction Strict Label Matching', () => {
    it('returns null if requested label is not found in text, avoiding false positive fallback', () => {
      // Finding requirement: SKU 123 followed by Stock 40 with label Price must return null
      const result = extractNumericValue('SKU 123 Stock 40', 'Price');
      expect(result).toBeNull();

      // Matching label returns correct value
      const priceResult = extractNumericValue('SKU 123 Price: $49.99 Stock 40', 'Price');
      expect(priceResult).toBe(49.99);

      // Without label, fallback to first number is preserved
      const noLabelResult = extractNumericValue('SKU 123 Stock 40');
      expect(noLabelResult).toBe(123);
    });
  });

  describe('3B: Gemini Summary vs Notification Outbox Race Condition', () => {
    it('enqueues notification outbox with Gemini enriched summary when Gemini succeeds', async () => {
      const db = getDb();
      migrate(db);

      const userId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO users (id, email, password_hash, password_salt, password_iterations, display_name)
        VALUES (?, ?, 'hash', 'salt', 1000, 'Gemini Tester')
      `).run(userId, `gemini-${Date.now()}@example.com`);

      const targetId = crypto.randomUUID();
      const targetUrl = `https://gemini-race-${crypto.randomUUID()}.example.com`;
      db.prepare(`
        INSERT INTO targets (id, canonical_url, hostname, origin)
        VALUES (?, ?, 'gemini-race-test.example.com', 'https://gemini-race-test.example.com')
      `).run(targetId, targetUrl);

      const subId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO subscriptions (
          id, user_id, target_id, name, interval_minutes, next_check_at,
          capture_config, capture_fingerprint
        ) VALUES (?, ?, ?, 'Gemini Race Sub', 30, datetime('now'), '{"engine":"playwright"}', 'fp-gemini')
      `).run(subId, userId, targetId);

      // Baseline version 1
      const obs1Id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO observations (
          id, target_id, capture_fingerprint, engine_used, final_url, http_status,
          sanitized_dom, raw_text, subresource_count, top_level_navigations, captured_at
        ) VALUES (?, ?, 'fp-gemini', 'playwright', 'https://gemini-race-test.example.com', 200, '<p>Old</p>', 'Old Text', 0, 1, datetime('now'))
      `).run(obs1Id, targetId);

      const v1Id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO monitor_versions (
          id, subscription_id, observation_id, version_number, content_hash, stored_text, change_summary, created_at
        ) VALUES (?, ?, ?, 1, 'hash-old', 'Old Text', 'Baseline', datetime('now'))
      `).run(v1Id, subId, obs1Id);

      db.prepare(`
        INSERT INTO sub_state (subscription_id, active_version_id, pending_candidate_hash, pending_candidate_checks)
        VALUES (?, ?, 'hash-new', 1)
      `).run(subId, v1Id);

      env.GEMINI_API_KEY = 'test-gemini-key';
      vi.spyOn(geminiModule, 'generateChangeSummary').mockResolvedValue({
        summary: 'AI-Generated: Headline updated to Breaking News',
        source: 'gemini',
      });

      const dueSub: SubscriptionRow = {
        id: subId,
        target_id: targetId,
        interval_minutes: 30,
        capture_config: '{"engine":"playwright"}',
        capture_fingerprint: 'fp-gemini',
        next_check_at: new Date().toISOString(),
        include_selectors: '[]',
        ignore_selectors: '[]',
        sensitivity: 'balanced',
        noise_filters: '{}',
        learned_ignore_patterns: '[]',
      };

      const obs2Id = crypto.randomUUID();
      const capturedAt = new Date().toISOString();
      db.prepare(`
        INSERT INTO observations (
          id, target_id, capture_fingerprint, engine_used, final_url, http_status,
          sanitized_dom, raw_text, subresource_count, top_level_navigations, captured_at
        ) VALUES (?, ?, 'fp-gemini', 'playwright', 'https://gemini-race-test.example.com', 200, '<p>New</p>', 'New Text', 0, 1, ?)
      `).run(obs2Id, targetId, capturedAt);

      const obs2: ObservationRow = {
        id: obs2Id,
        sanitized_dom: '<p>New</p>',
        raw_text: 'New Text',
        captured_at: capturedAt,
      };

      const jobId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO jobs (id, kind, target_id, capture_fingerprint, status, scheduled_at, created_at)
        VALUES (?, 'CHECK', ?, 'fp-gemini', 'RUNNING', datetime('now'), datetime('now'))
      `).run(jobId, targetId);

      // Confirm change (Criterion P state machine requires 2 consecutive observations)
      await processOkOutcome(db, [dueSub], jobId, targetId, 100, false, obs2);
      await processOkOutcome(db, [dueSub], jobId, targetId, 100, false, obs2);

      // Verify that notification_outbox contains the final Gemini summary
      const outboxRow = db.prepare(`
        SELECT payload FROM notification_outbox WHERE change_event_id IN (
          SELECT id FROM change_events WHERE subscription_id = ?
        )
      `).get(subId) as { payload: string } | undefined;

      expect(outboxRow).toBeDefined();
      const payload = JSON.parse(outboxRow!.payload);
      expect(payload.summary).toBe('AI-Generated: Headline updated to Breaking News');
    });
  });

  describe('3D: Worker Heartbeat Timer Leak Prevention', () => {
    it('clears heartbeat interval and releases domain even if startJob throws an error', async () => {
      const db = getDb();
      const pool = new WorkerPool(db, 1, 1000);

      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      const releaseDomainSpy = vi.spyOn(politeness, 'releaseDomain');

      // Force startJob to throw an error
      vi.spyOn(jobsModule, 'startJob').mockImplementation(() => {
        throw new Error('Simulated database locked error during startJob');
      });

      const candidate = {
        id: 'job-leak-test',
        kind: 'CHECK' as const,
        target_id: 'target-123',
        capture_fingerprint: 'fp-123',
        subscription_id: 'sub-123',
        hostname: 'leak-test.example.com',
        canonical_url: 'https://leak-test.example.com',
      };

      await expect(pool.executeJob(candidate)).rejects.toThrow('Simulated database locked error');

      // Verify heartbeat interval was safely cleared in finally block
      expect(clearIntervalSpy).toHaveBeenCalled();
      // Verify domain was released
      expect(releaseDomainSpy).toHaveBeenCalledWith('leak-test.example.com', expect.any(Number));
    });
  });
});
