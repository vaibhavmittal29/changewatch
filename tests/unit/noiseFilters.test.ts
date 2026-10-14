import { describe, it, expect } from 'vitest';
import { applyNoiseFilters } from '../../src/server/engine/noiseFilters.js';
import { normalizeText, hashContent } from '../../src/server/engine/normalize.js';

describe('Phase 5 Unit: Noise Filters (Acceptance Matrix N)', () => {
  it('filters various timestamp formats into a stable placeholder', () => {
    const samples = [
      'Current time: 12:45 PM in New York',
      'Server time: 14:05:33 UTC',
      'Published on 2026-10-14 by author',
      'Meeting scheduled for 14 Oct 2026',
      'Event on October 14, 2026 at the arena',
      'Post updated 5 minutes ago',
      'Article posted yesterday',
      'System status updated today',
      'Heartbeat: 2026-10-14T19:05:33.123Z',
      'Timestamp: 1728935133000 ms',
    ];

    for (const text of samples) {
      const filtered = applyNoiseFilters(text, { timestamps: true });
      expect(filtered).toContain('[TIMESTAMP]');
    }
  });

  it('filters dynamic counters, likes, and viewer counts into a stable placeholder', () => {
    const samples = [
      'This article has 1,234 views so far.',
      'Over 12k likes on this post!',
      'Leave feedback: 3 comments',
      'Live stats: Online now: 57',
      'There are currently 15 users online',
    ];

    for (const text of samples) {
      const filtered = applyNoiseFilters(text, { counters: true });
      expect(filtered).toContain('[COUNTER]');
    }
  });

  it('filters UUIDs, hashes, and session tokens into a stable placeholder', () => {
    const samples = [
      'Request ID: 123e4567-e89b-12d3-a456-426614174000',
      'Commit: 4a3b2c1d9e8f7a6b5c4d3e2f1a0b9c8d',
      'Form action csrf_token="a1b2c3d4e5f6g7h8"',
      'Session token session_id="abc123xyz890"',
    ];

    for (const text of samples) {
      const filtered = applyNoiseFilters(text, { tokens: true });
      expect(filtered).toContain('[TOKEN]');
    }
  });

  it('filters dynamic copyright year declarations', () => {
    const samples = [
      'Copyright © 2026 ChangeWatch Corp',
      'Copyright 2020-2026 All Rights Reserved',
      '(C) 2026 Open Source Project',
    ];

    for (const text of samples) {
      const filtered = applyNoiseFilters(text, { copyright: true });
      expect(filtered).toContain('[COPYRIGHT]');
    }
  });

  it('removes lines matching learned ignore patterns', () => {
    const content = `
      Important Headline
      Rotating promotion banner: Buy now!
      Product description paragraph.
      Daily quote of the day: Carpe Diem
    `;

    const learned = ['Rotating promotion banner', '/quote of the day/'];
    const filtered = applyNoiseFilters(content, {}, learned);

    expect(filtered).toContain('Important Headline');
    expect(filtered).toContain('Product description paragraph.');
    expect(filtered).not.toContain('Rotating promotion banner');
    expect(filtered).not.toContain('quote of the day');
  });

  it('produces identical normalized content hashes for clock and counter variations', () => {
    const pageAt10am = `
      System Status: Normal
      Current Time: 10:00:00 AM
      Total Views: 1,500 views
      Copyright © 2026 ChangeWatch
    `;

    const pageAt2pm = `
      System Status: Normal
      Current Time: 02:00:00 PM
      Total Views: 1,842 views
      Copyright © 2026 ChangeWatch
    `;

    const hash1 = hashContent(normalizeText(pageAt10am, { timestamps: true, counters: true, copyright: true }));
    const hash2 = hashContent(normalizeText(pageAt2pm, { timestamps: true, counters: true, copyright: true }));

    expect(hash1).toBe(hash2);
  });
});
