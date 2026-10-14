import { describe, it, expect } from 'vitest';
import { PolitenessManager } from '../../src/server/queue/politeness.js';

describe('Phase 3 Unit: PolitenessManager (Acceptance Matrix F)', () => {
  it('enforces single concurrent navigation per domain (domain lock)', () => {
    const pm = new PolitenessManager(10_000, false);
    const domain = 'example.com';

    // First acquire succeeds
    expect(pm.canFetchDomain(domain)).toBe(true);
    expect(pm.acquireDomain(domain)).toBe(true);

    // Second acquire for same domain is blocked while active
    expect(pm.canFetchDomain(domain)).toBe(false);
    expect(pm.acquireDomain(domain)).toBe(false);

    // Different domain is allowed
    expect(pm.canFetchDomain('other.org')).toBe(true);
    expect(pm.acquireDomain('other.org')).toBe(true);

    // Release first domain
    pm.releaseDomain(domain, Date.now());
    pm.releaseDomain('other.org', Date.now());
  });

  it('enforces minimum quiet period (domain gap) after release', () => {
    const gapMs = 10_000;
    const pm = new PolitenessManager(gapMs, false);
    const domain = 'api.example.com';
    const now = 100_000;

    // Acquire and release at t = 100_000
    expect(pm.acquireDomain(domain, now)).toBe(true);
    pm.releaseDomain(domain, now);

    // At t = 105_000 (5s later, gap is 10s): blocked
    expect(pm.canFetchDomain(domain, now + 5000)).toBe(false);
    expect(pm.acquireDomain(domain, now + 5000)).toBe(false);

    // At t = 109_999 (9.999s later): blocked
    expect(pm.canFetchDomain(domain, now + 9999)).toBe(false);

    // At t = 110_000 (exact gap reached): allowed
    expect(pm.canFetchDomain(domain, now + 10_000)).toBe(true);
    expect(pm.acquireDomain(domain, now + 10_000)).toBe(true);
  });

  it('allows local demo origin to bypass domain gap when allowLocalDemo is true', () => {
    const pm = new PolitenessManager(10_000, true);
    const now = 100_000;

    expect(pm.acquireDomain('localhost', now)).toBe(true);
    pm.releaseDomain('localhost', now);

    // Localhost can be immediately re-acquired (gap = 0ms for fast test execution)
    expect(pm.canFetchDomain('localhost', now + 1)).toBe(true);
    expect(pm.acquireDomain('localhost', now + 1)).toBe(true);
  });

  it('computes jitter strictly within ±10% bounds', () => {
    const base = 60_000;
    for (let i = 0; i < 50; i++) {
      const withJitter = PolitenessManager.addJitter(base, 0.1);
      expect(withJitter).toBeGreaterThanOrEqual(base * 0.9);
      expect(withJitter).toBeLessThanOrEqual(base * 1.1);
    }
  });

  it('parses Retry-After headers in seconds and HTTP dates, capping at 1 hour', () => {
    // Integer seconds
    expect(PolitenessManager.parseRetryAfter('120')).toBe(120_000);
    expect(PolitenessManager.parseRetryAfter('0')).toBe(0);

    // Clamps excessive seconds to 1 hour (3,600,000 ms)
    expect(PolitenessManager.parseRetryAfter('86400')).toBe(3_600_000);

    // HTTP-date string
    const now = Date.now();
    const futureDate = new Date(now + 45_000).toUTCString();
    const parsedMs = PolitenessManager.parseRetryAfter(futureDate, now);
    expect(parsedMs).toBeGreaterThanOrEqual(44_000);
    expect(parsedMs).toBeLessThanOrEqual(46_000);

    // Empty or invalid headers
    expect(PolitenessManager.parseRetryAfter(null)).toBe(0);
    expect(PolitenessManager.parseRetryAfter('')).toBe(0);
    expect(PolitenessManager.parseRetryAfter('invalid-string')).toBe(0);
  });
});
