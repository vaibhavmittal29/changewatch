# ChangeWatch — Baseline Defect List & Security Audit (Phase 0)

Date: 2026-10-15
Auditor: Senior Full-Stack, AppSec & QA Engineer

---

## 1. Confirmed Bugs & Security Risks

### D-01: Iframe Navigations Counted as Top-Level Navigations (Phase 1)
- **Severity:** High (Measurement Accuracy / Specification Non-Compliance)
- **Location:** `src/server/capture/playwrightCapture.ts` line 135
- **Description:** Route listener checks `req.isNavigationRequest() && resType === 'document'` to increment `topLevelNavigations`. Any iframe on the page loading a child document increments the top-level navigation counter.
- **Remediation:** Add condition `req.frame() === page.mainFrame()` to count strictly top-level window navigations.

### D-02: Fallback in Benchmark Script Masks Failures (Phase 1)
- **Severity:** Medium (QA Gate Integrity)
- **Location:** `scripts/benchmark.ts`
- **Description:** A fallback or soft default (`obsRows[0]?.top_level_navigations || 1`) could convert a measured 0 or missing value into 1, masking capture failures as false passes.
- **Remediation:** Validate that benchmark observation rows strictly exist, `top_level_navigations` is a non-null positive integer, and assert consistency without defaulting.

### D-03: Ambiguous SSRF Verification (Timeout vs Deterministic Block) (Phase 2)
- **Severity:** High (AppSec Vulnerability Assessment)
- **Location:** `scripts/smoke.ts` and `src/server/demo/demoServer.ts`
- **Description:** In `smoke.ts`, `net::ERR_CONNECTION_TIMED_OUT` on `169.254.169.254` was accepted as a pass. A network timeout does not prove deterministic security interception—if the route were not intercepted, an unreachable link-local address would also time out.
- **Remediation:** Create a controlled test fixture redirecting to a prohibited internal destination and prove deterministic rejection (`ERR_BLOCKED_BY_CLIENT` or security error). Distinguish explicit SSRF aborts from generic timeouts or unreachable network routes.

### D-04: Silent Missing Screenshot in `http_dom` Engine (Phase 3)
- **Severity:** Medium (Specification Inconsistency)
- **Location:** `src/server/capture/captureConfig.ts` and `src/server/capture/httpDomCapture.ts`
- **Description:** When `engine: 'http_dom'` is selected, the capture silently returns `screenshotPath: null` even if screenshots are requested or expected. There is no cross-field schema validation rejecting incompatible combinations.
- **Remediation:** Implement cross-field validation in Zod schema and API: either explicitly disallow screenshot capture requests when `engine: 'http_dom'`, or clearly return a 400 error.

### D-05: Scheduler Timezone Drift & Tightly Coupled Wall-Clock (Phase 4)
- **Severity:** Medium (Operational Reliability)
- **Location:** `src/server/queue/scheduler.ts`
- **Description:** `scheduler.ts` uses raw `new Date().getUTCHours()` and `new Date().toISOString().slice(0, 10)` without clock injection. Tests cannot reliably verify date rollovers, DST shifts, or simulate daily task runs without waiting or altering system clocks.
- **Remediation:** Refactor `Scheduler` to accept an injectable clock interface (`clock: () => Date`), establish an explicit UTC/configured timezone policy, and guard against duplicate runs across clock ticks.

### D-06: RSS Endpoint Token Privacy & Enumeration (Phase 9)
- **Severity:** High (Data Privacy / Insecure Direct Object Reference)
- **Location:** `src/server/routes/stretchFeatures.ts`
- **Description:** `/api/subscriptions/:id/rss` allows public access to subscription change history using the raw subscription UUID, with no authentication or feed token. If an ID is known or shared, anyone can read change summaries.
- **Remediation:** Implement revocable, high-entropy feed tokens (`feed_token`) with rotation capabilities; require the token to access the RSS feed; ensure feed output strips private target credentials or confidential monitor parameters.

### D-07: Client UI Missing Dedicated Visual Chart for Numeric History (Phase 6)
- **Severity:** Medium (UI / Feature Completeness)
- **Location:** `src/client/pages/MonitorDetailModal.tsx`
- **Description:** While `/api/subscriptions/:id/numeric-history` exists in the backend, the client does not render an interactive visual trend chart (Chart.js / Canvas) with tooltips, timestamps, and responsive states.
- **Remediation:** Implement a clean, responsive client-side chart component visualizing numeric metrics over time with loading, empty, and error states.

### D-08: Gemini Summary Calling Pipeline Integration (Phase 7)
- **Severity:** Low (Feature Integration)
- **Location:** `src/server/engine/changeDetector.ts`
- **Description:** `geminiSummary.ts` exists as a helper function but was not wired directly into the main change detection worker flow.
- **Remediation:** Call `generateChangeSummary` during confirmed `CHANGE` events, prompt-injection sanitize inputs, ensure local rule-based fallback on missing key or timeout, and preserve notification dispatch integrity.

---

## 2. Phase A-D Remediation Log (All Confirmed & Resolved)

