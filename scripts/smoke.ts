import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { startDemoServer } from '../src/server/demo/demoServer.js';
import { fixtureState, resetFixtureState } from '../src/server/demo/fixtures.js';
import { getDb, closeDb } from '../src/server/db/index.js';
import { migrate } from '../src/server/db/migrate.js';
import { captureFingerprint } from '../src/server/capture/captureConfig.js';
import { schedulerTick } from '../src/server/queue/scheduler.js';
import { WorkerPool } from '../src/server/queue/worker.js';
import { recordCheckFailure } from '../src/server/engine/changeDetector.js';

function checkPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

function setupTargetAndSub(
  db: ReturnType<typeof getDb>,
  userId: string,
  url: string,
  name: string,
  filters: Record<string, boolean> = { timestamps: true, counters: true, tokens: true }
): { subId: string; targetId: string } {
  const targetId = crypto.randomUUID();
  const subId = crypto.randomUUID();
  const now = new Date().toISOString();
  const urlObj = new URL(url);
  const { config, fingerprint } = captureFingerprint({});

  const past = new Date(Date.now() - 60_000).toISOString();

  db.prepare(`
    INSERT INTO targets (id, canonical_url, hostname, origin, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(targetId, url, urlObj.hostname, urlObj.origin, now);

  db.prepare(`
    INSERT INTO subscriptions (
      id, user_id, target_id, name, interval_minutes, next_check_at,
      capture_config, capture_fingerprint, sensitivity,
      include_selectors, ignore_selectors, noise_filters,
      learned_ignore_patterns, created_at
    ) VALUES (?, ?, ?, ?, 15, ?, ?, ?, 'balanced', '[]', '[]', ?, '[]', ?)
  `).run(subId, userId, targetId, name, past, JSON.stringify(config), fingerprint, JSON.stringify(filters), now);

  db.prepare(`
    INSERT INTO sub_state (subscription_id, consecutive_failures, is_currently_down, recent_checks_window, is_noisy)
    VALUES (?, 0, 0, '[]', 0)
  `).run(subId);

  return { subId, targetId };
}

async function runSmokeTests() {
  const globalTimeout = setTimeout(() => {
    console.error('[SMOKE TIMEOUT] Smoke test stalled after 3 minutes. Exiting with 1.');
    process.exit(1);
  }, 180000);
  globalTimeout.unref();

  let demoServer: Server | null = null;
  const testDbPath = path.resolve(process.cwd(), './data/test_smoke.db');
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
    if (!portFree) throw new Error('Port 4000 is in use. Please free port 4000 before running smoke suite.');

    process.env.ALLOW_LOCAL_DEMO = 'true';
    process.env.DEMO_PORT = '4000';
    process.env.DATABASE_PATH = testDbPath;
    process.env.PBKDF2_ITERATIONS = '1000';

    log('======================================================================');
    log('ChangeWatch End-to-End Smoke Test Suite (Acceptance Matrix AH)');
    log(`Started at: ${new Date().toISOString()}`);
    log('======================================================================\n');

    demoServer = await startDemoServer(4000);
    const db = getDb(testDbPath);
    migrate(db);
    db.pragma('foreign_keys = ON');

    const worker = new WorkerPool(db, 3, 100);
    const userId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO users (id, email, password_hash, password_salt, password_iterations, display_name)
      VALUES (?, 'smoke@example.com', 'hash', 'salt', 1000, 'Smoke Tester')
    `).run(userId);

    const setPastTime = (subIds: string[]) => {
      const pastIso = new Date(Date.now() - 60_000).toISOString();
      const placeholders = subIds.map(() => '?').join(',');
      db.prepare(`UPDATE subscriptions SET next_check_at = ? WHERE id IN (${placeholders})`).run(pastIso, ...subIds);
    };

    const runCycle = async (advanceTime = false) => {
      if (advanceTime) {
        const pastObsIso = new Date(Date.now() - 60_000).toISOString();
        db.prepare('UPDATE observations SET captured_at = ?').run(pastObsIso);
      }
      schedulerTick(db, Date.now());
      while (true) {
        const executed = await worker.pollAndExecute();
        await worker.waitForIdle();
        if (executed === 0) break;
      }
    };

    // 1. REAL CHANGE DETECTION (Version baseline -> candidate -> confirmed -> 1 alert)
    log('[1/4] Testing Real Change Detection on /demo/headline...');
    resetFixtureState();
    const { subId: headlineSubId } = setupTargetAndSub(db, userId, 'http://127.0.0.1:4000/demo/headline', 'Headline Monitor');

    await runCycle();
    const v1Count = db.prepare('SELECT count(*) as c FROM monitor_versions WHERE subscription_id = ?').get(headlineSubId) as { c: number };
    const e0Count = db.prepare('SELECT count(*) as c FROM change_events WHERE subscription_id = ?').get(headlineSubId) as { c: number };
    if (v1Count.c !== 1 || e0Count.c !== 0) throw new Error(`Initial check failed: versions=${v1Count.c}, events=${e0Count.c}`);
    log('  ✓ Initial check established Version 1 baseline (0 alerts sent)');

    fixtureState.headlineText = 'Smoke Test: Breaking News Update from ChangeWatch';
    setPastTime([headlineSubId]);
    await runCycle(true);
    const vCandidate = db.prepare('SELECT count(*) as c FROM monitor_versions WHERE subscription_id = ?').get(headlineSubId) as { c: number };
    const stateCand = db.prepare('SELECT pending_candidate_checks FROM sub_state WHERE subscription_id = ?').get(headlineSubId) as { pending_candidate_checks: number };
    if (vCandidate.c !== 1 || stateCand.pending_candidate_checks !== 1) throw new Error('Candidate check failed to record pending state');
    log('  ✓ Candidate change observed on check 1 (pending candidate recorded, 0 alerts sent)');

    setPastTime([headlineSubId]);
    await runCycle(true);
    const v2Count = db.prepare('SELECT count(*) as c FROM monitor_versions WHERE subscription_id = ?').get(headlineSubId) as { c: number };
    const e1Count = db.prepare("SELECT count(*) as c FROM change_events WHERE subscription_id = ? AND event_type = 'CHANGE'").get(headlineSubId) as { c: number };
    const outboxCount = db.prepare('SELECT count(*) as c FROM notification_outbox').get() as { c: number };
    if (v2Count.c !== 2 || e1Count.c !== 1 || outboxCount.c < 1) throw new Error(`Confirmation check failed: versions=${v2Count.c}, events=${e1Count.c}`);
    log('  ✓ Version 2 confirmed on consecutive check with exactly 1 CHANGE alert in outbox');

    // 2. NOISE NORMALIZATION SUPPRESSION (Clock, Counter, Token produce 0 alerts)
    log('\n[2/4] Testing Noise Normalization Suppression (/demo/clock, /demo/counter, /demo/token)...');
    const { subId: clockSub } = setupTargetAndSub(db, userId, 'http://127.0.0.1:4000/demo/clock', 'Clock Monitor');
    const { subId: counterSub } = setupTargetAndSub(db, userId, 'http://127.0.0.1:4000/demo/counter', 'Counter Monitor');
    const { subId: tokenSub } = setupTargetAndSub(db, userId, 'http://127.0.0.1:4000/demo/token', 'Token Monitor');

    await runCycle(true);

    for (let cycle = 1; cycle <= 3; cycle++) {
      setPastTime([clockSub, counterSub, tokenSub]);
      await runCycle(true);
    }

    const clockV = db.prepare('SELECT count(*) as c FROM monitor_versions WHERE subscription_id = ?').get(clockSub) as { c: number };
    const counterV = db.prepare('SELECT count(*) as c FROM monitor_versions WHERE subscription_id = ?').get(counterSub) as { c: number };
    const tokenV = db.prepare('SELECT count(*) as c FROM monitor_versions WHERE subscription_id = ?').get(tokenSub) as { c: number };
    const noiseEvents = db.prepare('SELECT count(*) as c FROM change_events WHERE subscription_id IN (?, ?, ?)').get(clockSub, counterSub, tokenSub) as { c: number };

    if (clockV.c !== 1 || counterV.c !== 1 || tokenV.c !== 1 || noiseEvents.c !== 0) {
      throw new Error(`Noise test failed: clock=${clockV.c}, counter=${counterV.c}, token=${tokenV.c}, events=${noiseEvents.c}`);
    }
    log('  ✓ Clock, Counter, and Token fixtures: 4 checks each created exactly 1 baseline version and 0 alerts');

    // 3. OUTAGE & CAPTCHA ISOLATION (ERROR and BLOCKED leave baselines untouched)
    log('\n[3/4] Testing Outage & CAPTCHA Isolation (/demo/503 and /demo/captcha)...');
    const { subId: errSub } = setupTargetAndSub(db, userId, 'http://127.0.0.1:4000/demo/503', '503 Monitor');
    const { subId: capSub } = setupTargetAndSub(db, userId, 'http://127.0.0.1:4000/demo/captcha', 'Captcha Monitor');

    await runCycle(true);

    const errV = db.prepare('SELECT count(*) as c FROM monitor_versions WHERE subscription_id = ?').get(errSub) as { c: number };
    const capV = db.prepare('SELECT count(*) as c FROM monitor_versions WHERE subscription_id = ?').get(capSub) as { c: number };
    if (errV.c !== 0 || capV.c !== 0) throw new Error('Outage/CAPTCHA incorrectly created versions');
    log('  ✓ 503 Service Unavailable and Fake CAPTCHA leave baseline and versions completely untouched');

    // 4. OUTAGE ALERT & RECOVERY FLOW (3 failures -> DOWN alert -> recovery -> RECOVERED alert)
    log('\n[4/4] Testing Outage Alert & Recovery Flow (Threshold = 3)...');
    const { subId: outageSub } = setupTargetAndSub(db, userId, 'http://127.0.0.1:4000/demo/stable', 'Outage Monitor');
    await runCycle(true);

    recordCheckFailure(db, outageSub, 'http_503');
    recordCheckFailure(db, outageSub, 'http_503');
    recordCheckFailure(db, outageSub, 'http_503');

    const stateDown = db.prepare('SELECT is_currently_down, consecutive_failures FROM sub_state WHERE subscription_id = ?').get(outageSub) as { is_currently_down: number; consecutive_failures: number };
    const downEvent = db.prepare("SELECT count(*) as c FROM change_events WHERE subscription_id = ? AND event_type = 'DOWN'").get(outageSub) as { c: number };
    if (stateDown.is_currently_down !== 1 || stateDown.consecutive_failures < 3 || downEvent.c !== 1) {
      throw new Error(`Outage failure flow failed: is_down=${stateDown.is_currently_down}, failures=${stateDown.consecutive_failures}, downEvents=${downEvent.c}`);
    }
    log(`  ✓ 3 consecutive failures triggered DOWN event (consecutive_failures=${stateDown.consecutive_failures})`);

    // Recovery check against /demo/stable
    setPastTime([outageSub]);
    await runCycle(true);

    const stateRec = db.prepare('SELECT is_currently_down, consecutive_failures FROM sub_state WHERE subscription_id = ?').get(outageSub) as { is_currently_down: number; consecutive_failures: number };
    const recEvent = db.prepare("SELECT count(*) as c FROM change_events WHERE subscription_id = ? AND event_type = 'RECOVERED'").get(outageSub) as { c: number };
    if (stateRec.is_currently_down !== 0 || stateRec.consecutive_failures !== 0 || recEvent.c !== 1) {
      throw new Error(`Recovery flow failed: is_down=${stateRec.is_currently_down}, failures=${stateRec.consecutive_failures}, recEvents=${recEvent.c}`);
    }
    log('  ✓ Subsequent OK check triggered RECOVERED event and reset failure counters to 0');

    log('\n======================================================================');
    log('ALL 4 SMOKE TEST SUITE CRITERIA PASSED SUCCESSFULLY!');
    log(`Finished at: ${new Date().toISOString()}`);
    log('======================================================================');

    fs.writeFileSync(path.resolve(evidenceDir, 'smoke-results.txt'), results.join('\n'), 'utf-8');
    process.exitCode = 0;
  } catch (err) {
    console.error('\n[SMOKE FAILURE]', err);
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

runSmokeTests();
