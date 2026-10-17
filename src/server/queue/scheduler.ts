import type { Database } from 'better-sqlite3';
import { env } from '../config.js';
import { enqueueCheckJob } from './jobs.js';
import { processDailyDigest } from '../notifications/digest.js';
import { runRetentionCleanup } from '../maintenance/cleanup.js';

export interface SchedulerTickResult {
  dueGroupsCount: number;
  jobsEnqueuedCount: number;
}

interface DueGroupRow {
  target_id: string;
  capture_fingerprint: string;
  due_count: number;
}

export function resolveTimezone(tz?: string): string {
  const candidate = tz || env.TZ || 'UTC';
  try {
    Intl.DateTimeFormat(undefined, { timeZone: candidate });
    return candidate;
  } catch {
    console.warn(`[SCHEDULER] Invalid timezone '${candidate}', falling back to UTC`);
    return 'UTC';
  }
}

export function getZonedDateAndHour(date: Date, tz: string): { dateStr: string; hour: number } {
  const resolvedTz = resolveTimezone(tz);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: resolvedTz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(date);
    const y = parts.find(p => p.type === 'year')?.value || '1970';
    const m = parts.find(p => p.type === 'month')?.value || '01';
    const d = parts.find(p => p.type === 'day')?.value || '01';
    const h = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
    return { dateStr: `${y}-${m}-${d}`, hour: h };
  } catch {
    return { dateStr: date.toISOString().slice(0, 10), hour: date.getUTCHours() };
  }
}

export function schedulerTick(db: Database, now: number = Date.now()): SchedulerTickResult {
  const nowIso = new Date(now).toISOString();
  const dueGroups = db.prepare(`
    SELECT target_id, capture_fingerprint, COUNT(*) as due_count
    FROM subscriptions
    WHERE is_paused = 0 AND next_check_at <= ?
    GROUP BY target_id, capture_fingerprint
  `).all(nowIso) as DueGroupRow[];

  let jobsEnqueuedCount = 0;
  for (const group of dueGroups) {
    const job = enqueueCheckJob(db, group.target_id, group.capture_fingerprint, nowIso);
    if (job) jobsEnqueuedCount++;
  }
  return { dueGroupsCount: dueGroups.length, jobsEnqueuedCount };
}

export interface SchedulerOptions {
  tickIntervalMs?: number;
  clock?: () => Date;
  timezone?: string;
  dailyDigestHandler?: (db: Database, dateStr: string) => void;
  retentionCleanupHandler?: (days: number) => void;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastDailyRunDate: string | null = null;
  private readonly tickIntervalMs: number;
  private readonly clock: () => Date;
  private readonly timezone: string;
  private readonly digestHandler: (db: Database, dateStr: string) => void;
  private readonly cleanupHandler: (days: number) => void;

  constructor(
    private readonly db: Database,
    optionsOrInterval?: number | SchedulerOptions,
    clock?: () => Date,
    timezone?: string
  ) {
    if (typeof optionsOrInterval === 'number') {
      this.tickIntervalMs = optionsOrInterval;
      this.clock = clock || (() => new Date());
      this.timezone = resolveTimezone(timezone);
      this.digestHandler = processDailyDigest;
      this.cleanupHandler = runRetentionCleanup;
    } else {
      const opts = optionsOrInterval || {};
      this.tickIntervalMs = opts.tickIntervalMs ?? env.TICK_MS;
      this.clock = opts.clock || clock || (() => new Date());
      this.timezone = resolveTimezone(opts.timezone || timezone);
      this.digestHandler = opts.dailyDigestHandler || processDailyDigest;
      this.cleanupHandler = opts.retentionCleanupHandler || runRetentionCleanup;
    }
  }

  public getTimezone(): string {
    return this.timezone;
  }

  public getLastDailyRunDate(): string | null {
    return this.lastDailyRunDate;
  }

  /**
   * Executes daily digest and retention tasks at or after DIGEST_HOUR in configured timezone.
   * Uses persistent daily_task_ledger in SQLite so restarts after DIGEST_HOUR (e.g. 09:30 when
   * DIGEST_HOUR=9) immediately catch up on first tick, while avoiding duplicate runs.
   */
  public checkDailyTasks(now?: Date): boolean {
    const currentDate = now || this.clock();
    const { dateStr, hour } = getZonedDateAndHour(currentDate, this.timezone);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_task_ledger (
        task_date TEXT PRIMARY KEY,
        completed_at TEXT NOT NULL
      );
    `);

    const alreadyRun = this.lastDailyRunDate === dateStr ||
      Boolean(this.db.prepare('SELECT task_date FROM daily_task_ledger WHERE task_date = ?').get(dateStr));

    if (hour >= env.DIGEST_HOUR && !alreadyRun) {
      try {
        this.digestHandler(this.db, dateStr);
        this.cleanupHandler(env.OBSERVATION_RETENTION_DAYS);
        this.db.prepare('INSERT OR REPLACE INTO daily_task_ledger (task_date, completed_at) VALUES (?, ?)')
          .run(dateStr, new Date().toISOString());
        this.lastDailyRunDate = dateStr;
        return true;
      } catch (err) {
        console.error('[SCHEDULER] Daily digest/retention error (will retry next tick):', err);
        return false;
      }
    }
    return false;
  }

  public tick(): SchedulerTickResult {
    const now = this.clock();
    const result = schedulerTick(this.db, now.getTime());
    this.checkDailyTasks(now);
    return result;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      this.tick();
    } catch (err) {
      console.error('[SCHEDULER] Initial tick error:', err);
    }
    this.timer = setInterval(() => {
      try {
        this.tick();
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
