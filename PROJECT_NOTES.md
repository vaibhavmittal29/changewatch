# ChangeWatch — Project Notes

**Single Source of Truth Plan:** [`docs/implementation_plan.md`](./docs/implementation_plan.md)  
**Current Phase:** Phase 11 (Documentation, Polish and Interview Notes) — COMPLETED  
**Last Updated:** Phase 11 Complete (Comprehensive README.md, docs/INTERVIEW_QA.md, and finalized Acceptance Matrix)

---

## 1. Scope Tiers Confirmation

- **MUST (Core MVP - Satisfies all 8 Requirements & 4 Design Questions):**
  - Auth & session management (PBKDF2, sessions, CSRF, rate limit)
  - Subscription CRUD (quotas, interval 15–1440 min, ownership isolation)
  - Canonical capture configuration & deterministic SHA-256 fingerprinting
  - Playwright headless capture worker (route interception, WebSocket closed, service workers blocked)
  - SSRF protection (`validateUrl`, `safeFetch`, unicast IP policy, DNS rebinding mitigation)
  - Outcome classifier (`OK`, `ERROR`, `BLOCKED` with CAPTCHA/challenge detection)
  - Durable SQLite job queue (atomic claim, lease/heartbeat, crash recovery)
  - Politeness layer (origin-scoped robots.txt cache, per-domain lock + 10s gap, backoff, jitter, Retry-After)
  - Shared fetch optimization (one fetch per target_id + capture_fingerprint, 15s reuse window)
  - Content hashing & immutable version history (`ON DELETE RESTRICT`)
  - Noise normalization (timestamps, counters, tokens, copyright years)
  - Sensitivity gate (low/balanced/high Myers line diff threshold) & two-check confirmation re-check (`CONFIRM_DELAY`)
  - Diff engine (Myers text diff lines/words, pixelmatch screenshot diff with padding)
  - Visual selector picker (watch/ignore CSS selectors, fragile class warning, single extraction contract)
  - Notifications outbox (Discord webhook, Telegram, in-app outbox, truthful states, idempotency)
  - Dashboard & timeline UI (status badges, auto-refresh, version compare)
  - Local demo server (14+ fixtures on port 4000) & smoke test suite (`scripts/smoke.ts`)

- **STRONG (Quality Multipliers - To execute after MUST criteria pass):**
  - Volatility probe (suggests unstable lines on subscription creation)
  - Cooldown gate (6h suppression to digest)
  - Noisy flag (>70% candidate changes in rolling window)
  - Daily digest outbox at configured hour
  - Email notification via Nodemailer (SMTP env)
  - Routine retention cleanup + cascading deletion workflow
  - 200-subscription scalability benchmark (`scripts/benchmark.ts`)
  - Myers word-level inline diff polish

- **STRETCH (Deferred / Post-MVP):**
  - Keyword-only alerts
  - Numeric metric tracking & Chart.js visualizer
  - Gemini GenAI one-line summary generator
  - Per-page RSS feed
  - `http_dom` (Cheerio) alternative engine
  - Chrome browser extension

---

## 2. Directory Structure

