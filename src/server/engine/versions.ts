import crypto from 'node:crypto';
import type { Database } from 'better-sqlite3';

export interface MonitorVersionRow {
  id: string;
  subscription_id: string;
  observation_id: string;
  version_number: number;
  content_hash: string;
  stored_text: string;
  change_summary: string | null;
  created_at: string;
}

/**
 * Retrieves the currently active version for a given subscription.
 */
export function getActiveVersion(
  db: Database,
  subscriptionId: string
): MonitorVersionRow | null {
  const row = db.prepare(`
    SELECT mv.*
    FROM sub_state ss
    JOIN monitor_versions mv ON mv.id = ss.active_version_id
    WHERE ss.subscription_id = ?
  `).get(subscriptionId) as MonitorVersionRow | undefined;

  return row ?? null;
}

/**
 * Creates Version 1 (Baseline) for a subscription and sets it as the active version.
 */
export function createBaselineVersion(
  db: Database,
  subscriptionId: string,
  observationId: string,
  storedText: string,
  contentHash: string,
  nowIso: string = new Date().toISOString()
): MonitorVersionRow {
  const versionId = crypto.randomUUID();

  const insertTx = db.transaction(() => {
    const version: MonitorVersionRow = {
      id: versionId,
      subscription_id: subscriptionId,
      observation_id: observationId,
      version_number: 1,
      content_hash: contentHash,
      stored_text: storedText,
      change_summary: 'Baseline (Version 1)',
      created_at: nowIso,
    };

    db.prepare(`
      INSERT INTO monitor_versions (
        id, subscription_id, observation_id, version_number,
        content_hash, stored_text, change_summary, created_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      version.id, version.subscription_id, version.observation_id,
      version.content_hash, version.stored_text, version.change_summary, version.created_at
    );

    db.prepare(`
      INSERT INTO sub_state (subscription_id, active_version_id)
      VALUES (?, ?)
      ON CONFLICT(subscription_id) DO UPDATE SET
        active_version_id = excluded.active_version_id
    `).run(subscriptionId, versionId);

    return version;
  });

  return insertTx();
}

/**
 * Commits a new version (Version N+1) for a subscription when a confirmed change is detected.
 */
export function commitNextVersion(
  db: Database,
  subscriptionId: string,
  observationId: string,
  storedText: string,
  contentHash: string,
  changeSummary: string = 'Content updated',
  nowIso: string = new Date().toISOString()
): MonitorVersionRow {
  const versionId = crypto.randomUUID();

  const commitTx = db.transaction(() => {
    // Find current max version number
    const maxRow = db.prepare(`
      SELECT MAX(version_number) as max_v
      FROM monitor_versions
      WHERE subscription_id = ?
    `).get(subscriptionId) as { max_v: number | null };

    const nextVersionNumber = (maxRow.max_v ?? 0) + 1;

    const version: MonitorVersionRow = {
      id: versionId,
      subscription_id: subscriptionId,
      observation_id: observationId,
      version_number: nextVersionNumber,
      content_hash: contentHash,
      stored_text: storedText,
      change_summary: changeSummary,
      created_at: nowIso,
    };

    db.prepare(`
      INSERT INTO monitor_versions (
        id, subscription_id, observation_id, version_number,
        content_hash, stored_text, change_summary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      version.id, version.subscription_id, version.observation_id,
      version.version_number, version.content_hash, version.stored_text,
      version.change_summary, version.created_at
    );

    db.prepare(`
      UPDATE sub_state
      SET active_version_id = ?
      WHERE subscription_id = ?
    `).run(versionId, subscriptionId);

    return version;
  });

  return commitTx();
}

/**
 * Retrieves the full version history for a subscription ordered newest first.
 */
export function getVersionHistory(
  db: Database,
  subscriptionId: string
): MonitorVersionRow[] {
  return db.prepare(`
    SELECT * FROM monitor_versions
    WHERE subscription_id = ?
    ORDER BY version_number DESC
  `).all(subscriptionId) as MonitorVersionRow[];
}