| ID | Finding / Requirement | Location | Status | Resolution |
|---|---|---|---|---|
| **CW-CON-01** | Destination config key mismatch | `Settings.tsx` & `notifications.ts` | **RESOLVED** | Aligned frontend/backend on `{ channel, config, enabled }`, unified `toEmail`, added strict zod schema and secret masking defense. |
| **CW-CON-02** | Invalid active job status in dashboard query | `dashboard.ts` | **RESOLVED** | Centralized `ACTIVE_JOB_STATUSES = ['QUEUED', 'CLAIMED', 'RUNNING']` in shared constants and updated query. |
| **CW-CON-03** | Baseline version marked as CHANGED | `dashboard.ts` | **RESOLVED** | Derived `last_changed_at` from confirmed `CHANGE` events; baseline v1 displays `OK`. |
| **CW-CON-04** | Invalid check_runs ordering column | `subscriptions.ts` | **RESOLVED** | Fixed query ordering to use schema column `created_at DESC`. |
| **CW-CON-05** | Extension calls non-existent CSRF endpoint | `src/extension/popup.js` | **RESOLVED** | Updated extension to fetch session and token via `/api/auth/me` with HTTPS enforcement. |
| **CW-CON-06** | Demo fixture route inconsistencies | `src/server/demo/fixtures.ts` | **RESOLVED** | Created canonical fixture registry (`CANONICAL_DEMO_FIXTURES`) shared across UI, server, and tests. |
| **CW-SEC-01** | Picker and capture route SSRF divergence | `pickerRender.ts` & `validateUrl.ts` | **RESOLVED** | Unified SSRF route verification helper with DNS resolution checks across all A/AAAA records. |
| **CW-SEC-02** | SMTP unauthenticated arbitrary egress | `configValidation.ts` & `dispatchers.ts` | **RESOLVED** | Enforced admin-configured SMTP defaults, strict host/DNS validation, and port allowlist (25, 465, 587, 2525). |
| **CW-SEC-03** | Notification channel markdown/HTML escaping | `dispatchers.ts` | **RESOLVED** | Implemented context-aware escaping for Telegram (MarkdownV2 & HTML), Discord, and Email. |
| **CW-SEC-04** | ReDoS vulnerability in learned noise patterns | `normalize.ts` & `volatility.ts` | **RESOLVED** | Validated regex patterns with length bounds, repetition limits, and safe compilation timeouts. |
| **CW-SEC-05** | Chromium sandbox disabled by default | `playwrightCapture.ts` | **RESOLVED** | Defaulted to enabling OS Chromium sandboxing in production environments (`CHROMIUM_SANDBOX=true`). |
| **CW-SEC-06** | Tracker lookalike host spoofing | `playwrightCapture.ts` | **RESOLVED** | Replaced substring tracking matching with exact hostname / registered domain matching. |
| **CW-SEC-07** | Unbounded picker cache & missing rate limit | `pickerRender.ts` | **RESOLVED** | Added 50-entry LRU cache bounds, TTL expiration, and 10 req/min endpoint rate limit. |
| **CW-SEC-08** | Insecure direct object update in destinations | `destinations.ts` | **RESOLVED** | Separated create and update routes with strict `WHERE id = ? AND user_id = ?` ownership validation. |
| **CW-ASY-01** | Synchronous PROBE action on subscription | `subscriptionActions.ts` & `worker.ts` | **RESOLVED** | Converted PROBE to asynchronous queue job returning 202 Accepted with job ID and rate limit. |
| **CW-ASY-02** | Gemini summary inconsistency across records | `worker.ts` & `workerHandlers.ts` | **RESOLVED** | Synchronized generated Gemini summary across `change_events`, `monitor_versions`, and `notification_outbox`. |
| **CW-ASY-03** | Schema migrations lacked column safety | `migrate.ts` | **RESOLVED** | Replaced fragile regex with `PRAGMA table_info` `hasColumn` checks wrapped in transactions. |
| **CW-ASY-04** | Scheduler daily tasks lacked catch-up | `scheduler.ts` | **RESOLVED** | Added `daily_task_ledger` table with catch-up logic when started after `DIGEST_HOUR`. |
| **CW-ASY-05** | Server shutdown lacked draining deadline | `index.ts` | **RESOLVED** | Implemented graceful shutdown with 10s draining deadline for workers, browsers, and SQLite connections. |
| **CW-ASY-06** | File deletion unlink errors caused orphan leaks | `deleteFlow.ts` & `cleanup.ts` | **RESOLVED** | Created `orphan_cleanup_queue` table with retry scheduler for locked/busy filesystem unlinks. |
| **CW-OUT-01** | RSS XML characters and CDATA termination | `stretchFeatures.ts` | **RESOLVED** | Replaced stripping with `escapeXml` and CDATA block splitting (`]]]]><![CDATA[>`) preserving characters. |
| **CW-OUT-02** | Daily digest included keyword-unmatched events | `digest.ts` & `changeDetector.ts` | **RESOLVED** | Added `suppression_reason` column; digest includes `cooldown` but strictly excludes `keyword_unmatched`. |
| **CW-OUT-03** | Numeric history extraction lacked label matching | `stretchFeatures.ts` & UI | **RESOLVED** | Added label-aware regex extraction (`extractNumericValue(text, label)`) and UI label filter. |
| **CW-OUT-04** | Diff image recomputation overhead | `diff.ts` | **RESOLVED** | Added diff PNG and companion JSON caching (`diff_${from}_${to}.json`) with user ownership checks. |

