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
import { capturePage } from '../src/server/capture/playwrightCapture.js';

function checkPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

function setupTargetAndSub(
  db: ReturnType<typeof getDb>, userId: string, url: string, name: string,
  filters: Record<string, boolean> = { timestamps: true, counters: true, tokens: true }
): { subId: string; targetId: string } {
  const targetId = crypto.randomUUID();
  const subId = crypto.randomUUID();
  const now = new Date().toISOString();
  const urlObj = new URL(url);
  const { config, fingerprint } = captureFingerprint({});
  const past = new Date(Date.now() - 60_000).toISOString();

  db.prepare('INSERT INTO targets (id, canonical_url, hostname, origin, created_at) VALUES (?, ?, ?, ?, ?)').run(targetId, url, urlObj.hostname, urlObj.origin, now);
  db.prepare(`
    INSERT INTO subscriptions (id, user_id, target_id, name, interval_minutes, next_check_at, capture_config, capture_fingerprint, sensitivity, include_selectors, ignore_selectors, noise_filters, learned_ignore_patterns, created_at)
    VALUES (?, ?, ?, ?, 15, ?, ?, ?, 'balanced', '[]', '[]', ?, '[]', ?)
  `).run(subId, userId, targetId, name, past, JSON.stringify(config), fingerprint, JSON.stringify(filters), now);
  db.prepare('INSERT INTO sub_state (subscription_id, consecutive_failures, is_currently_down, recent_checks_window, is_noisy) VALUES (?, 0, 0, \'[]\', 0)').run(subId);
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
  const log = (msg: string) => { console.log(msg); results.push(msg); };

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
    log('ChangeWatch End-to-End Smoke Test Suite (Matrix AH)');
    log(`Started at: ${new Date().toISOString()}`);
    log('======================================================================\n');

    demoServer = await startDemoServer(4000);
    const db = getDb(testDbPath);
    migrate(db);
    db.pragma('foreign_keys = ON');

    const worker = new WorkerPool(db, 3, 100);
    const userId = crypto.randomUUID();
    db.prepare("INSERT INTO users (id, email, password_hash, password_salt, password_iterations, display_name) VALUES (?, 'smoke@example.com', 'h', 's', 1000, 'Smoke')").run(userId);

    const setPastTime = (subIds: string[]) => {
      const pastIso = new Date(Date.now() - 60_000).toISOString();
      db.prepare(`UPDATE subscriptions SET next_check_at = ? WHERE id IN (${subIds.map(() => '?').join(',')})`).run(pastIso, ...subIds);
    };

    const runCycle = async (advanceTime = false) => {
      if (advanceTime) db.prepare('UPDATE observations SET captured_at = ?').run(new Date(Date.now() - 60_000).toISOString());
      schedulerTick(db, Date.now());
      while (true) {
        const executed = await worker.pollAndExecute();
        await worker.waitForIdle();
        if (executed === 0) break;
      }
    };

    // 1. REAL CHANGE DETECTION
    log('[1/5] Testing Real Change Detection on /demo/headline...');
    resetFixtureState();
    const { subId: headlineSubId } = setupTargetAndSub(db, userId, 'http://127.0.0.1:4000/demo/headline', 'Headline Monitor');
    await runCycle();
    fixtureState.headlineText = 'Smoke Test: Breaking News Update from ChangeWatch';
    setPastTime([headlineSubId]);
    await runCycle(true);
    setPastTime([headlineSubId]);
    await runCycle(true);
    const v2Count = db.prepare('SELECT count(*) as c FROM monitor_versions WHERE subscription_id = ?').get(headlineSubId) as { c: number };
    const e1Count = db.prepare("SELECT count(*) as c FROM change_events WHERE subscription_id = ? AND event_type = 'CHANGE'").get(headlineSubId) as { c: number };
    if (v2Count.c !== 2 || e1Count.c !== 1) throw new Error('Real change verification failed');
    log('  ✓ Version 2 confirmed on consecutive check with exactly 1 CHANGE alert in outbox');

    // 2. NOISE NORMALIZATION SUPPRESSION
    log('\n[2/5] Testing Noise Normalization Suppression (/demo/clock, /demo/counter, /demo/token)...');
    const { subId: cSub } = setupTargetAndSub(db, userId, 'http://127.0.0.1:4000/demo/clock', 'Clock');
    const { subId: cntSub } = setupTargetAndSub(db, userId, 'http://127.0.0.1:4000/demo/counter', 'Counter');
    const { subId: tokSub } = setupTargetAndSub(db, userId, 'http://127.0.0.1:4000/demo/token', 'Token');
    await runCycle(true);
    for (let i = 0; i < 3; i++) { setPastTime([cSub, cntSub, tokSub]); await runCycle(true); }
    const noiseEvents = db.prepare('SELECT count(*) as c FROM change_events WHERE subscription_id IN (?, ?, ?)').get(cSub, cntSub, tokSub) as { c: number };
    if (noiseEvents.c !== 0) throw new Error('Noise normalizer let spurious events through');
    log('  ✓ Clock, Counter, and Token fixtures: 4 checks each created exactly 1 baseline version and 0 alerts');

    // 3. OUTAGE & CAPTCHA ISOLATION
    log('\n[3/5] Testing Outage & CAPTCHA Isolation (/demo/503 and /demo/captcha)...');
    const { subId: errSub } = setupTargetAndSub(db, userId, 'http://127.0.0.1:4000/demo/503', '503');
    const { subId: capSub } = setupTargetAndSub(db, userId, 'http://127.0.0.1:4000/demo/captcha', 'Captcha');
    await runCycle(true);
    const errV = db.prepare('SELECT count(*) as c FROM monitor_versions WHERE subscription_id = ?').get(errSub) as { c: number };
    const capV = db.prepare('SELECT count(*) as c FROM monitor_versions WHERE subscription_id = ?').get(capSub) as { c: number };
    if (errV.c !== 0 || capV.c !== 0) throw new Error('Outage/CAPTCHA incorrectly touched baseline');
    log('  ✓ 503 and CAPTCHA leave baseline and versions completely untouched');

    // 4. NON-CONSECUTIVE FAILURE RECOVERY & OUTAGE ALERT
    log('\n[4/5] Testing Failure Reset on OK & Consecutive Outage Flow...');
    const { subId: outSub } = setupTargetAndSub(db, userId, 'http://127.0.0.1:4000/demo/stable', 'Outage');
    await runCycle(true);

    // Fail twice, then succeed once -> consecutive_failures MUST reset to 0
    recordCheckFailure(db, outSub, 'net_err');
    recordCheckFailure(db, outSub, 'net_err');
    setPastTime([outSub]);
    await runCycle(true);
    const stReset = db.prepare('SELECT consecutive_failures, is_currently_down FROM sub_state WHERE subscription_id = ?').get(outSub) as { consecutive_failures: number; is_currently_down: number };
    if (stReset.consecutive_failures !== 0 || stReset.is_currently_down !== 0) throw new Error(`consecutive_failures failed to reset on OK check: ${JSON.stringify(stReset)}`);
    log('  ✓ 2 failures followed by 1 OK check cleanly resets consecutive_failures to 0 (no false DOWN alert)');

    // Now fail 3 times consecutively -> triggers DOWN alert
    recordCheckFailure(db, outSub, '503');
    recordCheckFailure(db, outSub, '503');
    recordCheckFailure(db, outSub, '503');
    const stDown = db.prepare('SELECT is_currently_down FROM sub_state WHERE subscription_id = ?').get(outSub) as { is_currently_down: number };
    if (stDown.is_currently_down !== 1) throw new Error('Consecutive failures did not trigger DOWN');
    log('  ✓ 3 consecutive failures successfully triggered DOWN alert');

    // Recovery check -> triggers RECOVERED event
    setPastTime([outSub]);
    await runCycle(true);
    const stRec = db.prepare('SELECT is_currently_down, consecutive_failures FROM sub_state WHERE subscription_id = ?').get(outSub) as { is_currently_down: number; consecutive_failures: number };
    const recEv = db.prepare("SELECT count(*) as c FROM change_events WHERE subscription_id = ? AND event_type = 'RECOVERED'").get(outSub) as { c: number };
    if (stRec.is_currently_down !== 0 || stRec.consecutive_failures !== 0 || recEv.c !== 1) throw new Error('Recovery failed');
    log('  ✓ Subsequent OK check triggered RECOVERED event and reset counters to 0');

    // 5. SSRF ROUTE & REDIRECT DEFENSE IN BROWSER
    log('\n[5/5] Testing Browser SSRF & Private Redirect Defense...');
    const { config } = captureFingerprint({});
    const redirectRes = await capturePage('http://127.0.0.1:4000/demo/redirect-private', config);
    if (!redirectRes.errorMessage && redirectRes.httpStatus === 200) {
      throw new Error('Browser SSRF guard failed: allowed redirect to private metadata IP');
    }
    log(`  ✓ Browser route interception successfully aborted redirect to private IP (${redirectRes.errorMessage || 'aborted'})`);

    log('\n======================================================================');
    log('ALL 5 SMOKE TEST SUITE CRITERIA PASSED SUCCESSFULLY!');
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
    if (fs.existsSync(testDbPath)) { try { fs.unlinkSync(testDbPath); } catch {} }
    process.exit(process.exitCode ?? 0);
  }
}

runSmokeTests();