```text
changewatch/
  docs/
    implementation_plan.md      # Single source of truth v2
    INTERVIEW_QA.md             # Model interview Q&A
    evidence/                   # Phase verification evidence & screenshots
      README.md
      phase-0/
      phase-1/
      ...
  PROJECT_NOTES.md              # Living state, decisions & acceptance log
  README.md                     # Public documentation & architecture guide
  .env.example                  # Environment configuration template
  .env                          # Local environment (gitignored)
  .gitignore                    # Git ignore file
  package.json                  # Node dependencies & scripts
  tsconfig.json                # Strict TypeScript configuration
  tsconfig.node.json           # Node-specific tsconfig (vite/server scripts)
  vite.config.ts                # Client Vite configuration
  vitest.config.ts              # Vitest configuration
  src/
    server/
      index.ts                  # Bootstrap: DB, workers, Express, Vite middleware
      config.ts                 # Zod validated env config
      db/
        index.ts                # Database connection & connection pragmas
        schema.sql              # Raw DDL schema
        migrate.ts              # Migration runner with user_version
      auth/
        password.ts             # PBKDF2 hashing & verification
        sessions.ts             # Session tokens & CSRF token generator
        csrf.ts                 # Double-submit / CSRF header verification
        middleware.ts           # Authentication & rate limiting middleware
      routes/
        auth.ts                 # Register, login, logout, me
        subscriptions.ts        # Monitor CRUD, pause, resume, check-now
        dashboard.ts            # Summary metrics & monitor list
        diff.ts                 # Text & screenshot diff APIs
        picker.ts               # Screenshot element box renderer & test-selectors
        notifications.ts        # In-app outbox & destination configuration
        demo.ts                 # Demo fixtures controller
      capture/
        captureConfig.ts        # Canonical capture schema & deterministic fingerprint
        validateUrl.ts          # SSRF URL validator & ipaddr.js unicast policy
        safeFetch.ts            # IP-pinned fetch for robots.txt & redirects
        playwrightCapture.ts    # Browser context, route filter, sanitized DOM, screenshot
        extract.ts              # Single extraction contract (Cheerio block-level)
        classifier.ts           # OK / ERROR / BLOCKED decision engine
      queue/
        jobs.ts                 # Queue insertion & state transitions
        scheduler.ts            # Interval ticker & due-only grouping
        worker.ts               # Worker pool, lease heartbeat, crash recovery
        politeness.ts           # Domain lock, 10s domain gap, jitter, Retry-After
        robots.ts               # Origin-scoped robots.txt fetcher & parser
      engine/
        normalize.ts            # Text normalization & regex noise stripping
        changeDetector.ts       # Sensitivity gate, confirmation state machine, outage accounting
        versions.ts             # Immutable version commit & active pointer
        volatility.ts           # Volatility probe dual-fetch analyzer
      diff/
        textDiff.ts             # Myers diffLines & diffWords
        imageDiff.ts            # Canvas padding & pixelmatch execution
      notify/
        crypto.ts               # AES-256-GCM encryption & masking for credentials
        outbox.ts               # Outbox dispatcher with composite idempotency key
        discord.ts              # Discord webhook payload sender
        telegram.ts             # Telegram bot messaging
        email.ts                # Nodemailer SMTP transport
        digest.ts               # Daily digest aggregator
      maintenance/
        cleanup.ts              # Unreferenced observation & screenshot pruner
        deleteFlow.ts           # Cascade subscription & orphan target removal
      demo/
        demoServer.ts           # Express demo fixture server on port 4000
        fixtures.ts             # 16 controllable fixture handlers
    client/
      index.html
      main.tsx
      App.tsx
      index.css
      pages/
        Login.tsx
        Dashboard.tsx
        MonitorDetail.tsx
        Compare.tsx
        Picker.tsx
        Settings.tsx
        TestRig.tsx
      components/
        Navbar.tsx
        StatusBadge.tsx
        Modal.tsx
        DiffViewer.tsx
        PickerOverlay.tsx
  scripts/
    seed.ts                     # Demo seed data
    smoke.ts                    # End-to-end integration test runner
    benchmark.ts                # Multi-subscription load benchmark
  tests/
    unit/
      captureConfig.test.ts
      validateUrl.test.ts
      normalize.test.ts
      classifier.test.ts
      textDiff.test.ts
      crypto.test.ts
    integration/
      auth.test.ts
      queue.test.ts
      scheduler.test.ts
      changeDetector.test.ts
      diff.test.ts
      notifications.test.ts
  data/                         # SQLite DB, screenshots/, diffs/ (gitignored)
```

---

## 3. Windows PowerShell Setup Checklist

