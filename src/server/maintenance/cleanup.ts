import fs from 'node:fs';
import { getDb } from '../db/index.js';
import { env } from '../config.js';

export interface RetentionCleanupResult {
  cutoffIso: string;
  prunedObservations: number;
  unlinkedScreenshots: number;
}

export function ensureOrphanCleanupTable(db = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orphan_cleanup_queue (
      file_path TEXT PRIMARY KEY,
      failed_attempts INTEGER NOT NULL DEFAULT 1,
      last_attempt_at TEXT NOT NULL
    );
  `);
}

export function recordFailedScreenshotUnlink(filePath: string, db = getDb()): void {
  try {
    ensureOrphanCleanupTable(db);
    db.prepare(`
      INSERT INTO orphan_cleanup_queue (file_path, failed_attempts, last_attempt_at)
      VALUES (?, 1, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        failed_attempts = failed_attempts + 1,
        last_attempt_at = excluded.last_attempt_at
    `).run(filePath, new Date().toISOString());
  } catch (err) {
    console.warn(`[cleanup] Failed to record orphan unlink failure for ${filePath}:`, err);
  }
}

export function retryFailedUnlinks(db = getDb()): number {
  ensureOrphanCleanupTable(db);
  const rows = db.prepare('SELECT file_path, failed_attempts FROM orphan_cleanup_queue').all() as Array<{ file_path: string; failed_attempts: number }>;
  let cleaned = 0;
  for (const row of rows) {
    if (!fs.existsSync(row.file_path)) {
      db.prepare('DELETE FROM orphan_cleanup_queue WHERE file_path = ?').run(row.file_path);
      cleaned++;
    } else {
      try {
        fs.unlinkSync(row.file_path);
        db.prepare('DELETE FROM orphan_cleanup_queue WHERE file_path = ?').run(row.file_path);
        cleaned++;
      } catch {
        db.prepare('UPDATE orphan_cleanup_queue SET failed_attempts = failed_attempts + 1, last_attempt_at = ? WHERE file_path = ?')
          .run(new Date().toISOString(), row.file_path);
      }
    }
  }
  return cleaned;
}

/**
 * Routine retention cleanup (Requirement Z).
 * Deletes observations older than OBSERVATION_RETENTION_DAYS (default 30 days)
 * that are NOT referenced by any confirmed monitor_version OR pending candidate sub_state.
 * Unlinks screenshot PNG files on disk.
 */
export function runRetentionCleanup(retentionDays = env.OBSERVATION_RETENTION_DAYS): RetentionCleanupResult {
  const db = getDb();
  retryFailedUnlinks(db);

  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  // 1. Identify unreferenced observations older than cutoff
  const rows = db.prepare(`
    SELECT id, screenshot_path FROM observations
    WHERE captured_at < ?
      AND NOT EXISTS (SELECT 1 FROM monitor_versions v WHERE v.observation_id = observations.id)
      AND NOT EXISTS (SELECT 1 FROM sub_state s WHERE s.pending_observation_id = observations.id)
  `).all(cutoffIso) as Array<{ id: string; screenshot_path: string | null }>;

  if (rows.length === 0) {
    return {
      cutoffIso,
      prunedObservations: 0,
      unlinkedScreenshots: 0,
    };
  }

  // 2. Delete database records in transaction
  const ids = rows.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM observations WHERE id IN (${placeholders})`).run(...ids);

  // 3. Unlink screenshot files from disk
  let unlinkedScreenshots = 0;
  for (const row of rows) {
    if (row.screenshot_path && fs.existsSync(row.screenshot_path)) {
      try {
        fs.unlinkSync(row.screenshot_path);
        unlinkedScreenshots++;
      } catch (err) {
        console.warn(`Retention cleanup: failed to unlink screenshot ${row.screenshot_path}:`, err);
        recordFailedScreenshotUnlink(row.screenshot_path, db);
      }
    }
  }

  return {
    cutoffIso,
    prunedObservations: rows.length,
    unlinkedScreenshots,
  };
}
