# ChangeWatch — Engineering Interview Guide 🎙️

This document prepares you for technical interviews on ChangeWatch. The questions and model answers are structured from the perspective of an engineer who built, benchmarked, and verified every architectural layer.

---

## Table of Contents
1. [Core Architecture & The 4 Design Questions](#1-core-architecture--the-4-design-questions)
2. [Concurrency, Queueing & SQLite Internals](#2-concurrency-queueing--sqlite-internals)
3. [Browser Automation, Security & SSRF Defense](#3-browser-automation-security--ssrf-defense)
4. [Deduplication, Hashing & The Single Extraction Contract](#4-deduplication-hashing--the-single-extraction-contract)
5. [Noise Normalization, Sensitivity & Confirmation](#5-noise-normalization-sensitivity--confirmation)
6. [Diff Algorithms & Visual Comparison](#6-diff-algorithms--visual-comparison)
7. [Cryptography & Security Standards](#7-cryptography--security-standards)
8. [Outbox Reliability & Notification Delivery](#8-outbox-reliability--notification-delivery)
9. [Scaling Beyond Single-Node SQLite](#9-scaling-beyond-single-node-sqlite)

---

## 1. Core Architecture & The 4 Design Questions

### Q1: "Walk me through the high-level architecture of ChangeWatch. What happens when a scheduled check runs?"
> **Model Answer:**  
> "ChangeWatch is structured as an event-driven system with clean separation between scheduling, headless execution, content evaluation, and alerting:
> 1. **Scheduler Tick**: Every `TICK_MS` (default 30s), the scheduler inspects the SQLite database for unpaused subscriptions where `next_check_at <= now()`.
> 2. **Grouped Enqueuing**: Instead of enqueuing one job per subscription, due subscriptions are grouped by `(target_id, capture_fingerprint)`. Exactly one `CHECK` job is inserted into the `jobs` table, protected by a partial unique index.
> 3. **Politeness & Atomic Claiming**: A worker pool claims the job using an atomic `UPDATE ... RETURNING` lease query. Before executing, it verifies domain politeness: checking origin-scoped `robots.txt` rules and acquiring an exclusive domain lock ensuring a 10-second quiet period between fetches.
> 4. **Headless Capture & Classification**: Playwright Chromium navigates to the URL with service workers blocked and heavy media aborted. The response is classified as `OK`, `ERROR`, or `BLOCKED`.
> 5. **Single Extraction Contract**: If `OK`, the observation is committed. The worker iterates through all due subscriptions, extracts text using Cheerio (`extractText`), applies regex noise normalizers, and hashes the content with SHA-256.
> 6. **Confirmation & Diffing**: If the hash differs from the baseline, it enters a two-check confirmation state machine. Once confirmed, Myers line diff and Pixelmatch screenshot diffs are computed, and an alert is committed to the transactional notification outbox."

---

### Q2: "Design Question 1: How do you guarantee that a site outage or a CAPTCHA challenge is never mistaken for a content change?"
> **Model Answer:**  
> "We enforce a strict invariant: **only `OK` outcomes are allowed to evaluate diffs or touch version history.**
> When Playwright executes a check, the outcome passes through a dedicated Classifier:
> - HTTP 5xx, 404, or network timeouts are classified as `ERROR`.
> - Cloudflare challenges, reCAPTCHA frames, or 429 rate limits are classified as `BLOCKED`.
> 
> Both `ERROR` and `BLOCKED` immediately bypass the change detector. Baseline versions and pending candidate states remain untouched. Instead, we track service disruptions via `consecutive_failures` in `sub_state`. If failures cross `OUTAGE_THRESHOLD` (default 3), we emit a dedicated `DOWN` alert. Once the site responds with `OK` again, we reset the failure counter and emit a `RECOVERED` alert. This guarantees zero false positive change alerts during downtime."

---

### Q3: "Design Question 2: If 200 users monitor the exact same URL, how do you prevent 200 headless browsers from hammering the site?"
> **Model Answer:**  
> "We decouple the **Target** (the URL and origin) from the **Subscription** (the user's rules, selectors, and thresholds).
> When 200 users watch `example.com`:
> 1. In SQLite, the scheduler groups due subscriptions by `(target_id, capture_fingerprint)`.
> 2. It inserts **exactly 1 job** into the queue. A partial unique index (`uq_jobs_active_group`) prevents duplicate active jobs.
> 3. The Playwright worker executes **exactly 1 top-level browser navigation**, records 1 observation, and stores the sanitized DOM and screenshot.
> 4. The worker then evaluates all 200 subscriptions in memory against that single shared observation, running each user's unique CSS selectors and noise filters.
> 
> In our benchmark script (`scripts/benchmark.ts`), this achieved a **200:1 deduplication factor**, reducing browser navigations and network bandwidth by **99.5%**."

---

### Q4: "Design Question 3: How do you handle volatile pages that change on every single load (e.g., clocks, view counters, CSRF tokens)?"
> **Model Answer:**  
> "We implement a defense-in-depth pipeline with five layers:
> 1. **CSS Selector Scoping**: Users can select target elements (e.g. `#main-article`) and exclude noisy containers (e.g. `#ad-banner`) using the Visual Selector Picker.
> 2. **Deterministic Noise Filtering**: Our normalizer runs regex replacements to strip timestamps (`HH:MM:SS`, ISO dates), incrementing counters (`Views: 1,420`), and random session tokens (`nonce`, UUIDs).
> 3. **Sensitivity Thresholds**: We compute the Myers line difference percentage. On 'balanced' sensitivity, changes below 5% line drift are ignored as noise.
> 4. **Two-Check Confirmation State Machine**: A change is first classified as a *candidate*. We schedule an immediate fast re-check after `CONFIRM_DELAY` (default 2 min). If the second check produces the exact same hash, it is confirmed. If the page flipped back (a temporary blip), the candidate is discarded with zero alerts.
> 5. **Cooldown & Noisy Flag**: Consecutive confirmed changes within `COOLDOWN_HOURS` are suppressed into a daily digest, and monitors with $>70\%$ unstable checks are automatically flagged `is_noisy`."

---

### Q5: "Design Question 4: How does ChangeWatch ensure it behaves politely and doesn't get banned by target websites?"
> **Model Answer:**  
> "Politeness is enforced at multiple architectural checkpoints:
> 1. **15-Minute Minimum Interval**: Monitored intervals are bounded between 15 minutes and 24 hours.
> 2. **Domain Navigation Locks**: The `PolitenessManager` enforces that at most one browser navigation occurs per domain at any given time.
> 3. **Mandatory 10-Second Quiet Period**: After a domain completes navigation, no other worker can hit that domain for at least 10 seconds (`DOMAIN_GAP_MS`).
> 4. **Cached robots.txt**: Before fetching, we evaluate `robots.txt` per origin (http vs https separate). Directives are cached in SQLite for 24 hours. If `Disallow` matches, the job is marked `BLOCKED` without launching a browser.
> 5. **Jitter & Backoff**: Scheduled checks add $\pm 10\%$ random jitter to prevent synchronized load spikes. When a target returns HTTP 429 with `Retry-After`, we parse the delay and back off exponentially up to 1 hour."

---

## 2. Concurrency, Queueing & SQLite Internals

### Q6: "Why did you build the job queue in SQLite instead of using an established broker like Redis with BullMQ or RabbitMQ?"
> **Model Answer:**  
> "For our single-node architecture, SQLite in WAL mode gives us significant advantages:
> 1. **Transactional Atomicity with App State**: When a job completes, updating the job status, inserting the observation, committing a version, and enqueuing outbox notifications happen within an atomic SQLite transaction. With Redis or RabbitMQ, coordinating state across the database and an external queue requires two-phase commits or risking orphaned state on crash.
> 2. **Zero External Infrastructure**: ChangeWatch runs as a self-contained process without requiring a running Redis daemon or Docker container.
> 3. **Partial Unique Indexes for Deduplication**: SQLite allows partial indexes:
>    ```sql
>    CREATE UNIQUE INDEX uq_jobs_active_group ON jobs(target_id, capture_fingerprint)
>    WHERE status IN ('QUEUED', 'CLAIMED', 'RUNNING');
>    ```
>    This guarantees at the database engine level that no two workers or scheduler ticks can ever enqueue duplicate active jobs for the same target."

---

### Q7: "How does atomic job claiming work in SQLite without locking the entire database?"
> **Model Answer:**  
> "We use SQLite's atomic `UPDATE ... RETURNING` statement within immediate transactions:
> ```sql
> UPDATE jobs
> SET status = 'CLAIMED', locked_by = :workerId, lease_expires_at = :leaseExpires
> WHERE id = :jobId AND status = 'QUEUED'
> RETURNING *;
> ```
> Because SQLite operates in WAL (Write-Ahead Logging) mode, readers never block writers and writers never block readers. The atomic update guarantees that if multiple workers attempt to claim the same queued job concurrently, exactly one worker receives the row while others receive zero rows."

---

### Q8: "What happens if a worker process crashes or the server is abruptly rebooted while a job is in progress?"
> **Model Answer:**  
> "We implement a distributed lease pattern:
> 1. When a job is claimed, `lease_expires_at` is set to `now + 30s`.
> 2. While the worker executes Playwright, an active heartbeat timer refreshes `lease_expires_at` every 10 seconds.
> 3. If the worker crashes, the heartbeat ceases and the lease expires.
> 4. On startup (and periodically), `recoverExpiredLeases()` runs:
>    ```sql
>    UPDATE jobs
>    SET status = 'QUEUED', locked_by = NULL, lease_expires_at = NULL
>    WHERE status IN ('CLAIMED', 'RUNNING') AND lease_expires_at < :nowIso;
>    ```
> This ensures zero stranded jobs and automatic crash recovery without data loss."

---

## 3. Browser Automation, Security & SSRF Defense

### Q9: "How do you protect your server from Server-Side Request Forgery (SSRF) when users can submit any URL to be monitored?"
> **Model Answer:**  
> "We treat all user-supplied URLs as hostile:
> 1. **Pre-flight Validation (`validateUrl.ts`)**: We parse the hostname and resolve its DNS IP addresses.
> 2. **Unicast IP Filtering (`ipaddr.js`)**: We reject loopback (`127.0.0.0/8`, `::1`), private RFC-1918 subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local addresses (`169.254.0.0/16`), cloud metadata endpoints (`169.254.169.254`), and IPv4-mapped IPv6 ranges.
> 3. **Protocol & Port Restrictions**: Only `http:` and `https:` on ports `80`, `443` (and demo port `4000` only when `ALLOW_LOCAL_DEMO=true`) are allowed. Embedded credentials (e.g. `user:pass@host`) are rejected.
> 4. **Redirect Re-Validation**: If a public URL redirects to an internal address, our Playwright route handler and `safeFetch` intercept the 3xx response and re-validate the target IP before following the redirect."

---

### Q10: "Why can't Node.js socket-pin Chromium's internal DNS requests, and how do you mitigate DNS rebinding in production?"
> **Model Answer:**  
> "In Node.js, we can pin sockets for Node HTTP requests (`safeFetch`), but Playwright launches Chromium as an external operating system process. Chromium resolves DNS internally through its own network stack, so Node cannot enforce socket-level IP pinning on the browser's raw socket.
> 
> To mitigate DNS rebinding:
> 1. **Per-Request Route Interception**: Playwright's `page.route('**/*')` intercepts every navigation request and subresource, resolving the hostname and aborting the request if it points to a private IP.
> 2. **Production Egress Rules**: In a production deployment, we enforce operating-system level firewall rules (`iptables` or cloud security groups) that drop all outbound egress traffic destined for private IP ranges and the `169.254.169.254` metadata service."

---

### Q11: "Why do you block service workers and close WebSockets during capture?"
> **Model Answer:**  
> "1. **Service Workers**: A malicious website could register a service worker that caches content or hijacks subsequent navigations in the Chromium profile, causing stale reads or cross-origin pollution. We launch contexts with `serviceWorkers: 'block'`.
> 2. **WebSockets**: Long-lived WebSocket connections keep the Node event loop alive indefinitely and can stream infinite fake content. We register `page.routeWebSocket()` and immediately invoke `ws.close()`, forcing the page to rely purely on standard DOM rendering."

---

## 4. Deduplication, Hashing & The Single Extraction Contract

### Q12: "What is the 'Single Extraction Contract' and why is it critical in ChangeWatch?"
> **Model Answer:**  
> "The single extraction contract means that the **exact same code** (`extractText()` in `src/server/capture/extract.ts`) is used by both the interactive Visual Selector Picker preview and the background change detector worker.
> 
> If the Visual Picker used client-side DOM `.innerText` while the worker used Cheerio or Playwright selectors, discrepancies would occur: differences in whitespace collapsing, hidden element filtering, or CSS pseudo-elements. By routing the picker's 'Test Selectors' action through `POST /api/picker/test-selectors` which runs Cheerio's `extractText()` against the cached DOM, the user sees an identical extracted preview to what the background worker will evaluate."

---

### Q13: "Why is canonical JSON serialization required when computing capture fingerprints?"
> **Model Answer:**  
> "A Capture Config contains options like `deviceScaleFactor`, `viewport`, `locale`, and `extraWaitMs`. In JavaScript, object key order is non-deterministic: `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` produce different strings with standard `JSON.stringify()`.
> 
> If two users configure identical settings but key order differs, or if one relies on implicit defaults while another provides explicit defaults, they would generate different SHA-256 hashes. Our `captureFingerprint()` function strips default values and recursively sorts keys before hashing. This guarantees that equivalent configurations always produce the exact same fingerprint, maximizing shared-fetch deduplication."

---

## 5. Noise Normalization, Sensitivity & Confirmation

### Q14: "Explain the two-check confirmation algorithm. Why not just wait for the next scheduled interval?"
> **Model Answer:**  
> "If a user configures a 24-hour interval, waiting for the next regular interval to confirm a change would delay alert delivery by a full day.
> 
> Instead, ChangeWatch uses a fast confirmation loop:
> 1. Check 1 detects a new hash $\to$ it stores `pending_candidate_hash`, sets `pending_candidate_checks = 1`, and schedules `next_check_at = now + CONFIRM_DELAY` (default 2 minutes).
> 2. The worker re-checks the page after 2 minutes (still obeying the 10-second domain gap).
> 3. If Check 2 sees the exact same hash, it is confirmed $\to$ committed as a new version and alerted.
> 4. If the page flips back to the baseline during Check 2 (a transient blip), the pending candidate is discarded with zero versions created."

---

### Q15: "How does the sensitivity gate work, and what happens to changes below the threshold?"
> **Model Answer:**  
> "We compute line drift using the formula:
> $$\text{changedPct} = \frac{\text{addedLines} + \text{removedLines}}{\max(\text{prevLines} + \text{currLines}, 1)} \times 100$$
> - `high`: Any line change triggers an alert.
> - `balanced`: Requires $\ge 5\%$ line drift.
> - `low`: Requires $\ge 20\%$ line drift.
> 
> If a change is below the threshold, it is logged in `check_runs` but does **not** create a version or send an alert. The baseline remains anchored to the previous version. This deliberate design decision allows slow minor drift to accumulate until it crosses the threshold against the established baseline, preventing noisy micro-alerts."

---

## 6. Diff Algorithms & Visual Comparison

### Q16: "How do your text diff and visual screenshot diff engines work?"
> **Model Answer:**  
> "1. **Text Diff**: We use the Myers diff algorithm (`diff` library). In `diffSummary.ts`, `diffLines` computes added and removed line chunks for the unified diff view. For changed lines, we run `diffWords` to highlight word-level modifications inline.
> 2. **Screenshot Diff**: We use `pixelmatch` at a strict 0.1 sensitivity threshold. Because screenshots from different page versions may vary slightly in height, `imageDiff.ts` dynamically pads both PNG buffers to the maximum width and height on a blank RGBA canvas. It generates a diff image with changed pixels highlighted in red, calculates the exact percentage of modified pixels, and caches the result under `data/diffs/` keyed by `SHA-256(versionFrom + versionTo)`."

---

## 7. Cryptography & Security Standards

### Q17: "How are destination secrets and passwords protected in the database?"
> **Model Answer:**  
> "1. **User Passwords**: We use PBKDF2-HMAC-SHA512 with a cryptographically secure 16-byte salt and **600,000 iterations** (matching OWASP recommendations). Password salts and iteration counts are stored alongside the hash to support future work-factor upgrades.
> 2. **Destination Secrets**: Discord webhook URLs, Telegram bot tokens, and SMTP credentials contain sensitive access keys. We derive a 256-bit encryption key from `APP_SECRET` using `scrypt` and encrypt payloads with **AES-256-GCM** with a random 12-byte initialization vector (IV) and a 16-byte authentication tag.
> 3. **API Masking**: The REST API and loggers never return decrypted secrets. Responses return masked strings showing only the last 4 characters (e.g. `••••••••9b2a`)."

---

### Q18: "How does ChangeWatch protect against Cross-Site Request Forgery (CSRF)?"
> **Model Answer:**  
> "We employ a custom Double-Submit CSRF Token architecture:
> 1. When a user authenticates, a random 32-byte cryptographic token is generated and bound to their active session in the database.
> 2. The client fetches the token via `GET /api/auth/me`.
> 3. All mutating HTTP methods (`POST`, `PATCH`, `DELETE`) require the `X-CSRF-Token` header.
> 4. Middleware verifies that the token in the header matches the active session token before allowing the request to proceed. Session cookies use `httpOnly`, `SameSite=Lax`, and `Secure` in production."

---

## 8. Outbox Reliability & Notification Delivery

### Q19: "Why use an outbox pattern for notifications instead of sending webhooks directly inside the worker?"
> **Model Answer:**  
> "Sending external HTTP requests directly inside a database worker introduces major reliability risks:
> 1. **Worker Blocking**: If Discord or an SMTP server is slow or experiencing an outage, the database worker would hang, stalling subsequent checks.
> 2. **Atomicity**: If the alert succeeds but the database transaction rolls back, the user receives an alert for a change that does not exist in history.
> 3. **Truthful Outbox States**: We insert an outbox row with `status = 'QUEUED'` in the same database transaction that commits the version. The `OutboxWorker` processes deliveries independently with truthful states (`SENT_EXTERNAL`, `PENDING_CONFIG`, `RECORDED_IN_APP`, `RETRYING`, `FAILED`).
> 4. **Idempotency**: Outbox rows include a composite idempotency key (`${subscriptionId}:${eventId}:${channel}`). Retries or concurrent ticks can never result in duplicate notifications."

---

## 9. Scaling Beyond Single-Node SQLite

### Q20: "If ChangeWatch scaled from 200 monitors on a laptop to 500,000 monitors across a cluster, what would you change?"
> **Model Answer:**  
> "1. **Database Tier**: Migrate from SQLite to **PostgreSQL**. The job queue would use `SELECT ... FOR UPDATE SKIP LOCKED` for concurrent multi-node worker claiming.
> 2. **Distributed Queue**: For high throughput, extract the queue into **Redis with BullMQ** or **Temporal** for durable workflow orchestration.
> 3. **Headless Browser Pool**: Scale Playwright workers into a containerized fleet on Kubernetes (e.g. Browserless.io or Playwright grid with auto-scaling based on queue depth).
> 4. **Object Storage**: Move screenshot PNGs from local `data/screenshots/` to **S3 / Cloud Storage** with pre-signed CDN URLs.
> 5. **Egress Gateway**: Route all browser egress traffic through a forward proxy with strict Squid/eBPF egress filtering to guarantee absolute SSRF and DNS rebinding isolation."
