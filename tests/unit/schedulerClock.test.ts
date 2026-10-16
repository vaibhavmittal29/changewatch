import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  Scheduler,
  resolveTimezone,
  getZonedDateAndHour,
} from '../../src/server/queue/scheduler.js';

describe('Phase 4 Unit: Scheduler Clock Injection, Timezone & Retry-Safe Daily Tasks', () => {
  const dummyDb = new Database(':memory:');

  beforeEach(() => {
    try {
      dummyDb.exec('DROP TABLE IF EXISTS daily_task_ledger');
    } catch {}
  });

  describe('Timezone Derivation & Resolution', () => {
    it('resolves valid timezones accurately', () => {
      expect(resolveTimezone('America/New_York')).toBe('America/New_York');
      expect(resolveTimezone('UTC')).toBe('UTC');
      expect(resolveTimezone('Asia/Tokyo')).toBe('Asia/Tokyo');
    });

    it('falls back to UTC on invalid timezone strings', () => {
      expect(resolveTimezone('Invalid/NonExistent_Zone')).toBe('UTC');
      expect(resolveTimezone('')).toBe('UTC');
    });

    it('extracts zoned date and hour accurately for different offsets', () => {
      // 2026-06-15T09:00:00Z -> 09:00 UTC, 05:00 EDT (America/New_York)
      const date = new Date('2026-06-15T09:00:00.000Z');
      const utc = getZonedDateAndHour(date, 'UTC');
      expect(utc).toEqual({ dateStr: '2026-06-15', hour: 9 });

      const ny = getZonedDateAndHour(date, 'America/New_York');
      expect(ny).toEqual({ dateStr: '2026-06-15', hour: 5 });

      const tokyo = getZonedDateAndHour(date, 'Asia/Tokyo');
      expect(tokyo).toEqual({ dateStr: '2026-06-15', hour: 18 });
    });
  });

  describe('DST Transitions, Leap Years, and Rollovers', () => {
    it('handles leap year rollover accurately (2028-02-28 -> 2028-02-29 -> 2028-03-01)', () => {
      const feb28 = new Date('2028-02-28T23:00:00.000Z');
      expect(getZonedDateAndHour(feb28, 'UTC').dateStr).toBe('2028-02-28');

      const leapDay = new Date('2028-02-29T00:00:00.000Z');
      expect(getZonedDateAndHour(leapDay, 'UTC').dateStr).toBe('2028-02-29');

      const march1 = new Date('2028-03-01T00:00:00.000Z');
      expect(getZonedDateAndHour(march1, 'UTC').dateStr).toBe('2028-03-01');
    });

    it('handles DST transitions in America/New_York (Spring forward)', () => {
      // March 8, 2026: 02:00 -> 03:00 EDT
      const beforeDst = new Date('2026-03-08T06:59:00.000Z'); // 01:59 EST
      const afterDst = new Date('2026-03-08T07:01:00.000Z');  // 03:01 EDT

      const zBefore = getZonedDateAndHour(beforeDst, 'America/New_York');
      const zAfter = getZonedDateAndHour(afterDst, 'America/New_York');

      expect(zBefore.hour).toBe(1);
      expect(zAfter.hour).toBe(3);
    });
  });

  describe('Clock Injection & Daily Task Idempotency', () => {
    it('triggers daily tasks when injected clock hits DIGEST_HOUR and skips duplicate runs on same day', () => {
      let simulatedTime = new Date('2026-10-15T08:00:00.000Z');
      const clock = () => simulatedTime;

      const digestMock = vi.fn();
      const cleanupMock = vi.fn();

      const scheduler = new Scheduler(dummyDb, {
        clock,
        timezone: 'UTC',
        dailyDigestHandler: digestMock,
        retentionCleanupHandler: cleanupMock,
      });

      // Hour 8: Not DIGEST_HOUR (9) -> does not run
      const ranAt8 = scheduler.checkDailyTasks();
      expect(ranAt8).toBe(false);
      expect(digestMock).toHaveBeenCalledTimes(0);

      // Advance clock to 9:00 UTC
      simulatedTime = new Date('2026-10-15T09:00:00.000Z');
      const ranAt9 = scheduler.checkDailyTasks();
      expect(ranAt9).toBe(true);
      expect(digestMock).toHaveBeenCalledTimes(1);
      expect(cleanupMock).toHaveBeenCalledTimes(1);
      expect(scheduler.getLastDailyRunDate()).toBe('2026-10-15');

      // Repeated tick at 9:30 UTC on the same day -> must NOT run twice (idempotent)
      simulatedTime = new Date('2026-10-15T09:30:00.000Z');
      const ranAt930 = scheduler.checkDailyTasks();
      expect(ranAt930).toBe(false);
      expect(digestMock).toHaveBeenCalledTimes(1);
      expect(cleanupMock).toHaveBeenCalledTimes(1);

      // Advance clock across day boundary to next day at 9:00 UTC -> runs again for new date
      simulatedTime = new Date('2026-10-16T09:00:00.000Z');
      const ranNextDay = scheduler.checkDailyTasks();
      expect(ranNextDay).toBe(true);
      expect(digestMock).toHaveBeenCalledTimes(2);
      expect(cleanupMock).toHaveBeenCalledTimes(2);
      expect(scheduler.getLastDailyRunDate()).toBe('2026-10-16');
    });
  });

  describe('Retry-Safety for Daily Tasks', () => {
    it('retries daily tasks on next tick if a previous tick failed with an error', () => {
      const simulatedTime = new Date('2026-10-15T09:00:00.000Z');
      const clock = () => simulatedTime;

      let shouldFail = true;
      const digestMock = vi.fn(() => {
        if (shouldFail) {
          throw new Error('Database temporarily locked');
        }
      });
      const cleanupMock = vi.fn();

      const scheduler = new Scheduler(dummyDb, {
        clock,
        timezone: 'UTC',
        dailyDigestHandler: digestMock,
        retentionCleanupHandler: cleanupMock,
      });

      // Tick 1: fails
      const ran1 = scheduler.checkDailyTasks();
      expect(ran1).toBe(false);
      expect(digestMock).toHaveBeenCalledTimes(1);
      // Crucial: lastDailyRunDate is NOT marked completed
      expect(scheduler.getLastDailyRunDate()).toBeNull();

      // Tick 2: transient error resolved -> retries and succeeds!
      shouldFail = false;
      const ran2 = scheduler.checkDailyTasks();
      expect(ran2).toBe(true);
      expect(digestMock).toHaveBeenCalledTimes(2);
      expect(cleanupMock).toHaveBeenCalledTimes(1);
      expect(scheduler.getLastDailyRunDate()).toBe('2026-10-15');

      // Tick 3: now marked complete, will not run again today
      const ran3 = scheduler.checkDailyTasks();
      expect(ran3).toBe(false);
      expect(digestMock).toHaveBeenCalledTimes(2);
    });
  });
});
