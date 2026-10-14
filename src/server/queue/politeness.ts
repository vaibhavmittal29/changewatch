import { env } from '../config.js';

/**
 * Domain Politeness Manager
 *
 * Enforces politeness rules across all web captures:
 * 1. At most one active top-level navigation per domain at a time (domain lock).
 * 2. Minimum quiet period (DOMAIN_GAP_MS) between top-level navigations to the same domain.
 * 3. Jitter calculation (±10%) to prevent synchronized periodic hammering.
 * 4. Retry-After header parsing capped at 1 hour (3600s).
 */
export class PolitenessManager {
  private activeDomains = new Set<string>();
  private lastFetchedAt = new Map<string, number>();

  constructor(
    private readonly defaultGapMs: number = env.DOMAIN_GAP_MS,
    private readonly allowLocalDemo: boolean = env.ALLOW_LOCAL_DEMO
  ) {}

  /**
   * Returns effective gap required for a given hostname.
   * If local demo is enabled and hostname is localhost / 127.0.0.1, gap can be bypassed (0ms)
   * to ensure rapid test execution.
   */
  public getDomainGapMs(hostname: string): number {
    if (this.allowLocalDemo && (hostname === 'localhost' || hostname === '127.0.0.1')) {
      return 0;
    }
    return this.defaultGapMs;
  }

  /**
   * Checks whether the domain is currently eligible for navigation.
   */
  public canFetchDomain(hostname: string, now: number = Date.now()): boolean {
    const normalized = hostname.toLowerCase();
    if (this.activeDomains.has(normalized)) {
      return false;
    }
    const lastFetch = this.lastFetchedAt.get(normalized) ?? 0;
    const gap = this.getDomainGapMs(normalized);
    return now - lastFetch >= gap;
  }

  /**
   * Attempts to acquire exclusive navigation lock for the domain.
   * Returns true if lock was acquired, false if domain is busy or within quiet period.
   */
  public acquireDomain(hostname: string, now: number = Date.now()): boolean {
    const normalized = hostname.toLowerCase();
    if (!this.canFetchDomain(normalized, now)) {
      return false;
    }
    this.activeDomains.add(normalized);
    return true;
  }

  /**
   * Releases domain navigation lock and records completion timestamp.
   */
  public releaseDomain(hostname: string, completedAt: number = Date.now()): void {
    const normalized = hostname.toLowerCase();
    this.activeDomains.delete(normalized);
    this.lastFetchedAt.set(normalized, completedAt);
  }

  /**
   * Returns current active domains count.
   */
  public getActiveCount(): number {
    return this.activeDomains.size;
  }

  /**
   * Seeds initial last-fetch timestamp for a domain (e.g. from database targets.last_fetched_at).
   */
  public seedLastFetched(hostname: string, timestamp: number): void {
    const normalized = hostname.toLowerCase();
    this.lastFetchedAt.set(normalized, timestamp);
  }

  /**
   * Calculates interval with random jitter: baseMs ± (baseMs * pct).
   * Default jitter ratio is ±10%.
   */
  public static addJitter(baseMs: number, pct: number = 0.1): number {
    const factor = 1 + (Math.random() * 2 - 1) * pct;
    return Math.max(0, Math.round(baseMs * factor));
  }

  /**
   * Parses HTTP Retry-After header (either seconds or RFC-2822/ISO HTTP-date).
   * Result is returned in milliseconds, capped at 1 hour (3600000 ms).
   */
  public static parseRetryAfter(headerValue?: string | null, now: number = Date.now()): number {
    if (!headerValue) return 0;
    const trimmed = headerValue.trim();

    // Case 1: Integer seconds
    const seconds = parseInt(trimmed, 10);
    if (!isNaN(seconds) && String(seconds) === trimmed) {
      const ms = Math.max(0, seconds * 1000);
      return Math.min(ms, 3600 * 1000);
    }

    // Case 2: HTTP-date string
    const parsedDate = Date.parse(trimmed);
    if (!isNaN(parsedDate)) {
      const diffMs = Math.max(0, parsedDate - now);
      return Math.min(diffMs, 3600 * 1000);
    }

    return 0;
  }
}

export const politeness = new PolitenessManager();