- [x] **Node.js LTS Installed**: Node `v24.20.0` detected (`>= 20` required).
- [x] **npm Installed**: npm `11.19.0` detected.
- [x] **Git Installed**: Git `2.55.0.windows.4` detected.
- [x] **Omniroute Installed**: Global `omniroute@3.8.49` verified per user rules.
- [x] **Package Dependencies**: `npm install` pinned versions installed cleanly.
- [x] **Native Addon Prebuilt Verification**: `better-sqlite3@13.0.3` installed and verified without compilation errors.
- [x] **Playwright Chromium Browser**: Chromium installed and verified via `scripts/verify-ui.ts`.
- [x] **Data Directory Creation**: Verified `data/screenshots` and `data/diffs` automatically created.

---

## 4. Key Assumptions & Open Questions (Max 5)

1. **Port Strategy in Development:** Single Express server on port 3000 serves both API endpoints and the React frontend via Vite middleware (`vite.createServer({ server: { middlewareMode: true } })`), while the local demo fixture server runs separately on port 4000 when `ALLOW_LOCAL_DEMO=true`.
2. **PBKDF2 Iterations:** Production default is set to `600,000` iterations for security, with tests and development scripts using `1,000` iterations via env override (`PBKDF2_ITERATIONS=1000`) for speed.
3. **Database Concurrency:** SQLite in WAL mode handles multiple readers and single-writer transactions cleanly. Job claiming uses atomic `UPDATE ... RETURNING *` within explicit immediate transactions to prevent race conditions across worker concurrency.
4. **Browser Subresource Blocking:** Playwright route handler will abort heavy media (`media`, `font`, `images` above threshold) and tracking scripts during change detection runs, but the Visual Selector Picker route (`POST /api/picker/render`) will retain layout CSS/images so users can visually select DOM elements accurately.
5. **Confirmation Re-check Timing:** When a candidate change is observed, `next_check_at` is set to `now + CONFIRM_DELAY_MS` (default 2 minutes, or dev override for demo origin) rather than the standard monitor interval (15 min – 24 h), ensuring quick confirmation alerts while honoring the 10-second per-domain gap.

---

## 4.1 AppSec Isolation & Chromium Sandboxing Guarantees

1. **Production Secret Enforcement:**
   - In production (`NODE_ENV=production`), `APP_SECRET` is strictly mandatory.
   - Rejects well-known test keys and low-entropy strings via Shannon entropy verification (minimum 3.0 bits/char) and character diversity check (minimum 10 unique characters).
   - Enforces PBKDF2 iterations $\ge 600,000$ in production mode.
2. **Chromium Sandboxing & Rootless Operation:**
   - In production Docker and Kubernetes deployments, ChangeWatch is architected to run under an unprivileged user (e.g. non-root UID 1000).
   - When running in an unprivileged container with user namespaces or seccomp enabled, native Chromium sandboxing can be strictly enforced by setting `CHROMIUM_SANDBOX=true` (which strips `--no-sandbox` from Chromium arguments).
   - In unprivileged CI/CD or container platforms lacking user namespaces, `--no-sandbox` is used as an operational fallback, supplemented by multi-layer AppSec controls:
     - **CDP Request Interception:** Intercepts all redirects deterministically with `maxRedirects: 0` and resolves DNS targets, immediately aborting non-public, loopback, or cloud metadata (`169.254.169.254`) destinations.
     - **Network Hardening:** Disables service workers, closes WebSockets, and aborts tracking scripts and unauthorized subresources.
     - **Execution Timeout Caps:** Enforces a 15-second hard timeout per navigation.
     - **Filesystem Isolation:** Playwright runs in headless mode without local storage persistence or access to `file://` schemes.

---

## 5. Acceptance Matrix (Live Status)

