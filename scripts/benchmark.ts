import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { startDemoServer } from '../src/server/demo/demoServer.js';
import { getDb, closeDb } from '../src/server/db/index.js';
import { migrate } from '../src/server/db/migrate.js';
import { captureFingerprint } from '../src/server/capture/captureConfig.js';
import { schedulerTick } from '../src/server/queue/scheduler.js';
import { WorkerPool } from '../src/server/queue/worker.js';

function checkPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

interface BenchmarkMetrics {
  targetN: number;
  dueSubscriptions: number;
  jobsEnqueued: number;
  topLevelNavigations: number;
  subresourceRequests: number;
  schedulingDurationMs: number;
  executionDurationMs: number;
  totalDurationMs: number;
  dedupRatio: string;
  bandwidthSavedPct: string;
}

async function runBenchmarkForN(
  db: ReturnType<typeof getDb>,
  worker: WorkerPool,
  N: number
): Promise<BenchmarkMetrics> {
  const targetId = crypto.randomUUID();
  const targetUrl = `http://127.0.0.1:4000/demo/stable?bench=${N}`;
  const urlObj = new URL(targetUrl);
  const now = new Date().toISOString();
  const pastIso = new Date(Date.now() - 60_000).toISOString();
  const { config, fingerprint } = captureFingerprint({});

  db.prepare(`
    INSERT INTO targets (id, canonical_url, hostname, origin, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(targetId, targetUrl, urlObj.hostname, urlObj.origin, now);

  // Batch insert N users and N subscriptions inside a single transaction
  const insertUsersAndSubs = db.transaction(() => {
    const userInsert = db.prepare(`
      INSERT INTO users (id, email, password_hash, password_salt, password_iterations, display_name)
      VALUES (?, ?, 'hash', 'salt', 1000, ?)
    `);
    const subInsert = db.prepare(`
      INSERT INTO subscriptions (
        id, user_id, target_id, name, interval_minutes, next_check_at,
        capture_config, capture_fingerprint, sensitivity,
        include_selectors, ignore_selectors, noise_filters,
        learned_ignore_patterns, created_at
      ) VALUES (?, ?, ?, ?, 15, ?, ?, ?, 'balanced', '[]', '[]', '{}', '[]', ?)
    `);
    const stateInsert = db.prepare(`
      INSERT INTO sub_state (subscription_id, consecutive_failures, is_currently_down, recent_checks_window, is_noisy)
      VALUES (?, 0, 0, '[]', 0)
    `);

    for (let i = 1; i <= N; i++) {
      const uId = crypto.randomUUID();
      const sId = crypto.randomUUID();
      userInsert.run(uId, `bench_${N}_${i}@example.com`, `User ${i}`);
      subInsert.run(sId, uId, targetId, `Monitor ${i}`, pastIso, JSON.stringify(config), fingerprint, now);
      stateInsert.run(sId);
    }
  });

  insertUsersAndSubs();

  // 1. Run scheduler tick and measure scheduling latency
  const t0 = performance.now();
  const tickResult = schedulerTick(db, Date.now());
  const t1 = performance.now();
  const schedulingDurationMs = Math.round((t1 - t0) * 100) / 100;

  if (tickResult.dueGroupsCount !== 1 || tickResult.jobsEnqueuedCount !== 1) {
    throw new Error(`Scheduler failed to group ${N} subscriptions: groups=${tickResult.dueGroupsCount}, jobs=${tickResult.jobsEnqueuedCount}`);
  }

  // 2. Execute the single shared job and measure execution latency
  const t2 = performance.now();
  await worker.pollAndExecute();
  await worker.waitForIdle();
  const t3 = performance.now();
  const executionDurationMs = Math.round((t3 - t2) * 100) / 100;

  // 3. Inspect results
  const obsRows = db.prepare('SELECT id, subresource_count FROM observations WHERE target_id = ?').all(targetId) as { id: string; subresource_count: number }[];
  if (obsRows.length !== 1) {
    throw new Error(`Expected exactly 1 observation for target, found ${obsRows.length}`);
  }

  const runsCount = db.prepare('SELECT count(*) as c FROM check_runs WHERE target_id = ?').get(targetId) as { c: number };
  if (runsCount.c !== N) {
    throw new Error(`Expected ${N} check_runs evaluated, found ${runsCount.c}`);
  }

  const baselineCount = db.prepare(`
    SELECT count(*) as c FROM monitor_versions mv
    JOIN subscriptions s ON mv.subscription_id = s.id
    WHERE s.target_id = ?
  `).get(targetId) as { c: number };
  if (baselineCount.c !== N) {
    throw new Error(`Expected ${N} baseline versions created, found ${baselineCount.c}`);
  }

  const topLevelNavigations = 1;
  const subresourceRequests = obsRows[0].subresource_count;
  const dedupRatio = `${N}:1`;
  const bandwidthSavedPct = `${(((N - 1) / N) * 100).toFixed(1)}%`;

  return {
    targetN: N,
    dueSubscriptions: N,
    jobsEnqueued: tickResult.jobsEnqueuedCount,
    topLevelNavigations,
    subresourceRequests,
    schedulingDurationMs,
    executionDurationMs,
    totalDurationMs: Math.round((schedulingDurationMs + executionDurationMs) * 100) / 100,
    dedupRatio,
    bandwidthSavedPct,
  };
}

async function runBenchmark() {
  const globalTimeout = setTimeout(() => {
    console.error('[BENCHMARK TIMEOUT] Benchmark stalled after 3 minutes. Exiting with 1.');
    process.exit(1);
  }, 180000);
  globalTimeout.unref();

  let demoServer: Server | null = null;
  const testDbPath = path.resolve(process.cwd(), './data/test_benchmark.db');
  const evidenceDir = path.resolve(process.cwd(), './docs/evidence/phase-10');
  const results: string[] = [];

  const log = (msg: string) => {
    console.log(msg);
    results.push(msg);
  };

  try {
    if (!fs.existsSync(evidenceDir)) fs.mkdirSync(evidenceDir, { recursive: true });
    if (fs.existsSync(testDbPath)) { try { fs.unlinkSync(testDbPath); } catch {} }

    const portFree = await checkPortFree(4000);
    if (!portFree) throw new Error('Port 4000 is in use. Please free port 4000 before running benchmark.');

    process.env.ALLOW_LOCAL_DEMO = 'true';
    process.env.DEMO_PORT = '4000';
    process.env.DATABASE_PATH = testDbPath;
    process.env.PBKDF2_ITERATIONS = '1000';

    log('======================================================================');
    log('ChangeWatch Scalability & Shared-Fetch Benchmark (Matrix S & Q2)');
    log(`Started at: ${new Date().toISOString()}`);
    log('======================================================================\n');

    demoServer = await startDemoServer(4000);
    const db = getDb(testDbPath);
    migrate(db);
    db.pragma('foreign_keys = ON');

    const worker = new WorkerPool(db, 3, 100);

    log('[1/2] Executing MUST Scope Benchmark (N = 20 Subscriptions)...');
    const m20 = await runBenchmarkForN(db, worker, 20);
    log(`  ✓ Subscriptions Due:        ${m20.dueSubscriptions}`);
    log(`  ✓ Jobs Enqueued:            ${m20.jobsEnqueued} (grouped by target + capture_fingerprint)`);
    log(`  ✓ Top-Level Navigations:    ${m20.topLevelNavigations} (Playwright browser fetch)`);
    log(`  ✓ Subresource Requests:     ${m20.subresourceRequests}`);
    log(`  ✓ Dedup Ratio:              ${m20.dedupRatio} (${m20.bandwidthSavedPct} fetch reduction)`);
    log(`  ✓ Scheduling Latency:       ${m20.schedulingDurationMs} ms`);
    log(`  ✓ Execution & Eval Latency: ${m20.executionDurationMs} ms`);
    log(`  ✓ Total Cycle Time:         ${m20.totalDurationMs} ms\n`);

    log('[2/2] Executing STRONG Scope Scalability Benchmark (N = 200 Subscriptions)...');
    const m200 = await runBenchmarkForN(db, worker, 200);
    log(`  ✓ Subscriptions Due:        ${m200.dueSubscriptions}`);
    log(`  ✓ Jobs Enqueued:            ${m200.jobsEnqueued} (grouped by target + capture_fingerprint)`);
    log(`  ✓ Top-Level Navigations:    ${m200.topLevelNavigations} (Playwright browser fetch)`);
    log(`  ✓ Subresource Requests:     ${m200.subresourceRequests}`);
    log(`  ✓ Dedup Ratio:              ${m200.dedupRatio} (${m200.bandwidthSavedPct} fetch reduction)`);
    log(`  ✓ Scheduling Latency:       ${m200.schedulingDurationMs} ms`);
    log(`  ✓ Execution & Eval Latency: ${m200.executionDurationMs} ms`);
    log(`  ✓ Total Cycle Time:         ${m200.totalDurationMs} ms\n`);

    log('======================================================================');
    log('BENCHMARK SUMMARY TABLE:');
    log('----------------------------------------------------------------------');
    log('| Metric                           | N = 20 (MUST)    | N = 200 (STRONG) |');
    log('|----------------------------------|------------------|------------------|');
    log(`| Due Subscriptions                | ${m20.dueSubscriptions.toString().padEnd(16)} | ${m200.dueSubscriptions.toString().padEnd(16)} |`);
    log(`| Grouped Jobs Enqueued            | ${m20.jobsEnqueued.toString().padEnd(16)} | ${m200.jobsEnqueued.toString().padEnd(16)} |`);
    log(`| Top-Level Navigations            | ${m20.topLevelNavigations.toString().padEnd(16)} | ${m200.topLevelNavigations.toString().padEnd(16)} |`);
    log(`| Dedup Factor                     | ${m20.dedupRatio.padEnd(16)} | ${m200.dedupRatio.padEnd(16)} |`);
    log(`| Fetch Overhead Reduction         | ${m20.bandwidthSavedPct.padEnd(16)} | ${m200.bandwidthSavedPct.padEnd(16)} |`);
    log(`| Scheduler Latency                | ${(m20.schedulingDurationMs + ' ms').padEnd(16)} | ${(m200.schedulingDurationMs + ' ms').padEnd(16)} |`);
    log(`| Worker Execution Latency         | ${(m20.executionDurationMs + ' ms').padEnd(16)} | ${(m200.executionDurationMs + ' ms').padEnd(16)} |`);
    log(`| Total Cycle Duration             | ${(m20.totalDurationMs + ' ms').padEnd(16)} | ${(m200.totalDurationMs + ' ms').padEnd(16)} |`);
    log('======================================================================');
    log('Acceptance Matrix Row S (Design Question 2: Shared Fetch) Verified!');
    log(`Finished at: ${new Date().toISOString()}`);
    log('======================================================================');

    fs.writeFileSync(path.resolve(evidenceDir, 'benchmark-results.txt'), results.join('\n'), 'utf-8');
    process.exitCode = 0;
  } catch (err) {
    console.error('\n[BENCHMARK FAILURE]', err);
    process.exitCode = 1;
  } finally {
    if (demoServer) {
      await new Promise<void>(resolve => (demoServer as Server).close(() => resolve()));
      log('[Cleanup] Demo server stopped.');
    }
    closeDb();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
    process.exit(process.exitCode ?? 0);
  }
}

runBenchmark();
