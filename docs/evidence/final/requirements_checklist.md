# ChangeWatch — Requirements Checklist (Full Audit)

Generated from `docs/implementation_plan.md` Section 14 & Specification.

## MUST Tier Requirements

| ID | Category | Requirement Description | Verification Method |
|---|---|---|---|
| **A1** | Security / Auth | User authentication, sessions with PBKDF2 hashing, and strict ownership isolation (User B cannot read/edit User A monitors). | Integration test (`tests/integration/auth.test.ts`) |
| **A2** | Security / CSRF | CSRF header enforced on state-changing requests; destination secrets masked in API responses and logs. | Integration test + payload audit (`tests/integration/auth.test.ts`) |
| **B** | Security / SSRF | Strict URL & IP validation: reject loopback, private, link-local, AWS/GCP metadata (`169.254.169.254`), IPv6/IPv4-mapped, credentials, bad ports; re-validate on redirects. | Unit + integration tests (`tests/unit/validateUrl.test.ts`, `tests/integration/capture.test.ts`) |
| **C** | Browser / Egress | Playwright route interception: abort disallowed subresources, close WebSockets, block service workers. | Integration test (`tests/integration/capture.test.ts`) |
| **D** | Scheduler / Interval | Enforce check interval 15–1440 minutes; advance `next_check_at` with ±10% jitter; dev override restricted to demo origin. | Unit + integration tests (`tests/integration/auth.test.ts`, `tests/unit/captureConfig.test.ts`) |
| **E** | Politeness / Robots | Honor `robots.txt` per origin (http vs https separate); respect Allow/Disallow precedence; 4xx = allow, 5xx = temporary disallow; cache responses. | Unit tests (`tests/unit/robots.test.ts`) |
| **F** | Politeness / Rate | Domain rate limiting: one navigation per domain at a time; enforce minimum gap (`DOMAIN_GAP_MS`). | Fake-timer unit tests (`tests/unit/politeness.test.ts`) |
| **H** | Classifier | Strict check outcome classification: OK (200), ERROR (503, 404, timeout, empty), BLOCKED (403, 429, CAPTCHA). | Unit + fixture tests (`tests/unit/classifier.test.ts`, `tests/integration/capture.test.ts`) |
| **I** | Classifier / Baseline | ERROR and BLOCKED checks leave baseline, pending candidate state, and confirmed versions completely untouched. | Integration test (`tests/integration/confirmation.test.ts`) |
| **J** | Outage Flow | Trigger DOWN alert after `OUTAGE_THRESHOLD` consecutive failed jobs; trigger RECOVERED alert on subsequent OK. | Integration test (`tests/integration/confirmation.test.ts`, `scripts/smoke.ts`) |
| **K** | Engine / Normalization | Deterministic SHA-256 content hashing stable for identical normalized text across checks. | Unit test (`tests/unit/normalize.test.ts`) |
| **L** | Engine / Baseline | Stable page produces exactly 1 baseline version across repeated checks with 0 false alerts. | Integration test (`tests/integration/changeDetector.test.ts`, `scripts/smoke.ts`) |
| **M** | Engine / Versions | Confirmed content change creates Version 2 with associated text and visual diffs. | Integration test (`tests/integration/changeDetector.test.ts`, `scripts/smoke.ts`) |
| **N** | Engine / Noise | Deterministic noise filters (timestamps, visit counters, auth tokens) suppress volatile dynamic page fragments. | Unit + fixture tests (`tests/unit/noiseFilters.test.ts`, `scripts/smoke.ts`) |
| **P** | Confirmation Gate | Two-check confirmation: new candidate hash requires 2 consecutive matching checks; short `CONFIRM_DELAY`; flip-back discards candidate. | Integration test (`tests/integration/confirmation.test.ts`) |
| **R** | Queue / Leases | Durable SQLite queue with lease recovery; expired leases reclaimed on startup; zero lost or duplicate jobs. | Crash-recovery test (`tests/integration/queue.test.ts`) |
| **S** | Scalability / Grouping | Shared fetch: $N$ compatible due subscriptions on the same URL generate exactly 1 browser fetch per cycle ($N=20$ MUST, $N=200$ STRONG). | Benchmark script (`scripts/benchmark.ts`) |
| **T** | Diff Engine | Unified Myers text diff (line + inline words) and pixelmatch screenshot visual diff with bounding box calculations. | Unit + API tests (`tests/unit/textDiff.test.ts`, `tests/unit/imageDiff.test.ts`, `tests/integration/diffApi.test.ts`) |
| **U** | Visual Picker | Visual element picker extracts CSS selectors for include/ignore chips; honored across checks. | Integration test (`tests/integration/picker.test.ts`, `src/client/pages/PickerPage.tsx`) |
| **V** | Notifications / Outbox | Truthful outbox states: `SENT_EXTERNAL` only on 2xx provider response; `PENDING_CONFIG`, `RECORDED_IN_APP`, `RETRYING`, `FAILED`. | Mocked-provider tests (`tests/integration/notifications.test.ts`) |
| **W** | Notifications / Dedup | Composite idempotency key suppresses duplicate alerts; independent multi-channel delivery (Discord, Telegram, Email). | Unit test (`tests/integration/notifications.test.ts`) |
| **Y** | Test Rig | Demo server provides 16 reproducible edge-case fixtures selectable from the Test Rig page. | Browser walkthrough + API test (`src/server/demo/demoServer.ts`, `tests/integration/capture.test.ts`) |
| **AA** | Queue / Due Filter | Shared fetch evaluates and advances `next_check_at` ONLY for subscriptions currently due (`next_check_at <= now`). | Integration test (`tests/integration/scheduler.test.ts`) |
| **AB** | Capture Config Dedup | Differing capture configurations (viewport, user agent, locale) on the same URL produce separate capture jobs. | Integration test (`tests/integration/scheduler.test.ts`) |
| **AF** | Fingerprint Canonical | Omitted defaults, explicit defaults, and reordered configuration keys produce identical SHA-256 fingerprints. | Unit test (`tests/unit/captureConfig.test.ts`) |
| **AG** | Fingerprint Material | Material configuration modifications produce distinct SHA-256 fingerprints. | Unit test (`tests/unit/captureConfig.test.ts`) |
| **AI** | Capture Config Safety | Zod capture configuration schema rejects unknown parameters (e.g. `cookies`, `customHeaders`). | Unit test (`tests/unit/captureConfig.test.ts`) |
| **AK** | Queue / Failure Count | Job retries do not inflate subscription failure count; exactly one exhausted job equals one failure. | Integration test (`tests/integration/queue.test.ts`) |
| **AH** | E2E Smoke Suite | Comprehensive end-to-end smoke test script passes all criteria on live demo server. | Smoke script execution (`scripts/smoke.ts`) |

