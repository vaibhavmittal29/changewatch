import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { captureFingerprint } from '../capture/captureConfig.js';
import { validateUrl } from '../capture/validateUrl.js';
import { env } from '../config.js';
import { deleteSubscriptionCascade } from '../maintenance/deleteFlow.js';
import { KeywordRulesArraySchema } from '../engine/keywordRules.js';

export const subscriptionsRouter = Router();

const CreateSubscriptionSchema = z.object({
  url: z.string().refine(val => {
    try { const u = new URL(val); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
  }, 'Must be a valid HTTP or HTTPS URL'),
  name: z.string().min(1).max(100),
  interval_minutes: z.coerce.number().int(),
  sensitivity: z.enum(['low', 'balanced', 'high']).default('balanced'),
  capture_config: z.record(z.unknown()).optional(),
  include_selectors: z.array(z.string()).default([]),
  ignore_selectors: z.array(z.string()).default([]),
  noise_filters: z.object({ timestamps: z.boolean().default(true), counters: z.boolean().default(true), tokens: z.boolean().default(true) }).default({ timestamps: true, counters: true, tokens: true }),
  keyword_rules: KeywordRulesArraySchema.optional().default([]),
});

const UpdateSubscriptionSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  interval_minutes: z.coerce.number().int().optional(),
  sensitivity: z.enum(['low', 'balanced', 'high']).optional(),
  capture_config: z.record(z.unknown()).optional(),
  include_selectors: z.array(z.string()).optional(),
  ignore_selectors: z.array(z.string()).optional(),
  noise_filters: z.object({ timestamps: z.boolean().optional(), counters: z.boolean().optional(), tokens: z.boolean().optional() }).optional(),
  keyword_rules: KeywordRulesArraySchema.optional(),
  is_paused: z.boolean().optional(),
});

export function validateInterval(intervalMinutes: number, urlOrigin: string): boolean {
  let isDemo = false;
  if (env.ALLOW_LOCAL_DEMO) {
    try {
      const u = new URL(urlOrigin);
      const isLoopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
      const port = parseInt(u.port || (u.protocol === 'https:' ? '443' : '80'), 10);
      isDemo = isLoopback && port === env.DEMO_PORT;
    } catch { isDemo = false; }
  }
  const minInterval = (isDemo && env.DEV_MIN_INTERVAL_MINUTES) ? env.DEV_MIN_INTERVAL_MINUTES : 15;
  return intervalMinutes >= minInterval && intervalMinutes <= 1440;
}

// GET /api/subscriptions
subscriptionsRouter.get('/', (req, res) => {
  const db = getDb();
  const userId = req.user!.id;
  const rows = db.prepare(`
    SELECT s.id, s.name, s.interval_minutes, s.next_check_at, s.sensitivity, s.include_selectors, s.ignore_selectors,
           s.noise_filters, s.keyword_rules, s.is_paused, s.capture_config, s.capture_fingerprint, s.created_at,
           t.id as target_id, t.canonical_url, t.hostname, t.origin, t.last_fetched_at, t.last_fetch_outcome,
           st.is_currently_down, st.is_noisy, st.consecutive_failures,
           (SELECT COUNT(*) FROM monitor_versions mv WHERE mv.subscription_id = s.id) as version_count,
           (SELECT MAX(mv.created_at) FROM monitor_versions mv WHERE mv.subscription_id = s.id) as last_changed_at
    FROM subscriptions s JOIN targets t ON t.id = s.target_id LEFT JOIN sub_state st ON st.subscription_id = s.id
    WHERE s.user_id = ? ORDER BY s.created_at DESC
  `).all(userId);
  res.json({ subscriptions: rows });
});

