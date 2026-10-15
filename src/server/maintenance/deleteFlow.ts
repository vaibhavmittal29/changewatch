import fs from 'node:fs';
import { getDb } from '../db/index.js';

interface DeleteResult {
  deletedSubscriptionId: string;
  orphanedObservationsCleaned: number;
  screenshotsRemoved: number;
  targetDeleted: boolean;
}

/**
 * Executes cascading deletion of a subscription, its orphaned observations,
 * screenshot files on disk, and the parent target if no other subscriptions watch it.
 * (Fulfills Requirement Z2).
 */
export function deleteSubscriptionCascade(subscriptionId: string, userId: string): DeleteResult | null {
  const db = getDb();

  // 1. Verify existence and ownership
  const sub = db.prepare(`
    SELECT id, target_id FROM subscriptions
    WHERE id = ? AND user_id = ?
  `).get(subscriptionId, userId) as { id: string; target_id: string } | undefined;

  if (!sub) {
    return null;
  }

  const { target_id: targetId } = sub;

  // 2. Perform database deletion within transaction
  const orphanRows = db.transaction(() => {
    // Delete the subscription (cascades sub_state, monitor_versions, change_events, check_runs)
    db.prepare('DELETE FROM subscriptions WHERE id = ?').run(subscriptionId);

    // Identify observations for targetId that no longer have any active references
    const orphans = db.prepare(`
      SELECT id, screenshot_path FROM observations
      WHERE target_id = ?
        AND NOT EXISTS (SELECT 1 FROM monitor_versions v WHERE v.observation_id = observations.id)
        AND NOT EXISTS (SELECT 1 FROM sub_state s WHERE s.pending_observation_id = observations.id)
    `).all(targetId) as Array<{ id: string; screenshot_path: string | null }>;

    if (orphans.length > 0) {
      const orphanIds = orphans.map(o => o.id);
      const placeholders = orphanIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM observations WHERE id IN (${placeholders})`).run(...orphanIds);
    }

    // Check if any other subscriptions still monitor this target
    const remaining = db.prepare('SELECT COUNT(*) as count FROM subscriptions WHERE target_id = ?').get(targetId) as { count: number };
    let targetDeleted = false;
    if (remaining.count === 0) {
      db.prepare('DELETE FROM targets WHERE id = ?').run(targetId);
      targetDeleted = true;
    }

    return { orphans, targetDeleted };
  })();

  // 3. Unlink screenshot files from disk outside transaction
  let screenshotsRemoved = 0;
  for (const orphan of orphanRows.orphans) {
    if (orphan.screenshot_path && fs.existsSync(orphan.screenshot_path)) {
      try {
        fs.unlinkSync(orphan.screenshot_path);
        screenshotsRemoved++;
      } catch (err) {
        console.warn(`Failed to unlink screenshot ${orphan.screenshot_path}:`, err);
      }
    }
  }

  return {
    deletedSubscriptionId: subscriptionId,
    orphanedObservationsCleaned: orphanRows.orphans.length,
    screenshotsRemoved,
    targetDeleted: orphanRows.targetDeleted,
  };
}

/**
 * Deletes all subscriptions belonging to a user using deleteSubscriptionCascade,
 * then removes the user account and associated notification destinations.
 */
export function deleteUserAccount(userId: string): { subscriptionsDeleted: number } {
  const db = getDb();
  const subs = db.prepare('SELECT id FROM subscriptions WHERE user_id = ?').all(userId) as Array<{ id: string }>;

  for (const sub of subs) {
    deleteSubscriptionCascade(sub.id, userId);
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  return { subscriptionsDeleted: subs.length };
}