---

## STRONG Tier Requirements

| ID | Category | Requirement Description | Verification Method |
|---|---|---|---|
| **O** | Volatility Probe | Automated volatility probe detects unstable lines on volatile fixtures and generates suggested ignore patterns. | Integration test (`src/server/engine/volatility.ts`, `tests/integration/volatility.test.ts`) |
| **Q** | Cooldown & Noise Flag | 6-hour alert cooldown suppresses immediate duplicate alerts while retaining events for digest; $>70\%$ candidate rate flags page as noisy. | Integration test (`tests/integration/confirmation.test.ts`) |
| **Z** | Retention Cleanup | Automated retention pruner purges unreferenced observations older than retention window (`OBSERVATION_RETENTION_DAYS`). | Integration test (`tests/integration/lifecycle.test.ts`) |
| **Z2** | Cascading Delete | Deleting a subscription cleanly cascades database records and removes orphan screenshot files from disk. | Integration test (`tests/integration/lifecycle.test.ts`) |
| **DG** | Daily Digest | Bundles change events into a single daily digest dispatched at `DIGEST_HOUR` once per user per channel. | Integration test (`src/server/queue/scheduler.ts`, `tests/integration/schedulerDaily.test.ts`) |
| **EM** | Email Notifications | Nodemailer SMTP integration sends email alerts when configured; enters `PENDING_CONFIG` when credentials missing. | Integration test (`tests/integration/notifications.test.ts`) |

---

## STRETCH Tier Requirements

| ID | Category | Requirement Description | Verification Method |
|---|---|---|---|
| **X1** | Alternative Engine | Lightweight Cheerio-based `http_dom` capture engine with IP-pinned `safeFetch` and cross-field validation. | Unit + integration tests (`src/server/capture/httpDomCapture.ts`, `tests/integration/stretchFeatures.test.ts`) |
| **X2.1** | Keyword Alerts | Target-specific `must_include` and `must_exclude` keyword alert rules with diff suppression and matching persistence. | Integration test (`tests/integration/keywordAlerts.test.ts`) |
| **X2.2** | Numeric Tracking | Extracts numerical metrics across version history and exposes Chart.js history API. | Integration test (`src/server/routes/stretchFeatures.ts`, `tests/integration/stretchFeatures.test.ts`) |
| **X2.3** | RSS Feed | Per-subscription RSS 2.0 XML change feed with privacy protection and direct comparison links. | Integration test (`src/server/routes/stretchFeatures.ts`, `tests/integration/stretchFeatures.test.ts`) |
| **X2.4** | Gemini AI Summaries | Optional GenAI summary of diff changes using Gemini API with deterministic rule-based fallback. | Integration test (`src/server/engine/geminiSummary.ts`, `tests/integration/stretchFeatures.test.ts`) |
| **X2.5** | Browser Extension | Manifest V3 companion browser extension for quick 1-click subscription adding. | Verification or documented constraint/status (`docs/evidence/final/`) |
