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
