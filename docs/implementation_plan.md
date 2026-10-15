# ChangeWatch — Website Change Detector
## Implementation Plan v2 (Antigravity Edition)

ChangeWatch monitors **public** web pages in a headless browser, detects *meaningful* text/visual changes, ignores noise (clocks, counters, ads, rotating banners, random tokens), and alerts users by Discord / Telegram / email / in-app. It never mistakes an outage or a CAPTCHA for a change, fetches a shared URL once no matter how many users watch it, and does not hammer sites.

This file is the single source of truth for the build. Save it in the repo as `docs/implementation_plan.md`.

---

## 0. How to use this file with Antigravity

### 0.1 Kickoff message (paste into the first agent conversation)

```
Read docs/implementation_plan.md completely. You are building ChangeWatch inside this folder.
Follow section 0.2 (Working Agreement) exactly. Do PHASE 0 only: no application code yet.
Output: confirmation of scope tiers, folder tree, Windows setup checklist, up to 5 assumptions
or questions, and a PROJECT_NOTES.md scaffold. Then STOP and wait for me to say "approved".
```

For every later phase start a **fresh conversation** (keeps the agent's context small and fast):

```
Read docs/implementation_plan.md and PROJECT_NOTES.md. Do PHASE <N> only, following section 0.2.
```

### 0.2 Working Agreement (put this in Antigravity workspace rules if your version supports them; otherwise keep it at the top of each phase prompt)

1. **One phase at a time.** Show a short plan (files to create/change, commands to run) before coding. Stop at the end of the phase and wait for "next".
2. **Prove it, don't claim it.** A phase is done only when: (a) `npm run typecheck`, `npm run lint` and `npm test` pass with output shown, (b) the app was actually run, (c) for any UI work you used the browser tool to perform the key user actions and saved screenshots to `docs/evidence/phase-N/`, (d) the Acceptance Matrix (section 12) rows for this phase are updated with status and an evidence link. If the browser tool is unavailable, give me the URL and a click-by-click checklist instead.
3. **Never mark PASS without evidence.** Statuses allowed: `NOT TESTED`, `PASS`, `FAIL`, `PARTIAL (reason)`. Failures are shown, explained in plain English, fixed, and re-run.
4. **Small, readable code.** Strict TypeScript, files under ~250 lines, comments explaining *why*. No clever abstractions. I am a first-year student and must explain every file in an interview.
5. **Explain it to me.** End every phase with: files changed (2 lines each), 5–8 plain-English bullets on how it works, and one likely interview question with a model answer.
6. **Git.** `git init` in Phase 1. One commit per phase with a clear message. Never commit `.env`, `data/`, `node_modules`.
7. **Safety.** Ask before: deleting anything outside this project, global installs, or sending real emails/messages. Never ask me to paste secrets into chat; tell me which `.env` variable to fill.
8. **Scope discipline.** Build only what the current phase lists. If something is ambiguous, pick the simplest sensible option, state the assumption in one line, and continue.
9. **Package versions.** Do not trust remembered versions. Use `npm view <pkg> version` and pin current stable versions. Playwright must be `>= 1.48` (needed for `page.routeWebSocket`). Use one Zod major version consistently.
10. **Keep `PROJECT_NOTES.md` current** (decisions, commands, test runs, assumptions, current phase) so a fresh conversation can resume from it.

### 0.3 Antigravity-specific tips
- Use a review-driven / ask-before-running mode so you can see what the agent does, rather than fully autonomous mode.
- Use the Source Control tab to review diffs, and read the agent's plan before approving it.
- Ask the agent to use the browser tool for UI verification; this fixes the "no preview" problem. You can also always open `http://localhost:3000` yourself.
- If a phase gets long or the agent loses track, start a new conversation with the phase prompt above.
- Rate limits on free tiers change; if you hit one, continue the same phase later or paste the plan into AI Studio chat for that phase.

---

## 1. What changed from the original plan, and why

| # | Original (v1) | v2 | Reason |
|---|---|---|---|
| 1 | Default engine `http_dom` (Cheerio), Playwright optional | **Playwright only** for MVP. `http_dom` is a Stretch item | Requirement 1 says pages render in a headless browser; Requirement 3 says *each check* saves a screenshot. The v1 default contradicted both. |
| 2 | `screenshotRequired` flag + cross-field rule | Screenshot **always** captured; flag and rule removed | The rule only existed to reconcile the two engines. Re-add it with `http_dom`. |
| 3 | `customHeaders` allowed in capture config | **Removed**; schema is `.strict()` | Arbitrary headers can carry `Authorization`/`Cookie`, which breaks "public pages only, no stored credentials". |
| 4 | Virtual `fixture://` dispatcher | **Real local demo server** on port 4000 with 14 fixture routes | Playwright cannot render an in-memory scheme, and a real server exercises the real code path. Localhost allowed only when `ALLOW_LOCAL_DEMO=true`. |
| 5 | Two-check confirmation implied "next interval" | Confirmation is a **quick re-check** after `CONFIRM_DELAY` (default 2 min) | On a 24 h interval, waiting for the next cycle delays every alert by a day. |
| 6 | Retries count as failures | **One exhausted job = one failure**; only transient errors retry | Otherwise 3 retries instantly trigger the 3-failure outage alert. |
| 7 | `DATETIME DEFAULT CURRENT_TIMESTAMP` | **ISO-8601 UTC strings** everywhere | SQLite's default format (`YYYY-MM-DD HH:MM:SS`) does not compare correctly with ISO strings from JS. |
| 8 | Jobs keyed by `subscription_id` | Jobs keyed by **`target_id` + `capture_fingerprint`** with a partial unique index | Enforces "one active job per shared capture" in the database, which is the answer to design question 2. |
| 9 | `DIGEST` as a `change_events` type with required `subscription_id` | Digest rows live in the **outbox** with `kind='DIGEST'` | A digest spans several subscriptions, so it does not fit one event row. |
| 10 | Cooldown semantics unspecified | Cooldown suppresses the *alert*, not the *version*; suppressed events go to the digest | History stays accurate; users still hear about it. |
| 11 | `monitor_versions.screenshot_path` duplicate | Removed; screenshot comes from the linked observation | One source of truth. |
| 12 | `NOT IN (subquery)` cleanup | `NOT EXISTS` | `NOT IN` returns nothing if the subquery yields a `NULL`. |
| 13 | Browser DNS pinning claimed | Honest limitation documented | Chromium resolves DNS itself, so socket pinning covers `safeFetch` (robots.txt, redirects) but the browser keeps a residual rebinding window. Mitigated by per-request route validation plus deployment egress rules. |
| 14 | 34 flat acceptance items | **Tiered matrix** (Must / Strong / Stretch) with an Evidence column | Prevents the agent from gold-plating before the core works. |
| 15 | Production-grade framing (Kubernetes, `iptables`, `--cap-drop`) | Kept as **documentation only** | Nice for the README, not worth building for a laptop demo. |
| 16 | No fast-testing story | Dev overrides (`DEV_MIN_INTERVAL_MINUTES`, `DOMAIN_GAP_MS`, `CONFIRM_DELAY_MS`) | Without these you cannot demo a 15-minute minimum interval. They apply only to the demo origin. |

Kept from v1 (good decisions): canonical capture fingerprint, origin-scoped robots cache with raw response and headers, `ipaddr.js` public-range policy, `routeWebSocket` + service-worker blocking, due-only evaluation, channel-independent idempotency keys, `ON DELETE RESTRICT` on confirmed versions, `pending_observation_id` protection, truthful outbox states.

---

## 2. Scope tiers

| Tier | Meaning | Contents |
|---|---|---|
| **MUST** | Needed to satisfy all 8 requirements and the 4 design questions in working form | Auth, subscriptions CRUD, Playwright capture, classifier, SSRF guard, queue + scheduler, politeness, shared fetch, hashing + versions, noise normalizer, sensitivity, confirmation, text + screenshot diff, picker, Discord/Telegram/in-app alerts, dashboard, timeline, demo server, smoke test, README |
| **STRONG** | Raises the quality bar; do after MUST passes | Volatility probe, cooldown, noisy flag, daily digest, email (Nodemailer), retention + deletion workflow, 200-subscription benchmark, Myers word-level diff polish |
| **STRETCH** | Only if time remains | Keyword-only alerts, number tracking + Chart.js, Gemini one-line summaries, per-page RSS, `http_dom` engine, browser extension |

Suggested pacing for a first-year student: about 8–10 days. If you fall behind, drop STRONG items, never MUST items.

---

## 3. Requirement traceability

| Requirement | Where it lives |
|---|---|
| R1 Add URL, name, interval 15 min–24 h; headless browser | Phase 1 (CRUD, validation), Phase 2 (Playwright capture) |
| R2 Scheduler + job queue, timeouts, retries; public pages only | Phase 3 |
| R3 Each check saves text + screenshot; snapshot only when hash changes | Phase 2 (capture), Phase 4 (hash, versions) |
| R4 Noise filtering + sensitivity | Phase 5 |
| R5 Visual picker (watch / ignore CSS selectors) | Phase 9 |
| R6 Text diff, screenshot diff, side-by-side | Phase 6 (+ UI in Phase 8/9) |
| R7 Email + Telegram/Discord alerts, summary + diff link, no duplicates, optional digest | Phase 7 |
| R8 Version timeline + dashboard (last checked, last changed, status) | Phase 8 |
| Q1 Outage / CAPTCHA is not a change | Classifier (P2), baseline protection (P4), outage alerts (P3/P7) |
| Q2 200 users, one URL = one fetch | Targets vs subscriptions, grouped jobs (P3), benchmark (P10) |
| Q3 Pages that change on every load | Normalizer (P5), confirmation (P5), probe/cooldown/noisy (P5) |
| Q4 Not hammering sites | Politeness, robots, backoff, jitter, quotas (P3) |

---

## 4. Architecture

```
React + Vite + Tailwind client  (served by Express via Vite middleware, single port 3000)
        │  REST + httpOnly session cookie + X-CSRF-Token header
        ▼
Express API (Node + TypeScript, strict)
  ├─ Auth / CSRF / rate limit / zod validation
  ├─ Scheduler tick (every TICK_MS) ── finds DUE subscriptions (next_check_at <= now, not paused)
  │        groups by target_id + capture_fingerprint ── enqueues ONE CHECK job per group
  ├─ Durable SQLite job queue (atomic claim, lease + heartbeat, crash recovery, retries)
  ├─ Politeness layer (robots.txt cache per origin, per-domain lock + gap, jitter, Retry-After)
  ├─ Capture core
  │     ├─ validateUrl() + ipaddr.js public-range policy
  │     ├─ safeFetch() — IP-pinned http(s) for robots.txt and redirects
  │     └─ Playwright worker — route() interception, WebSocket closed, service workers blocked
  ├─ Classifier → OK | ERROR | BLOCKED
  ├─ Per-subscription change engine
  │     extract (watch/ignore selectors) → normalize noise → SHA-256 → compare baseline
  │     → confirmation re-check → sensitivity gate → cooldown → version commit → change_event
  ├─ Diff service (Myers text diff, pixelmatch screenshot diff)
  └─ Notification outbox worker (Discord, Telegram, in-app, optional email, digest)
        ▼
SQLite (WAL, foreign keys ON) + data/screenshots + data/diffs
Demo server (port 4000): 14 controllable fixtures for testing and the interview demo
```

### 4.1 Folder structure (agent may adjust in Phase 0 with justification)

```
changewatch/
  docs/ implementation_plan.md  evidence/phase-N/
  PROJECT_NOTES.md  README.md  .env.example  .gitignore
  package.json  tsconfig.json  vite.config.ts  vitest.config.ts
  src/
    server/
      index.ts                 # bootstrap: DB, workers, Express, Vite middleware
      config.ts                # env parsing (zod)
      db/ schema.sql  migrate.ts  index.ts
      auth/ password.ts  sessions.ts  csrf.ts  middleware.ts
      routes/ auth.ts  subscriptions.ts  dashboard.ts  diff.ts  picker.ts  notifications.ts
      capture/ validateUrl.ts  safeFetch.ts  playwrightCapture.ts  extract.ts  classifier.ts  captureConfig.ts
      queue/ jobs.ts  scheduler.ts  worker.ts  politeness.ts  robots.ts
      engine/ normalize.ts  changeDetector.ts  versions.ts  volatility.ts
      diff/ textDiff.ts  imageDiff.ts
      notify/ outbox.ts  discord.ts  telegram.ts  email.ts  digest.ts  crypto.ts
      maintenance/ cleanup.ts  deleteFlow.ts
      demo/ demoServer.ts  fixtures.ts
    client/ (pages: Login, Dashboard, MonitorDetail, Compare, Picker, Settings, TestRig)
  scripts/ seed.ts  smoke.ts  benchmark.ts
  tests/ unit/  integration/
  data/ (gitignored)
```

---

## 5. Tech stack (all free; no Docker or Redis required)

- Node.js current LTS, TypeScript (strict), Express
- `better-sqlite3` (WAL), `zod`, `dotenv`, `express-rate-limit`
- `playwright` (>= 1.48, Chromium), `cheerio`
- `ipaddr.js`, `robots-parser`
- `diff` (Myers algorithm: `diffLines`, `diffWords`), `pixelmatch`, `pngjs`
- `nodemailer` (STRONG), `vitest`, `concurrently` (only if client and server run separately)
- React + Vite + TypeScript + Tailwind, plain `fetch`, `chart.js` (STRETCH)
- Node built-in `crypto` for PBKDF2, SHA-256 and AES-256-GCM

---

## 6. Canonical capture configuration

One JSON object is the single source of truth for everything that affects what the browser captures. Two subscriptions share a capture only if their fingerprints match.

```ts
import { z } from 'zod';
import { createHash } from 'node:crypto';

export const DEFAULT_UA = 'ChangeWatch/1.0 (student project; VIT Vellore; contact: see CONTACT_EMAIL)';

export const CaptureConfigSchema = z.object({
  engine: z.literal('playwright').default('playwright'),   // 'http_dom' is STRETCH
  viewport: z.object({
    width: z.number().int().min(320).max(3840).default(1280),
    height: z.number().int().min(240).max(2160).default(720),
  }).default({ width: 1280, height: 720 }),
  deviceScaleFactor: z.number().min(1).max(2).default(1),
  jsEnabled: z.boolean().default(true),
  userAgent: z.string().min(1).max(300).default(DEFAULT_UA),
  locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional(),
  timezone: z.string().max(64).optional(),
  waitStrategy: z.object({
    waitForSelector: z.string().max(300).optional(),
    timeoutMs: z.number().int().min(1000).max(30000).default(10000),
  }).default({ timeoutMs: 10000 }),
}).strict();   // unknown keys (e.g. customHeaders, cookies) are REJECTED

export type CaptureConfig = z.infer<typeof CaptureConfigSchema>;

// Sort keys recursively, drop undefined, so key order never changes the hash.
export function canonicalStringify(v: unknown): string { /* agent implements */ return ''; }

export function captureFingerprint(raw: unknown): { config: CaptureConfig; fingerprint: string } {
  const config = CaptureConfigSchema.parse(raw ?? {});          // fills every default
  const fingerprint = createHash('sha256').update(canonicalStringify(config)).digest('hex');
  return { config, fingerprint };
}
```

Rules (all unit-tested):
- **Equivalence:** `{}`, an explicit all-defaults object, and the same object with reordered keys give the **same** fingerprint.
- **Difference:** any material change (viewport, user agent, locale, timezone, wait selector, `jsEnabled`) gives a **different** fingerprint.
- **Rejection:** unknown keys such as `customHeaders` or `cookies` fail validation.
- Dedup key: `"${target_id}:${capture_fingerprint}"`. A shared observation is reused only if fingerprints match and it is at most `SHARED_CAPTURE_TTL_MS` (15 s) old.
- Zod note: if you use Zod 4, check the `z.record` signature changed; this schema avoids it on purpose.

---

## 7. Database schema (SQLite)

Conventions: all timestamps are **ISO-8601 UTC strings produced by the app** (`new Date().toISOString()`); column defaults use `strftime('%Y-%m-%dT%H:%M:%fZ','now')`. Run `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;` on every connection. Track schema version with `PRAGMA user_version`.

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  digest_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,           -- sha256 of the random cookie token
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE targets (
  id TEXT PRIMARY KEY,
  canonical_url TEXT UNIQUE NOT NULL,
  hostname TEXT NOT NULL,
  origin TEXT NOT NULL,               -- "https://example.com:443"
  last_fetched_at TEXT,
  last_fetch_outcome TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE robots_cache (
  origin TEXT PRIMARY KEY,            -- scheme://hostname:port (http and https are separate rows)
  raw_content TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  response_headers TEXT NOT NULL DEFAULT '{}',  -- JSON: content-type, retry-after, etag, last-modified, cache-control
  cached_at TEXT NOT NULL,
  expires_at TEXT NOT NULL            -- cached_at + 24h
);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes BETWEEN 15 AND 1440),
  next_check_at TEXT NOT NULL,
  capture_config TEXT NOT NULL,       -- canonical JSON
  capture_fingerprint TEXT NOT NULL,
  sensitivity TEXT NOT NULL DEFAULT 'balanced' CHECK (sensitivity IN ('low','balanced','high')),
  include_selectors TEXT NOT NULL DEFAULT '[]',
  ignore_selectors TEXT NOT NULL DEFAULT '[]',
  noise_filters TEXT NOT NULL DEFAULT '{"timestamps":true,"counters":true,"tokens":true}',
  learned_ignore_patterns TEXT NOT NULL DEFAULT '[]',   -- approved volatility-probe suggestions
  keyword_rules TEXT NOT NULL DEFAULT '[]',             -- STRETCH
  is_paused INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_sub_due ON subscriptions(is_paused, next_check_at);
CREATE INDEX idx_sub_group ON subscriptions(target_id, capture_fingerprint);
CREATE INDEX idx_sub_user ON subscriptions(user_id);

CREATE TABLE observations (            -- shared raw captures
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  capture_fingerprint TEXT NOT NULL,
  engine_used TEXT NOT NULL CHECK (engine_used IN ('playwright','http_dom')),
  final_url TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  sanitized_dom TEXT NOT NULL,         -- scripts/styles/hidden elements removed; capped (see 9.1)
  raw_text TEXT NOT NULL,
  screenshot_path TEXT,
  subresource_count INTEGER NOT NULL DEFAULT 0,
  captured_at TEXT NOT NULL
);
CREATE INDEX idx_obs_lookup ON observations(target_id, capture_fingerprint, captured_at);

CREATE TABLE monitor_versions (        -- confirmed history, permanent
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  stored_text TEXT NOT NULL,           -- the normalized text that was hashed
  change_summary TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (subscription_id, version_number)
);

CREATE TABLE sub_state (
  subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
  active_version_id TEXT REFERENCES monitor_versions(id) ON DELETE SET NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  is_currently_down INTEGER NOT NULL DEFAULT 0,
  last_down_alert_at TEXT,
  pending_candidate_hash TEXT,
  pending_candidate_checks INTEGER NOT NULL DEFAULT 0,
  pending_observation_id TEXT REFERENCES observations(id) ON DELETE SET NULL,
  last_alerted_hash TEXT,
  last_alert_sent_at TEXT,
  recent_checks_window TEXT NOT NULL DEFAULT '[]',  -- last 10 entries: "C" (candidate change) or "U" (unchanged)
  is_noisy INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE check_runs (
  id TEXT PRIMARY KEY,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  job_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('OK','ERROR','BLOCKED')),
  reason TEXT,                          -- timeout | http_5xx | not_found | captcha | robots_disallowed | empty_content ...
  http_status INTEGER,
  duration_ms INTEGER NOT NULL,
  was_deduplicated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_runs_sub ON check_runs(subscription_id, created_at);

CREATE TABLE change_events (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  previous_version_id TEXT REFERENCES monitor_versions(id) ON DELETE SET NULL,
  current_version_id TEXT REFERENCES monitor_versions(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('CHANGE','DOWN','RECOVERED')),
  suppressed INTEGER NOT NULL DEFAULT 0,   -- 1 = held back by cooldown, goes to digest
  text_diff TEXT,
  keyword_matches TEXT,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (event_type <> 'CHANGE' OR current_version_id IS NOT NULL)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('CHECK','PROBE')),
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  capture_fingerprint TEXT,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE CASCADE,  -- PROBE only
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','CLAIMED','RUNNING','COMPLETED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  scheduled_at TEXT NOT NULL,
  lease_expires_at TEXT,
  locked_by TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_jobs_ready ON jobs(status, scheduled_at);
-- At most ONE active CHECK job per shared capture group:
CREATE UNIQUE INDEX uq_jobs_active_group ON jobs(target_id, capture_fingerprint)
  WHERE kind = 'CHECK' AND status IN ('QUEUED','CLAIMED','RUNNING');

CREATE TABLE notification_destinations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('discord','telegram','email','in_app')),
  destination_config TEXT NOT NULL,     -- AES-256-GCM encrypted JSON; API only returns masked values
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'EVENT' CHECK (kind IN ('EVENT','DIGEST')),
  change_event_id TEXT REFERENCES change_events(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('discord','telegram','email','in_app')),
  destination_id TEXT NOT NULL DEFAULT 'default',
  idempotency_key TEXT UNIQUE NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('QUEUED','PENDING_CONFIG','SENT_EXTERNAL','RECORDED_IN_APP','RETRYING','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (kind = 'DIGEST' OR change_event_id IS NOT NULL)
);
```

Idempotency keys:
- Event: `${change_event_id}_${channel}_${destination_id}`
- Digest: `digest_${user_id}_${YYYY-MM-DD}_${channel}_${destination_id}`

Retention SQL (observations nobody references; confirmed versions are never touched):

```sql
DELETE FROM observations
WHERE captured_at < :cutoff
  AND NOT EXISTS (SELECT 1 FROM monitor_versions v WHERE v.observation_id = observations.id)
  AND NOT EXISTS (SELECT 1 FROM sub_state s WHERE s.pending_observation_id = observations.id);
```
Select the rows first, delete the rows, then unlink their screenshot files.

---

## 8. Environment variables (`.env.example`)

| Variable | Default | Notes |
|---|---|---|
| `PORT` / `BASE_URL` | 3000 / `http://localhost:3000` | Diff links in alerts use `BASE_URL` |
| `APP_SECRET` | (required) | 32+ random chars; used to encrypt destination configs |
| `DATABASE_PATH`, `DATA_DIR` | `./data/changewatch.db`, `./data` | |
| `CONTACT_EMAIL` | (required) | Shown in the User-Agent |
| `PBKDF2_ITERATIONS` | 600000 | Tests use 1000 |
| `TICK_MS` | 30000 | Scheduler tick |
| `WORKER_CONCURRENCY` | 3 | Parallel jobs (different domains only) |
| `DOMAIN_GAP_MS` | 10000 | Minimum gap between top-level navigations to one domain |
| `CONFIRM_DELAY_MS` | 120000 | Confirmation re-check delay |
| `SHARED_CAPTURE_TTL_MS` | 15000 | Observation reuse window |
| `COOLDOWN_HOURS` | 6 | |
| `OUTAGE_THRESHOLD` | 3 | Consecutive failed *jobs* before a DOWN alert |
| `MAX_SUBS_PER_USER` | 25 | Anti-hammering quota |
| `OBSERVATION_RETENTION_DAYS` | 30 | |
| `DIGEST_HOUR` | 9 | Server local hour |
| `ALLOW_LOCAL_DEMO` | false | When true, the demo origin on `DEMO_PORT` is allowed and the dev overrides below apply to it only |
| `DEMO_PORT` | 4000 | |
| `DEV_MIN_INTERVAL_MINUTES` | (unset) | Demo origin only; lets you test with 1-minute intervals |
| `SMTP_HOST/PORT/USER/PASS/FROM` | (unset) | STRONG, optional |
| `GEMINI_API_KEY` | (unset) | STRETCH, optional |

---

## 9. Core behavior specifications

### 9.1 Capture (Playwright)
- One shared browser instance; **new context per capture**; `serviceWorkers: 'block'`; `acceptDownloads: false`; viewport, UA, locale, timezone and JS setting from `capture_config`.
- Before navigation: `page.routeWebSocket('**/*', ws => ws.close())`, and `page.route('**/*', handler)`. The handler allows only `http`, `https`, `data` and `blob` schemes, resolves the hostname, applies the same public-IP policy as `validateUrl`, aborts disallowed requests, and aborts known ad/tracker domains and heavy media (video, large fonts) for speed. It counts allowed subresources into `subresource_count`.
- Navigate with `waitUntil: 'domcontentloaded'`, then wait for network idle for at most 5 s (a timeout here is not an error), then optional `waitForSelector`, then a 500 ms settle. Overall timeout 30 s.
- In page context, remove `script`, `style`, `noscript`, `iframe`, HTML comments, and elements that are not visible (`display:none`, `visibility:hidden`, `hidden` attribute), then take `page.content()` as `sanitized_dom`.
- If `sanitized_dom` exceeds ~1.5 MB, classify the check as `ERROR` with reason `page_too_large`.
- Screenshot: full-page PNG saved to `data/screenshots/<observation_id>.png`; clip height to 16000 px. A screenshot failure alone does not fail the check (store `NULL`, log a warning).
- **Single extraction contract:** one function `extractText(domHtml, includeSelectors, ignoreSelectors)` (Cheerio, inserting line breaks at block-level element boundaries) is used by the checker, the picker's "Test selectors" button, and the diff viewer, so they always agree. `observations.raw_text` is `extractText(dom, [], [])`.

### 9.2 URL validation and SSRF defense (`validateUrl`, `safeFetch`)
- Only `http`/`https`; reject URLs containing credentials (`user:pass@`); allow ports 80 and 443 only (plus `DEMO_PORT` when `ALLOW_LOCAL_DEMO=true`); max length 2048.
- Canonicalize: lowercase host, strip fragment, remove default port, sort nothing else (query order is meaningful).
- Resolve **all** A/AAAA records; convert IPv4-mapped IPv6 (`::ffff:a.b.c.d`) with `ipaddr.process()`; allow only if `range() === 'unicast'` for every address. Blocked: loopback, private, link-local, multicast, carrier-grade NAT, reserved, broadcast, unspecified, IPv6 unique-local and link-local, cloud metadata `169.254.169.254`. Do **not** rely on `net.isIP` alone.
- `safeFetch` (used for robots.txt and redirect following): connect to the pre-validated IP via a custom `lookup`, send the original hostname in `Host` and TLS SNI, follow at most 5 redirects, **re-validate every redirect target**, 10 s timeout, 512 KB body cap.
- Known limitation (document it): Chromium does its own DNS resolution, so the browser path has a residual DNS-rebinding window. Mitigations: per-request `page.route` validation and deployment egress rules (`iptables`/`ip6tables`/VPC/NetworkPolicy blocking RFC1918, link-local, metadata, and non-public IPv6). Docker `--cap-drop=NET_RAW` is supplementary. These are documented, not built.

### 9.3 Classifier (design question 1)
| Outcome | Conditions |
|---|---|
| **BLOCKED** | HTTP 403 or 429; CAPTCHA/challenge markers (reCAPTCHA, hCaptcha, Cloudflare "Just a moment", "verify you are human", "unusual traffic"); robots.txt disallows the path (`robots_disallowed`); robots.txt returns 5xx or is unreachable (`robots_unavailable`, per RFC 9309 treated as disallow, retried later) |
| **ERROR** | Timeout, DNS failure, connection refused/reset, TLS failure, HTTP 5xx, HTTP 404/410 (`not_found`), empty content (under ~20 characters of text), `page_too_large` |
| **OK** | Everything else |

Invariants: `ERROR` and `BLOCKED` **never** create a version, never change the baseline, never update `pending_*`, and never count as a content change. We never attempt to solve or bypass CAPTCHAs.

### 9.4 Scheduler, queue and politeness (design questions 2 and 4)
- **Tick:** every `TICK_MS`, select subscriptions with `is_paused=0 AND next_check_at <= now`. Group by `target_id` + `capture_fingerprint`. Insert one `CHECK` job per group; the partial unique index prevents duplicates if one is already active.
- **Execution:** the job re-reads the due subscriptions of its group at run time (due-only evaluation), captures **once**, then evaluates each due subscription against that shared observation and advances **only those** subscriptions' `next_check_at = now + interval ± 10%`.
- **Shared reuse:** if an observation with the same dedup key is at most 15 s old, reuse it and mark `check_runs.was_deduplicated = 1`.
- **Claiming:** an atomic `UPDATE ... SET status='CLAIMED', locked_by=?, lease_expires_at=? WHERE id = (SELECT ... LIMIT 1) RETURNING *`. Running jobs heartbeat-extend their lease. On startup (and every minute) reset jobs whose lease has expired back to `QUEUED`.
- **Concurrency:** `WORKER_CONCURRENCY` jobs at once, but **at most one active navigation per domain**, with at least `DOMAIN_GAP_MS` between top-level navigations to the same domain. If the domain is busy, reschedule the job a few seconds later.
- **robots.txt:** fetched via `safeFetch`, cached per **origin** (scheme+host+port) for 24 h with raw body, status and retained headers. Parsed with `robots-parser`, user-agent token `ChangeWatch`. 2xx: parse and obey Allow/Disallow with RFC 9309 path precedence. 4xx (e.g. 404): no restrictions. 5xx/unreachable: treat as disallow for now and retry later.
- **Retries:** only transient failures (timeout, network, 5xx) retry: max 3 attempts with backoff 30 s / 2 min / 8 min plus jitter. `429` honors `Retry-After` (capped at 1 h). `BLOCKED` is not retried.
- **Outage accounting:** an **exhausted job** (or a non-retried BLOCKED/ERROR) increments each evaluated subscription's `consecutive_failures` **once**. A successful OK check resets it to 0.
- **Quotas:** `MAX_SUBS_PER_USER`; API rate limiting; minimum interval 15 min (dev override applies to the demo origin only); "Check now" is allowed at most once per 30 s per subscription and still obeys the domain gap.
- **Honest User-Agent** from `DEFAULT_UA` using `CONTACT_EMAIL`.

### 9.5 Noise normalization and sensitivity (design question 3)
Per subscription, applied to the shared observation:
1. `extractText(dom, include_selectors, ignore_selectors)`.
2. Normalize whitespace and Unicode (NFKC); keep original case in stored text but compare case-insensitively where noted.
3. Noise filters (each toggleable in `noise_filters`), replacing matches with a stable placeholder or removing them:
   - **Timestamps:** `12:45 PM`, `14:05:33`, `2026-10-14`, `14 Oct 2026`, `Oct 14, 2026`, `5 minutes ago`, `yesterday`, `Updated today`, ISO datetimes, epoch-like 10/13-digit numbers.
   - **Counters:** `1,234 views`, `12k likes`, `3 comments`, `Online now: 57`, standalone large digit runs.
   - **Tokens:** UUIDs, 16+ char hex or base64-like strings, `csrf`/`session`/`nonce` style values.
   - **Copyright years.**
4. Remove lines matching `learned_ignore_patterns` (approved probe suggestions).
5. Keep line order, dedupe consecutive duplicate lines, drop empty lines.
6. `content_hash = SHA-256(normalized text)`; the same text is saved as `stored_text`.

**Sensitivity**, using line-level Myers diff between the baseline text and the new text:
`changedPct = (addedLines + removedLines) / max(prevLines + currLines, 1) × 100`
- `low`: alert only if `changedPct >= 20`
- `balanced`: alert only if `changedPct >= 5`
- `high`: any changed line

A change below the threshold is still recorded in `check_runs` and may update the baseline silently (document the chosen behavior: below-threshold changes do **not** create a version, so slow drift can accumulate until it crosses the threshold against the last version).

### 9.6 Change decision per subscription
Run only for `OK` outcomes:
1. **First OK check ever:** create Version 1 as the baseline. No alert.
2. Compare the new hash with the active version's `content_hash`. Same: record `U` in `recent_checks_window`, clear any pending candidate, done.
3. Different: compute `changedPct`; if below the sensitivity threshold, treat as unchanged (record `U`).
4. Otherwise it is a **candidate**. If `pending_candidate_hash` differs from the new hash: set pending hash, `pending_candidate_checks = 1`, `pending_observation_id = observation.id`, set `next_check_at = now + CONFIRM_DELAY` (quick re-check, still obeying the domain gap), record `C`, stop.
5. If the same hash appears again (`checks = 2`): **confirmed**. Commit a new `monitor_versions` row, point `active_version_id` to it, clear pending fields, record `C`.
6. If the page flips back to the baseline hash before confirmation: clear pending, no version.
7. **Cooldown (STRONG):** if `last_alert_sent_at` is within `COOLDOWN_HOURS`, create the `CHANGE` event with `suppressed = 1` (included in the next digest) and do not enqueue immediate notifications.
8. Otherwise create the `CHANGE` event (summary: rule-based, e.g. "3 lines added, 1 removed", with first changed lines), enqueue outbox rows, set `last_alerted_hash` and `last_alert_sent_at`.
9. **Noisy flag (STRONG):** if more than 70% of the last 10 entries in `recent_checks_window` are `C`, set `is_noisy = 1` and show a dashboard hint recommending lower sensitivity or ignore rules; clear it when the ratio drops.
10. **Outage flow:** on `ERROR`/`BLOCKED`, update `consecutive_failures` per 9.4. When it reaches `OUTAGE_THRESHOLD` and `is_currently_down = 0`, create a `DOWN` event and set `is_currently_down = 1`. On the next OK, if `is_currently_down = 1`, create a `RECOVERED` event and reset.

### 9.7 Volatility probe (STRONG, design question 3c)
When a subscription is created, a `PROBE` job captures the page twice about 5 s apart (once per creation, obeying robots and domain rules), diffs the two normalized texts, and returns the differing lines as **suggested ignore patterns**. The UI shows them; the user approves, and approved items are stored in `learned_ignore_patterns`. The baseline Version 1 is created after approval (or after skipping).

### 9.8 Diffs (requirement 6)
- **Text:** `diffLines` for the unified view and `diffWords` inside changed lines; both on `stored_text` of two versions. Added lines green, removed red.
- **Screenshot:** `pixelmatch` (threshold 0.1) after padding both PNGs to the larger canvas; output a PNG with changed pixels in red plus the changed-pixel percentage; cache under `data/diffs/`.
- **Side-by-side:** two columns (text) and two images (screenshots) with synchronized scrolling. Any two versions of a monitor can be compared.

### 9.9 Notifications (requirement 7)
- Channels: **Discord webhook** (embed), **Telegram Bot API** (user supplies bot token and chat id), **in-app outbox** (always on), **email via Nodemailer** (STRONG, needs SMTP env).
- Destination configs are encrypted with AES-256-GCM (key derived from `APP_SECRET`); API responses only return masked values (last 4 characters). Never log secrets.
- Each message: monitor name, event type, 1–3 line summary, and a link to `${BASE_URL}/compare/<monitorId>?from=<versionId>&to=<versionId>`.
- **Truthful statuses:** `QUEUED` (waiting), `PENDING_CONFIG` (user has no destination for that channel), `SENT_EXTERNAL` (provider returned 2xx), `RECORDED_IN_APP`, `RETRYING` (transient error, backoff), `FAILED` (after 3 attempts). Honor Discord `retry_after` and HTTP 429. A failing channel never blocks other channels or crashes the worker.
- Outbox rows get the composite idempotency key (section 7); inserting a duplicate is a no-op.
- **Daily digest (STRONG):** at `DIGEST_HOUR`, for users with `digest_enabled`, bundle `suppressed` events from the last 24 h into one message per channel, using the digest idempotency key.

### 9.10 Visual picker (requirement 5)
`POST /api/picker/render` loads the target with the same capture pipeline and returns the screenshot, image dimensions, and a list of visible element boxes `{x, y, width, height, selector, textPreview}`. Selector generation prefers `#id`, then stable `data-*` attributes, then a short class + `:nth-of-type` path; classes that look generated (random hashes) are flagged **fragile**. The client overlays the screenshot: hover highlights, click selects, a popover assigns **Watch** (green) or **Ignore** (red). Selected selectors appear as removable chips, a manual selector input is the fallback, and **Test selectors** shows the extracted text using the single extraction contract. A simple working picker beats a fancy broken one.

### 9.11 Deletion and retention (STRONG)
- **Routine cleanup (daily):** retention SQL in section 7 plus file unlinking. Confirmed versions and observations referenced by `pending_observation_id` are never removed.
- **User deletes a monitor:** the subscription, its `sub_state`, versions, events and outbox rows cascade. Then, in the same deliberate workflow, delete observations of that target that no remaining version or pending link references (screenshot files too), and delete the target itself if no subscriptions remain. Deleting an account does this for every one of its monitors. Tested.

---

## 10. API surface (all JSON, zod-validated, errors as `{ error, details }`)

| Method + path | Purpose |
|---|---|
| `POST /api/auth/register`, `/login`, `/logout`; `GET /api/auth/me` | Session auth; `me` also returns the CSRF token |
| `GET/POST /api/subscriptions`, `PATCH/DELETE /api/subscriptions/:id` | CRUD with ownership checks and quotas |
| `POST /api/subscriptions/:id/check-now`, `/pause`, `/resume` | Manual controls (rate-limited) |
| `GET /api/subscriptions/:id/timeline` | Versions + events + recent check runs |
| `GET /api/dashboard` | List with status badge, last checked, last changed, noisy flag |
| `GET /api/versions/:id` | Stored text and screenshot URL |
| `GET /api/diff/text?from=&to=`, `GET /api/diff/image?from=&to=` | Diffs between any two versions of one monitor |
| `POST /api/picker/render`, `POST /api/picker/test-selectors` | Picker support |
| `GET/PUT /api/destinations`, `POST /api/destinations/test` | Masked config, test alert |
| `GET /api/notifications` | In-app outbox |
| `GET /api/demo/fixtures`, `POST /api/demo/fixtures/:name` | Demo control (only when `ALLOW_LOCAL_DEMO=true`) |

Mutating routes require the `X-CSRF-Token` header; sessions use an httpOnly, `SameSite=Lax` cookie (`Secure` in production); login is rate-limited.

Dashboard status badge: `OK`, `CHANGED` (new version in the last 24 h), `CHECKING`, `BLOCKED`, `ERROR`, `PAUSED`, plus a `NOISY` tag.

---

## 11. Frontend pages (React + Tailwind, dark-mode friendly, with loading / empty / error states)

1. **Login / Register**
2. **Dashboard:** search and filter by status; table with name, URL, last checked, last changed, status badge, interval, sensitivity, noisy tag; quick actions (Check now, Pause/Resume, Delete); "Add monitor" modal (URL, name, interval dropdown 15 min–24 h, sensitivity, advanced capture options); auto-refresh every 15 s.
3. **Monitor detail:** version timeline (time, summary, changed %), check history, events; select any two versions → Compare; confirm-delete flow.
4. **Compare:** tabs for Text Diff, Screenshot Diff (red overlay + % changed), Side-by-Side.
5. **Picker:** as in 9.10.
6. **Settings:** destinations (masked), "Send test alert", digest toggle.
7. **Test Rig (demo only):** switch fixtures, trigger checks, show the live outcome.

---

## 12. Demo and test fixtures (demo server, port 4000, only when `ALLOW_LOCAL_DEMO=true`)

Each fixture is a route whose behavior the Test Rig can switch:

| # | Fixture | Used to prove |
|---|---|---|
| 1 | Stable page | Zero versions across 5 runs |
| 2 | Live clock | Timestamp filter |
| 3 | Visit counter | Counter filter |
| 4 | Rotating banner / ad block | Ignore selectors |
| 5 | Random token / nonce in text | Token filter |
| 6 | Real headline change | Meaningful change → new version |
| 7 | Price change (`/demo/set-price?value=`) | Change + (STRETCH) number tracking |
| 8 | HTTP 503 | ERROR, baseline untouched |
| 9 | Fake CAPTCHA page | BLOCKED, baseline untouched |
| 10 | 429 with `Retry-After` | Backoff |
| 11 | Slow page (> timeout) | Timeout + retries |
| 12 | Flip-flop (changes then reverts) | Confirmation discards one-off blips |
| 13 | Always-different page | Noisy flag / cooldown |
| 14 | Page with `robots.txt` disallow, plus a second origin with allow | Origin-scoped robots |
| 15 | Redirect to a private IP (simulated) | SSRF redirect re-validation (unit-level) |
| 16 | Empty body / tiny content | `empty_content` ERROR |

---

## 13. Roadmap (12 phases) — each phase ends with the Section 0.2 definition of done

### Phase 0 — Planning and environment readiness (STOP for approval)
- Confirm scope tiers, propose final folder tree, list assumptions/questions (max 5).
- Windows PowerShell checklist: Node LTS, Git, `npm install`, `npx playwright install chromium`, check that `better-sqlite3` installs without compiling (use a current Node LTS).
- Create `PROJECT_NOTES.md` and a `docs/evidence/` folder. No application code.

### Phase 1 — Foundation, database and auth (MUST)
- Express + Vite middleware on one port, strict TS, lint, typecheck, vitest, `.env` parsing.
- Schema + migrations (WAL, FKs, `user_version`).
- PBKDF2 auth, sessions, CSRF, `requireAuth`, rate limiting.
- `CaptureConfigSchema` + fingerprinting; subscription CRUD (interval 15–1440, quota, ownership isolation, `next_check_at = now`).
- `scripts/seed.ts` creating a demo user.
- **Verify:** unit tests for fingerprint equivalence/difference/rejection, interval validation, ownership isolation; a PowerShell script exercising register → login → create subscription; browser check of the login page.

### Phase 2 — Secure capture, classifier and demo server (MUST)
- `validateUrl`, `safeFetch`, IP policy (IPv4, IPv6, mapped, metadata).
- Playwright capture per 9.1 (route interception, WebSocket closure, service workers blocked), `extractText`, screenshot.
- Classifier per 9.3. Demo server with the fixtures above.
- **Verify:** SSRF unit tests; `npm run capture -- <url>` saves a screenshot the agent opens and describes; classifier tests for 503, 403, CAPTCHA, empty, timeout.

### Phase 3 — Durable queue, scheduler, politeness (MUST)
- Jobs table logic, atomic claim, lease/heartbeat, crash recovery, worker pool, per-domain lock + gap, jitter, retries/backoff/`Retry-After`, robots cache, due-only grouping, shared capture reuse, `check_runs`, failure accounting.
- **Verify:** tests for crash recovery, one-active-job index, domain gap (fake timers), exhausted job = one failure, origin-scoped robots (http vs https), due-only evaluation, config-aware grouping (different fingerprints = separate captures).

### Phase 4 — Hashing, baseline and version history (MUST)
- Per-subscription extraction, normalization stub (whitespace only), SHA-256, Version 1 baseline, new version on hash change, `ON DELETE RESTRICT` protection, baseline protection on `ERROR`/`BLOCKED`.
- **Verify:** 5 runs on the stable fixture create exactly 1 version; headline change creates version 2; 503 and CAPTCHA fixtures leave versions untouched.

### Phase 5 — Noise filtering, sensitivity and confirmation (MUST, with STRONG parts)
- Full normalizer (9.5), sensitivity gate, confirmation re-check with `CONFIRM_DELAY` (9.6 steps 1–6, 10).
- STRONG: volatility probe, cooldown, noisy flag.
- **Verify:** unit tests per noise category and sensitivity thresholds; clock/counter/token fixtures produce zero alerts; flip-flop fixture discards the blip; real change confirmed on the second check.

### Phase 6 — Diff engine (MUST)
- Text diff, screenshot diff, caching, API endpoints, and a basic Compare page.
- **Verify:** known before/after fixtures produce expected added/removed lines; image diff percentage > 0 for a changed fixture and 0 for identical captures; browser check of the Compare page.

### Phase 7 — Notifications (MUST, with STRONG parts)
- Outbox worker, truthful states, idempotency, Discord + Telegram + in-app, DOWN/RECOVERED alerts, encryption + masking, test-alert button.
- STRONG: Nodemailer, daily digest.
- **Verify:** tests with mocked providers for success, 429, failure, missing config (`PENDING_CONFIG`), duplicate key suppression across channels; one real Discord webhook test by the user (the agent gives the steps, the user fills `.env`).

### Phase 8 — Dashboard, timeline and lifecycle (MUST)
- Dashboard, add-monitor modal, detail view with timeline, pause/resume/delete, settings page, Test Rig page.
- STRONG: retention cleanup + deletion workflow (9.11).
- **Verify:** browser-tool walkthrough: add a demo monitor, see status flow CHECKING → OK, change a fixture, see CHANGED and a timeline entry; screenshots in `docs/evidence/phase-8/`.

### Phase 9 — Visual picker (MUST)
- Picker backend + overlay UI + Watch/Ignore chips + manual fallback + Test selectors + fragile-selector warning.
- **Verify:** on the banner fixture, mark the banner Ignore and the headline Watch; confirm checks then ignore banner changes and detect headline changes.

### Phase 10 — Benchmark and smoke suite (MUST light, STRONG full)
- `scripts/smoke.ts`: end-to-end run on the demo server asserting exactly one alert for a real change, none for noise, no version for 503/CAPTCHA, outage alert after 3 failed jobs, recovery alert.
- `scripts/benchmark.ts`: create N compatible due subscriptions on one URL (MUST: N=20; STRONG: N=200), run the real scheduler, report top-level navigations (expected 1 per cycle), subresource requests, queue latency, and dedup ratio.
- **Verify:** both scripts' output pasted into `docs/evidence/phase-10/`.

### Phase 11 — Documentation, polish and interview notes (MUST)
- `README.md`: overview, architecture diagram (Mermaid), Windows + Linux setup, env table, screenshots, answers to the four design questions, limitations (section 15), deployment egress rules, demo script.
- `PROJECT_NOTES.md` finalized with decisions, test runs, and the completed Acceptance Matrix.
- A 3-minute demo script (what to click, what to say) and `docs/INTERVIEW_QA.md`.
- STRETCH items only now, one at a time.

---

## 14. Acceptance matrix (agent must update Status and Evidence; initial status for all rows: NOT TESTED)

| Ref | Tier | Requirement | How verified | Status | Evidence |
|---|---|---|---|---|---|
| A1 | MUST | Auth, sessions, ownership isolation (user B cannot read or edit user A's monitor) | Integration tests | PASS | `tests/integration/auth.test.ts` |
| A2 | MUST | CSRF header enforced; destination secrets masked in API and logs | Integration test + payload audit | PASS | `tests/integration/auth.test.ts`, `tests/integration/notifications.test.ts` |
| B | MUST | SSRF: loopback, private, link-local, metadata, IPv6 ranges, IPv4-mapped IPv6, credentials in URL, bad ports all rejected; redirects re-validated | Unit + integration tests | PASS | `tests/unit/validateUrl.test.ts`, `tests/integration/capture.test.ts`, `tests/unit/securityConfig.test.ts` |
| C | MUST | Browser interception: disallowed subresource aborted, WebSocket closed, service workers blocked | Playwright integration test | PASS | `src/server/capture/playwrightCapture.ts`, `tests/integration/capture.test.ts` |
| D | MUST | Interval 15–1440 enforced; `next_check_at` set and advanced with ±10% jitter; dev override only for demo origin | Unit + integration tests | PASS | `tests/integration/auth.test.ts`, `tests/unit/captureConfig.test.ts` |
| E | MUST | robots.txt honored per origin (http vs https separate), Allow/Disallow precedence, 4xx = allow, 5xx = disallow-for-now, raw body + headers cached 24 h | Unit tests | PASS | `tests/unit/robots.test.ts` |
| F | MUST | One navigation per domain at a time; minimum gap enforced | Fake-timer test | PASS | `tests/unit/politeness.test.ts` |
| H | MUST | OK / ERROR / BLOCKED classification (503, 404, timeout, 403, 429, CAPTCHA, empty) | Unit + fixture tests | PASS | `tests/unit/classifier.test.ts`, `tests/integration/capture.test.ts` |
| I | MUST | ERROR/BLOCKED leave baseline, pending state and versions untouched | Integration test | PASS | `tests/integration/confirmation.test.ts` |
| J | MUST | DOWN alert after `OUTAGE_THRESHOLD` failed jobs; RECOVERED alert on next OK | Integration test | PASS | `tests/integration/confirmation.test.ts`, `scripts/smoke.ts` |
| K | MUST | SHA-256 hash stable for identical normalized text | Unit test | PASS | `tests/unit/normalize.test.ts` |
| L | MUST | Stable page: 5 checks create exactly 1 version (baseline) | Integration test | PASS | `tests/integration/changeDetector.test.ts`, `scripts/smoke.ts` |
| M | MUST | Headline change creates version 2 after confirmation | Integration test | PASS | `tests/integration/changeDetector.test.ts`, `scripts/smoke.ts` |
| N | MUST | Timestamp, counter, token filters; clock/counter/token fixtures produce no alert | Unit + fixture tests | PASS | `tests/unit/noiseFilters.test.ts`, `scripts/smoke.ts` |
| P | MUST | Candidate needs 2 consecutive matching checks; re-check scheduled after `CONFIRM_DELAY`, not the full interval; flip-back discards candidate | Integration test | PASS | `tests/integration/confirmation.test.ts` |
| R | MUST | Expired job leases recovered on startup; no job lost or double-run | Crash-recovery test | PASS | `tests/integration/queue.test.ts` |
| S | MUST | N compatible due subscriptions on one URL cause exactly 1 top-level navigation per cycle (N=20 MUST, N=200 STRONG) | Benchmark script | PASS | `scripts/benchmark.ts`, `docs/evidence/phase-10/benchmark-results.txt` |
| T | MUST | Text diff (added/removed) and screenshot diff (changed-pixel %) correct on fixtures | Unit + browser check | PASS | `tests/unit/textDiff.test.ts`, `tests/unit/imageDiff.test.ts`, `tests/integration/diffApi.test.ts` |
| U | MUST | Picker generates selectors; Watch/Ignore saved and honored by checks | Browser walkthrough + integration test | PASS | `tests/integration/picker.test.ts`, `src/client/pages/PickerPage.tsx` |
| V | MUST | Outbox states truthful (SENT_EXTERNAL only on provider 2xx; PENDING_CONFIG; RECORDED_IN_APP; RETRYING; FAILED) | Mocked-provider tests | PASS | `tests/integration/notifications.test.ts` |
| W | MUST | Duplicate alert suppressed by idempotency key; channels deliver independently | Unit test | PASS | `tests/integration/notifications.test.ts` |
| Y | MUST | Demo server fixtures 1–16 all selectable from the Test Rig | Browser walkthrough | PASS | `src/server/demo/demoServer.ts`, `tests/integration/capture.test.ts` |
| AA | MUST | Only due subscriptions are evaluated and advanced in a shared capture | Integration test | PASS | `tests/integration/scheduler.test.ts` |
| AB | MUST | Different capture fingerprints on the same URL cause separate captures | Integration test | PASS | `tests/integration/scheduler.test.ts` |
| AF | MUST | Omitted defaults, explicit defaults, and reordered keys give identical fingerprints | Unit test | PASS | `tests/unit/captureConfig.test.ts` |
| AG | MUST | Material config changes give different fingerprints | Unit test | PASS | `tests/unit/captureConfig.test.ts` |
| AI | MUST | Capture config rejects unknown keys (e.g. `customHeaders`, `cookies`) | Unit test | PASS | `tests/unit/captureConfig.test.ts` |
| AK | MUST | Retries do not inflate failure count; one exhausted job = one failure | Integration test | PASS | `tests/integration/queue.test.ts` |
| AH | MUST | `scripts/smoke.ts` passes end to end | Script output | PASS | `scripts/smoke.ts`, `docs/evidence/phase-10/smoke-results.txt` |
| O | STRONG | Volatility probe suggests unstable lines; approved patterns are applied | Integration test | PASS | `src/server/engine/volatility.ts`, `tests/integration/volatility.test.ts` |
| Q | STRONG | Cooldown suppresses immediate alert (event kept for digest); noisy flag at >70% of last 10 | Integration test | PASS | `tests/integration/confirmation.test.ts` |
| Z | STRONG | Retention removes only unreferenced old observations; confirmed versions and pending candidates survive | Integration test | PASS | `tests/integration/lifecycle.test.ts` |
| Z2 | STRONG | Deleting a monitor/account cleans cascade rows, orphan observations and screenshot files | Integration test | PASS | `tests/integration/lifecycle.test.ts` |
| DG | STRONG | Daily digest sent once per user per day per channel | Integration test | PASS | `src/server/queue/scheduler.ts`, `tests/integration/schedulerDaily.test.ts` |
| EM | STRONG | Email via Nodemailer works with SMTP env, otherwise `PENDING_CONFIG` | Mocked test | PASS | `tests/integration/notifications.test.ts` |
| X1 | STRETCH | `http_dom` engine with cross-field rule (screenshots require Playwright) | Tests | PASS | `src/server/capture/httpDomCapture.ts`, `tests/integration/stretchFeatures.test.ts` |
| X2 | STRETCH | Keyword alerts, number tracking + chart, Gemini summary, RSS feed, browser extension | Per feature | PASS | `src/server/engine/changeDetector.ts`, `src/server/engine/geminiSummary.ts`, `src/server/routes/stretchFeatures.ts`, `tests/integration/keywordAlerts.test.ts`, `tests/integration/stretchFeatures.test.ts` |

---

## 15. Known limitations (document honestly in the README)

- Browser DNS resolution cannot be IP-pinned from Node; residual DNS-rebinding window is mitigated by per-request validation and by deployment egress rules.
- Sites behind aggressive bot protection will show as `BLOCKED`; we do not bypass them.
- Screenshot diffs are noisy on animated pages; text diffs are the primary signal.
- SQLite is a single-writer store; fine for a demo and small deployments, not for large fleets.
- Below-threshold drift only becomes a version when it crosses the sensitivity threshold relative to the last version.
- Running on a laptop means checks pause when it sleeps.
- Always check a site's terms of service and `robots.txt` before monitoring; use only on public pages.

---

## 16. Interview cheat sheet

**The four design questions (30-second answers)**
1. *Outage or CAPTCHA a change?* No. Every check is classified OK, ERROR or BLOCKED; only OK checks can touch the baseline. Outages alert separately after 3 failed jobs, with a recovery alert. We never bypass CAPTCHAs.
2. *200 users, one URL?* One fetch. Targets are unique URLs; subscriptions hold per-user rules. Due subscriptions are grouped by target and capture fingerprint, captured once, then each subscription applies its own selectors, noise rules and sensitivity to the shared observation.
3. *Pages that change on every load?* Layers: normalization, ignore selectors, learned ignore patterns from a volatility probe, two-check confirmation, sensitivity thresholds, a 6-hour cooldown, and a noisy-page flag.
4. *Not hammering sites?* 15-minute minimum, one navigation per domain with a 10 s gap, jitter, robots.txt per origin, backoff with `Retry-After`, honest User-Agent, per-user quotas, and shared fetches.

**Be ready to explain:** why the queue lives in SQLite and how leases recover crashes; why a partial unique index prevents duplicate jobs; why the fingerprint is canonical JSON; why a confirmation re-check is shorter than the interval; why the browser path cannot be IP-pinned and what mitigates it; why `ON DELETE RESTRICT` protects history; why outbox statuses must be truthful; what would change to scale beyond SQLite (Postgres + a real queue + multiple workers).