| Ref | Tier | Requirement | How verified | Status | Evidence |
|---|---|---|---|---|---|
| A1 | MUST | Auth, sessions, ownership isolation (user B cannot read or edit user A's monitor) | Integration tests | PASS | [`tests/integration/auth.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/auth.test.ts), [`docs/evidence/phase-1/api-flow.txt`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/docs/evidence/phase-1/api-flow.txt) |
| A2 | MUST | CSRF header enforced; destination secrets masked in API and logs | Integration test + payload audit | PASS | [`tests/integration/auth.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/auth.test.ts) |
| B | MUST | SSRF: loopback, private, link-local, metadata, IPv6 ranges, IPv4-mapped IPv6, credentials in URL, bad ports all rejected; redirects re-validated | Unit + integration tests | PASS | [`tests/unit/validateUrl.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/unit/validateUrl.test.ts), [`tests/integration/capture.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/capture.test.ts) |
| C | MUST | Browser interception: disallowed subresource aborted, WebSocket closed, service workers blocked | Playwright integration test | PASS | [`src/server/capture/playwrightCapture.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/src/server/capture/playwrightCapture.ts), [`tests/integration/capture.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/capture.test.ts) |
| D | MUST | Interval 15–1440 enforced; `next_check_at` set and advanced with ±10% jitter; dev override only for demo origin | Unit + integration tests | PASS | [`tests/integration/auth.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/auth.test.ts), [`src/server/routes/subscriptions.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/src/server/routes/subscriptions.ts) |
| E | MUST | robots.txt honored per origin (http vs https separate), Allow/Disallow precedence, 4xx = allow, 5xx = disallow-for-now, raw body + headers cached 24 h | Unit tests | PASS | [`tests/unit/robots.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/unit/robots.test.ts), [`docs/evidence/phase-3/test-results.txt`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/docs/evidence/phase-3/test-results.txt) |
| F | MUST | One navigation per domain at a time; minimum gap enforced | Fake-timer test | PASS | [`tests/unit/politeness.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/unit/politeness.test.ts), [`docs/evidence/phase-3/test-results.txt`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/docs/evidence/phase-3/test-results.txt) |
| H | MUST | OK / ERROR / BLOCKED classification (503, 404, timeout, 403, 429, CAPTCHA, empty) | Unit + fixture tests | PASS | [`tests/unit/classifier.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/unit/classifier.test.ts), [`tests/integration/capture.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/capture.test.ts) |
| I | MUST | ERROR/BLOCKED leave baseline, pending state and versions untouched | Integration test | PASS | [`tests/integration/changeDetector.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/changeDetector.test.ts), [`docs/evidence/phase-4/test-results.txt`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/docs/evidence/phase-4/test-results.txt) |
| J | MUST | DOWN alert after `OUTAGE_THRESHOLD` failed jobs; RECOVERED alert on next OK | Integration test | PASS | [`tests/integration/confirmation.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/confirmation.test.ts), [`docs/evidence/phase-5/test-results.txt`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/docs/evidence/phase-5/test-results.txt) |
| K | MUST | SHA-256 hash stable for identical normalized text | Unit test | PASS | [`tests/unit/normalize.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/unit/normalize.test.ts), [`docs/evidence/phase-4/test-results.txt`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/docs/evidence/phase-4/test-results.txt) |
| L | MUST | Stable page: 5 checks create exactly 1 version (baseline) | Integration test | PASS | [`tests/integration/changeDetector.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/changeDetector.test.ts), [`docs/evidence/phase-4/test-results.txt`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/docs/evidence/phase-4/test-results.txt) |
| M | MUST | Headline change creates version 2 after confirmation | Integration test | PASS | [`tests/integration/changeDetector.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/changeDetector.test.ts), [`docs/evidence/phase-4/test-results.txt`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/docs/evidence/phase-4/test-results.txt) |
| N | MUST | Timestamp, counter, token filters; clock/counter/token fixtures produce no alert | Unit + fixture tests | PASS | [`tests/unit/noiseFilters.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/unit/noiseFilters.test.ts), [`docs/evidence/phase-5/test-results.txt`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/docs/evidence/phase-5/test-results.txt) |
| P | MUST | Candidate needs 2 consecutive matching checks; re-check scheduled after `CONFIRM_DELAY`, not the full interval; flip-back discards candidate | Integration test | PASS | [`tests/integration/confirmation.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/confirmation.test.ts), [`docs/evidence/phase-5/test-results.txt`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/docs/evidence/phase-5/test-results.txt) |
| R | MUST | Expired job leases recovered on startup; no job lost or double-run | Crash-recovery test | PASS | [`tests/integration/queue.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/queue.test.ts), [`docs/evidence/phase-3/test-results.txt`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/docs/evidence/phase-3/test-results.txt) |
| S | MUST | N compatible due subscriptions on one URL cause exactly 1 top-level navigation per cycle (N=20 MUST, N=200 STRONG) | Benchmark script | PASS | [`scripts/benchmark.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/scripts/benchmark.ts), [`docs/evidence/phase-10/benchmark-results.txt`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/docs/evidence/phase-10/benchmark-results.txt) |
| T | MUST | Text diff (added/removed) and screenshot diff (changed-pixel %) correct on fixtures | Unit + browser check | PASS | [`tests/unit/textDiff.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/unit/textDiff.test.ts), [`tests/unit/imageDiff.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/unit/imageDiff.test.ts), [`tests/integration/diffApi.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/diffApi.test.ts), [`docs/evidence/phase-6/compare-unified.png`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/docs/evidence/phase-6/compare-unified.png) |
| U | MUST | Picker generates selectors; Watch/Ignore saved and honored by checks | Browser walkthrough + integration test | PASS | [`tests/integration/picker.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/picker.test.ts), [`docs/evidence/phase-9/`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/docs/evidence/phase-9/) |
| V | MUST | Outbox states truthful (SENT_EXTERNAL only on provider 2xx; PENDING_CONFIG; RECORDED_IN_APP; RETRYING; FAILED) | Mocked-provider tests | PASS | [`tests/integration/notifications.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/notifications.test.ts), [`docs/evidence/phase-7/test-results.txt`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/docs/evidence/phase-7/test-results.txt) |
| W | MUST | Duplicate alert suppressed by idempotency key; channels deliver independently | Unit test | PASS | [`tests/integration/notifications.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/notifications.test.ts), [`docs/evidence/phase-7/test-results.txt`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/docs/evidence/phase-7/test-results.txt) |
| Y | MUST | Demo server fixtures 1–16 all selectable from the Test Rig | Browser walkthrough | PASS | [`src/server/demo/demoServer.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/src/server/demo/demoServer.ts), [`tests/integration/capture.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/capture.test.ts) |
| AA | MUST | Only due subscriptions are evaluated and advanced in a shared capture | Integration test | PASS | [`tests/integration/scheduler.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/scheduler.test.ts), [`docs/evidence/phase-3/test-results.txt`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/docs/evidence/phase-3/test-results.txt) |
| AB | MUST | Different capture fingerprints on the same URL cause separate captures | Integration test | PASS | [`tests/integration/scheduler.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/scheduler.test.ts), [`docs/evidence/phase-3/test-results.txt`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/docs/evidence/phase-3/test-results.txt) |
| AF | MUST | Omitted defaults, explicit defaults, and reordered keys give identical fingerprints | Unit test | PASS | [`tests/unit/captureConfig.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/unit/captureConfig.test.ts) |
| AG | MUST | Material config changes give different fingerprints | Unit test | PASS | [`tests/unit/captureConfig.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/unit/captureConfig.test.ts) |
| AI | MUST | Capture config rejects unknown keys (e.g. `customHeaders`, `cookies`) | Unit test | PASS | [`tests/unit/captureConfig.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/unit/captureConfig.test.ts) |
| AK | MUST | Retries do not inflate failure count; one exhausted job = one failure | Integration test | PASS | [`tests/integration/queue.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/queue.test.ts), [`docs/evidence/phase-3/test-results.txt`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/docs/evidence/phase-3/test-results.txt) |
| AH | MUST | `scripts/smoke.ts` passes end to end | Script output | PASS | [`scripts/smoke.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/scripts/smoke.ts), [`docs/evidence/phase-10/smoke-results.txt`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/docs/evidence/phase-10/smoke-results.txt) |
| O | STRONG | Volatility probe suggests unstable lines; approved patterns are applied | Integration test | PASS | [`src/server/engine/volatility.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/src/server/engine/volatility.ts), [`tests/integration/volatility.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/volatility.test.ts) |
| Q | STRONG | Cooldown suppresses immediate alert (event kept for digest); noisy flag at >70% of last 10 | Integration test | PASS | [`tests/integration/confirmation.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/confirmation.test.ts), [`docs/evidence/phase-5/test-results.txt`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/docs/evidence/phase-5/test-results.txt) |
| Z | STRONG | Retention removes only unreferenced old observations; confirmed versions and pending candidates survive | Integration test | PASS | [`tests/integration/lifecycle.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/lifecycle.test.ts), [`docs/evidence/phase-8/test-results.txt`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/docs/evidence/phase-8/test-results.txt) |
| Z2 | STRONG | Deleting a monitor/account cleans cascade rows, orphan observations and screenshot files | Integration test | PASS | [`tests/integration/lifecycle.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/lifecycle.test.ts), [`docs/evidence/phase-8/test-results.txt`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/docs/evidence/phase-8/test-results.txt) |
| DG | STRONG | Daily digest sent once per user per day per channel | Integration test | PASS | [`src/server/queue/scheduler.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/src/server/queue/scheduler.ts), [`tests/integration/schedulerDaily.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/schedulerDaily.test.ts) |
| EM | STRONG | Email via Nodemailer works with SMTP env, otherwise `PENDING_CONFIG` | Mocked test | PASS | [`tests/integration/notifications.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/notifications.test.ts), [`docs/evidence/phase-7/test-results.txt`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/docs/evidence/phase-7/test-results.txt) |
| X1 | STRETCH | `http_dom` engine with cross-field rule (screenshots require Playwright) | Tests | PASS | [`src/server/capture/httpDomCapture.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/src/server/capture/httpDomCapture.ts), [`tests/integration/stretchFeatures.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/stretchFeatures.test.ts) |
| X2 | STRETCH | Keyword alerts, number tracking + chart, Gemini summary, RSS feed, browser extension | Per feature | PASS | [`src/server/engine/changeDetector.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/src/server/engine/changeDetector.ts), [`src/server/engine/geminiSummary.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/src/server/engine/geminiSummary.ts), [`src/server/routes/stretchFeatures.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/src/server/routes/stretchFeatures.ts), [`tests/integration/keywordAlerts.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/keywordAlerts.test.ts), [`tests/integration/stretchFeatures.test.ts`](file:///c:/Programming/Projects%20of%20antigravity/project_6_webdev_vinnovateit_websitechangedetector3/tests/integration/stretchFeatures.test.ts) |

---

## 6. Execution History Log

| Timestamp | Phase | Action / Event | Outcome |
|---|---|---|---|
| Initial | Phase 0 | Implementation plan saved to `docs/implementation_plan.md` | Single source of truth recorded |
| Initial | Phase 0 | Environment checks & directory layout planned | Node v24, Git, Omniroute ready |
| Initial | Phase 0 | Scaffolded `PROJECT_NOTES.md` and `docs/evidence/` | Complete, approved by user |
| Phase 1 | Phase 1 | Foundation, database, auth & subscription CRUD implemented | All unit & integration tests pass |
| Phase 1 | Phase 1 | Diagnosed & resolved verification hang | Fixed missing `env` import in `middleware.ts`, added `-UseBasicParsing` & 10s timeout in PowerShell script |
| Phase 1 | Phase 1 | Executed end-to-end API & Playwright UI verification | API verification passed; captured `login-ui.png` and `login-autofilled.png` |
| Phase 2 | Phase 2 | Secure capture, classifier & 16 demo server fixtures | All 36 tests passed; SSRF guard, Playwright route interception, screenshots saved to `docs/evidence/phase-2/` |
| Phase 3 | Phase 3 | Durable SQLite queue, politeness, robots cache & scheduler | All 54 tests passed; atomic claims, crash recovery, 10s domain gap, origin robots, due-only grouping verified |
| Phase 4 | Phase 4 | Hashing, baseline Version 1, change detector & history | All 62 tests passed; 5 stable checks = 1 version, headline change = version 2, baseline protected on error, ON DELETE RESTRICT |
| Phase 5 | Phase 5 | Noise filtering, sensitivity thresholds, 2-check confirmation & outages | All 76 tests passed; timestamps/counters/tokens regex, Myers diff summary, flip-back discard, cooldown gate, noisy flag, DOWN/RECOVERED outage flow |
| Phase 6 | Phase 6 | Diff Engine: unified Myers text diff, inline words, pixelmatch visual diff & Compare UI | All 87 tests passed; line and word diffs, 0.1 threshold screenshot diffing, canvas padding, diff image cache, ownership isolation, and Playwright Compare page verification |
| Phase 7 | Phase 7 | Multi-channel notifications: Discord embeds, Telegram Bot API, Nodemailer SMTP, outbox worker, idempotency suppression & 24h daily digest | All 95 tests passed; AES-256-GCM encryption & recursive masking, composite key deduplication, truthful outbox delivery status states, and digest bundling verified |
| Phase 8 | Phase 8 | Dashboard, Timeline, Lifecycle, Retention Pruner & UI Walkthrough | All 98 tests passed; cascading delete (Z2), retention pruner (Z), auto-refresh dashboard, add-monitor modal, monitor detail timeline, alert settings, test rig fixtures 1-16, and Playwright walkthrough screenshots verified |
| Phase 9 | Phase 9 | Visual Selector Picker: in-page element inspection, interactive overlay canvas, popovers, single extraction contract test & monitor update | All 101 tests passed across 21 suites; row U verified; banner ignored and headline alerted; 5 walkthrough screenshots saved to `docs/evidence/phase-9/` |
| Phase 10 | Phase 10 | Benchmark & Smoke Suite: end-to-end smoke test on demo server & 200-sub scalability benchmark | All 4 smoke criteria passed (real change, noise filters, outage/CAPTCHA baseline untouched, DOWN/RECOVERED flow); 20:1 and 200:1 shared-fetch benchmark verified with 1 navigation per cycle and 99.5% network reduction |
| Phase 11 | Phase 11 | Documentation, Polish & Interview Notes: Root README, Mermaid architecture, 3-minute demo script & INTERVIEW_QA | Complete system documentation, setup instructions, 4 design question answers, and 20-question deep-dive technical interview guide authored |
| Phase 12 | Audit & Fix | Comprehensive bug hardening: SSRF browser route DNS resolution, non-consecutive failure counter reset, screenshot styling before cleanup, robots error TTL reduction to 5m, smart challenge classifier, subscription URL validation, and expanded smoke suite | All 102 tests pass, 5/5 smoke criteria pass, 0 lint warnings, all files strictly <250 lines |
| Phase 13 | Final Hardening & STRETCH | Secret management & production config refinement, loopback demo server, due-only robots queue advance, daily scheduler background runner, volatility probe (STRONG Row O), Cheerio http_dom engine (Row X1), keyword alerts, Chart.js numeric history, RSS feed, and Gemini fallback summary (Row X2) | 115 tests passing across 26 suites, 0 lint warnings, clean build, smoke & benchmark evidence generated |


