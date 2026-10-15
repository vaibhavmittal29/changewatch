import robotsParser from 'robots-parser';
import type { Database } from 'better-sqlite3';
import { safeFetch } from '../capture/safeFetch.js';

export interface RobotsCheckResult {
  allowed: boolean;
  reason?: 'robots_disallowed' | 'robots_unavailable';
  cached: boolean;
}

interface RobotsCacheRow {
  origin: string;
  raw_content: string;
  http_status: number;
  response_headers: string;
  cached_at: string;
  expires_at: string;
}

const ROBOTS_SUCCESS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours per RFC 9309 for valid responses
const ROBOTS_ERROR_CACHE_TTL_MS = 5 * 60 * 1000;          // 5 minutes for transient 5xx or network errors
const USER_AGENT_TOKEN = 'ChangeWatch';

/**
 * Extracts normalized origin (scheme://host[:port]) from a URL string.
 * Strictly separates http from https origins.
 */
export function getOriginFromUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Evaluates robots.txt rules for a target URL with database-backed 24-hour caching.
 */
export async function checkRobotsPermission(
  db: Database,
  targetUrl: string,
  now: number = Date.now()
): Promise<RobotsCheckResult> {
  const origin = getOriginFromUrl(targetUrl);
  const nowIso = new Date(now).toISOString();

  // 1. Check database cache
  const cached = db
    .prepare('SELECT * FROM robots_cache WHERE origin = ?')
    .get(origin) as RobotsCacheRow | undefined;

  if (cached && new Date(cached.expires_at).getTime() > now) {
    return evaluateCachedRobots(cached, targetUrl, true);
  }

  // 2. Fetch fresh robots.txt via safeFetch (IP-pinned & SSRF protected)
  const robotsUrl = `${origin}/robots.txt`;
  let rawContent = '';
  let httpStatus = 0;
  let headersJson = '{}';

  try {
    const res = await safeFetch(robotsUrl);
    httpStatus = res.status;
    rawContent = res.body;
    headersJson = JSON.stringify(res.headers);
  } catch {
    // Connection failure / DNS error treated as unreachable (5xx semantics)
    httpStatus = 503;
    rawContent = '';
  }

  const ttl = (httpStatus >= 500 || httpStatus === 0) ? ROBOTS_ERROR_CACHE_TTL_MS : ROBOTS_SUCCESS_CACHE_TTL_MS;
  const expiresAtIso = new Date(now + ttl).toISOString();

  // 3. Upsert into robots_cache
  db.prepare(`
    INSERT INTO robots_cache (origin, raw_content, http_status, response_headers, cached_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(origin) DO UPDATE SET
      raw_content = excluded.raw_content,
      http_status = excluded.http_status,
      response_headers = excluded.response_headers,
      cached_at = excluded.cached_at,
      expires_at = excluded.expires_at
  `).run(origin, rawContent, httpStatus, headersJson, nowIso, expiresAtIso);

  const freshRow: RobotsCacheRow = {
    origin,
    raw_content: rawContent,
    http_status: httpStatus,
    response_headers: headersJson,
    cached_at: nowIso,
    expires_at: expiresAtIso,
  };

  return evaluateCachedRobots(freshRow, targetUrl, false);
}

/**
 * Evaluates cached robots response according to RFC 9309 rules.
 */
function evaluateCachedRobots(
  row: RobotsCacheRow,
  targetUrl: string,
  cached: boolean
): RobotsCheckResult {
  const { origin, raw_content, http_status } = row;

  // RFC 9309 Section 2.3.1.2: 4xx status means no restrictions exist
  if (http_status >= 400 && http_status < 500) {
    return { allowed: true, cached };
  }

  // RFC 9309 Section 2.3.1.4: 5xx status or unreachable treated as disallow
  if (http_status >= 500 || http_status === 0) {
    return { allowed: false, reason: 'robots_unavailable', cached };
  }

  // 2xx status: parse rules with robots-parser
  const robotsUrl = `${origin}/robots.txt`;
  const parser = robotsParser(robotsUrl, raw_content);
  const isAllowed = parser.isAllowed(targetUrl, USER_AGENT_TOKEN) ?? true;

  if (!isAllowed) {
    return { allowed: false, reason: 'robots_disallowed', cached };
  }

  return { allowed: true, cached };
}