// POST /api/subscriptions
subscriptionsRouter.post('/', async (req, res) => {
  const parsed = CreateSubscriptionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.format() });
    return;
  }
  const { url, name, interval_minutes, sensitivity, capture_config, include_selectors, ignore_selectors, noise_filters, keyword_rules } = parsed.data;
  const db = getDb();
  const userId = req.user!.id;

  // 1. Quota check
  const countRow = db.prepare('SELECT COUNT(*) as count FROM subscriptions WHERE user_id = ?').get(userId) as { count: number };
  if (countRow.count >= env.MAX_SUBS_PER_USER) {
    res.status(403).json({ error: `Subscription quota exceeded (maximum ${env.MAX_SUBS_PER_USER} monitors allowed)` });
    return;
  }

  // 2. SSRF validation & canonicalization
  let canonicalInfo;
  try {
    const valResult = await validateUrl(url);
    canonicalInfo = { canonicalUrl: valResult.canonicalUrl, hostname: valResult.hostname, origin: valResult.origin };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: `Invalid URL: ${message}` });
    return;
  }

  // 3. Validate interval (15-1440 min, or dev override for demo origin)
  if (!validateInterval(interval_minutes, canonicalInfo.origin)) {
    res.status(400).json({ error: `Interval must be between 15 and 1440 minutes${env.ALLOW_LOCAL_DEMO ? ' (or dev override for demo origin)' : ''}` });
    return;
  }

  // 4. Capture config & fingerprinting
  let config, fingerprint;
  try {
    const cf = captureFingerprint(capture_config ?? {});
    config = cf.config;
    fingerprint = cf.fingerprint;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: `Invalid capture configuration: ${message}` });
    return;
  }

  const subscriptionId = crypto.randomUUID();
  const feedToken = crypto.randomBytes(24).toString('hex');
  const now = new Date().toISOString();

  db.transaction(() => {
    let target = db.prepare('SELECT id FROM targets WHERE canonical_url = ?').get(canonicalInfo.canonicalUrl) as { id: string } | undefined;
    if (!target) {
      const targetId = crypto.randomUUID();
      db.prepare('INSERT INTO targets (id, canonical_url, hostname, origin, created_at) VALUES (?, ?, ?, ?, ?)').run(targetId, canonicalInfo.canonicalUrl, canonicalInfo.hostname, canonicalInfo.origin, now);
      target = { id: targetId };
    }
    db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, target_id, name, interval_minutes, next_check_at,
        capture_config, capture_fingerprint, sensitivity,
        include_selectors, ignore_selectors, noise_filters,
        learned_ignore_patterns, keyword_rules, is_paused, feed_token, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, 0, ?, ?)
    `).run(
      subscriptionId, userId, target.id, name, interval_minutes, now,
      JSON.stringify(config), fingerprint, sensitivity,
      JSON.stringify(include_selectors), JSON.stringify(ignore_selectors),
      JSON.stringify(noise_filters), JSON.stringify(keyword_rules || []), feedToken, now
    );
    db.prepare(`
      INSERT INTO sub_state (subscription_id, consecutive_failures, is_currently_down, recent_checks_window, is_noisy)
      VALUES (?, 0, 0, '[]', 0)
    `).run(subscriptionId);
  })();

  res.status(201).json({ id: subscriptionId, target_id: canonicalInfo.canonicalUrl, name, interval_minutes, next_check_at: now, feed_token: feedToken });
});

// GET /api/subscriptions/:id
subscriptionsRouter.get('/:id', (req, res) => {
  const { id } = req.params;
  const db = getDb();
  const sub = db.prepare(`
    SELECT s.*, t.canonical_url, t.hostname, t.origin, t.last_fetched_at, t.last_fetch_outcome,
           st.is_currently_down, st.is_noisy, st.consecutive_failures, st.pending_candidate_checks,
           st.pending_candidate_hash, st.last_alert_sent_at
    FROM subscriptions s JOIN targets t ON t.id = s.target_id LEFT JOIN sub_state st ON st.subscription_id = s.id
    WHERE s.id = ? AND s.user_id = ?
  `).get(id, req.user!.id) as Record<string, unknown> | undefined;

  if (!sub) { res.status(404).json({ error: 'Subscription not found' }); return; }
  const versions = db.prepare('SELECT * FROM monitor_versions WHERE subscription_id = ? ORDER BY version_number DESC LIMIT 50').all(id);
  const events = db.prepare('SELECT * FROM change_events WHERE subscription_id = ? ORDER BY created_at DESC LIMIT 50').all(id);
  const checkRuns = db.prepare('SELECT * FROM check_runs WHERE subscription_id = ? ORDER BY started_at DESC LIMIT 50').all(id);
  res.json({ subscription: sub, versions, events, checkRuns });
});

// PATCH /api/subscriptions/:id
subscriptionsRouter.patch('/:id', (req, res) => {
  const { id } = req.params;
  const db = getDb();
  const userId = req.user!.id;
  const existing = db.prepare('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?').get(id, userId) as {
    target_id: string;
    capture_config?: string;
    capture_fingerprint?: string;
    noise_filters?: string;
  } | undefined;
  if (!existing) { res.status(404).json({ error: 'Subscription not found' }); return; }

  const parsed = UpdateSubscriptionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.format() }); return; }

  const updates = parsed.data;
  let newConfigStr = existing.capture_config;
  let newFingerprint = existing.capture_fingerprint;
  if (updates.capture_config) {
    try {
      const cf = captureFingerprint(updates.capture_config);
      newConfigStr = JSON.stringify(cf.config);
      newFingerprint = cf.fingerprint;
    } catch (err: unknown) {
      res.status(400).json({ error: `Invalid capture configuration: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
  }

  if (updates.interval_minutes !== undefined) {
    const target = db.prepare('SELECT origin FROM targets WHERE id = ?').get(existing.target_id) as { origin: string };
    if (!validateInterval(updates.interval_minutes, target.origin)) {
      res.status(400).json({ error: 'Interval must be between 15 and 1440 minutes' });
      return;
    }
  }

  let newFiltersStr: string | null = null;
  if (updates.noise_filters) {
    let current = {};
    try { current = JSON.parse(existing.noise_filters || '{}'); } catch {}
    newFiltersStr = JSON.stringify({ ...current, ...updates.noise_filters });
  }

  const newKwRules = updates.keyword_rules !== undefined ? JSON.stringify(updates.keyword_rules) : null;

  db.prepare(`
    UPDATE subscriptions
    SET name = COALESCE(?, name), interval_minutes = COALESCE(?, interval_minutes),
        sensitivity = COALESCE(?, sensitivity),
        include_selectors = COALESCE(?, include_selectors),
        ignore_selectors = COALESCE(?, ignore_selectors),
        noise_filters = COALESCE(?, noise_filters),
        keyword_rules = COALESCE(?, keyword_rules),
        is_paused = COALESCE(?, is_paused),
        capture_config = ?, capture_fingerprint = ?
    WHERE id = ? AND user_id = ?
  `).run(
    updates.name ?? null, updates.interval_minutes ?? null, updates.sensitivity ?? null,
    updates.include_selectors ? JSON.stringify(updates.include_selectors) : null,
    updates.ignore_selectors ? JSON.stringify(updates.ignore_selectors) : null,
    newFiltersStr, newKwRules,
    updates.is_paused !== undefined ? (updates.is_paused ? 1 : 0) : null,
    newConfigStr, newFingerprint, id, userId
  );

  res.json({ ok: true, id });
});

// DELETE /api/subscriptions/:id
subscriptionsRouter.delete('/:id', (req, res) => {
  const result = deleteSubscriptionCascade(req.params.id, req.user!.id);
  if (!result) { res.status(404).json({ error: 'Subscription not found' }); return; }
  res.json({ ok: true, details: result });
});
