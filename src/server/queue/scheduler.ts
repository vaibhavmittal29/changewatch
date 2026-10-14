import type { Database } from 'better-sqlite3';
import { env } from '../config.js';
import { enqueueCheckJob } from './jobs.js';

export interface SchedulerTickResult {
  dueGroupsCount: number;
  jobsEnqueuedCount: number;
}

interface DueGroupRow {
  target_id: string;
  capture_fingerprint: string;
  due_count: number;
}

/**
 * Runs a single scheduler tick:
 * 1. Selects unpaused subscriptions where next_check_at <= now.
 * 2. Groups them by (target_id, capture_fingerprint).
 * 3. Enqueues one CHECK job per group (unique active index prevents duplicate active jobs).
 */
export function schedulerTick(
  db: Database,
  now: number = Date.now()
): SchedulerTickResult {
  const nowIso = new Date(now).toISOString();

  // Group due subscriptions by target_id and capture_fingerprint
  const dueGroups = db.prepare(`
    SELECT target_id, capture_fingerprint, COUNT(*) as due_count
    FROM subscriptions
    WHERE is_paused = 0 AND next_check_at <= ?
    GROUP BY target_id, capture_fingerprint
  `).all(nowIso) as DueGroupRow[];

  let jobsEnqueuedCount = 0;

  for (const group of dueGroups) {
    const job = enqueueCheckJob(db, group.target_id, group.capture_fingerprint, nowIso);
    if (job) {
      jobsEnqueuedCount++;
    }
  }

  return {
    dueGroupsCount: dueGroups.length,
    jobsEnqueuedCount,
  };
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly db: Database,
    private readonly tickIntervalMs: number = env.TICK_MS
  ) {}

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Run immediate tick on start
    try {
      schedulerTick(this.db);
    } catch (err) {
      console.error('[SCHEDULER] Initial tick error:', err);
    }

    this.timer = setInterval(() => {
      try {
        schedulerTick(this.db);
      } catch (err) {
        console.error('[SCHEDULER] Periodic tick error:', err);
      }
    }, this.tickIntervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
  }

  public get running(): boolean {
    return this.isRunning;
  }
}
