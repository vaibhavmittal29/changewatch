import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { getOriginFromUrl, checkRobotsPermission } from '../../src/server/queue/robots.js';

describe('Phase 3 Unit: Robots.txt & RFC 9309 Cache (Acceptance Matrix E)', () => {
  let db: Database.Database;
  const testDbPath = path.resolve('data', 'test-robots.db');

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    db = new Database(testDbPath);
    const schema = fs.readFileSync(path.resolve('src', 'server', 'db', 'schema.sql'), 'utf-8');
    db.exec(schema);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  it('separates origins strictly by scheme, host, and port', () => {
    expect(getOriginFromUrl('http://example.com/page')).toBe('http://example.com');
    expect(getOriginFromUrl('https://example.com/page')).toBe('https://example.com');
    expect(getOriginFromUrl('http://example.com:8080/foo')).toBe('http://example.com:8080');
    expect(getOriginFromUrl('https://example.com:8443/bar')).toBe('https://example.com:8443');
  });

  it('allows all when robots.txt returns 404 (RFC 9309 Section 2.3.1.2)', async () => {
    const origin = 'https://four-oh-four.example.com';
    const now = Date.now();
    const expiresAt = new Date(now + 86400000).toISOString();

    // Seed 404 response in cache
    db.prepare(`
      INSERT INTO robots_cache (origin, raw_content, http_status, response_headers, cached_at, expires_at)
      VALUES (?, '', 404, '{}', ?, ?)
    `).run(origin, new Date(now).toISOString(), expiresAt);

    const result = await checkRobotsPermission(db, `${origin}/secret-path`, now);
    expect(result.allowed).toBe(true);
    expect(result.cached).toBe(true);
  });

  it('treats 5xx/unreachable as disallow-for-now (RFC 9309 Section 2.3.1.4)', async () => {
    const origin = 'https://server-error.example.com';
    const now = Date.now();
    const expiresAt = new Date(now + 86400000).toISOString();

    // Seed 503 response in cache
    db.prepare(`
      INSERT INTO robots_cache (origin, raw_content, http_status, response_headers, cached_at, expires_at)
      VALUES (?, '', 503, '{}', ?, ?)
    `).run(origin, new Date(now).toISOString(), expiresAt);

    const result = await checkRobotsPermission(db, `${origin}/any-page`, now);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('robots_unavailable');
    expect(result.cached).toBe(true);
  });

  it('honors User-Agent ChangeWatch and RFC 9309 path precedence', async () => {
    const origin = 'https://precedence.example.com';
    const now = Date.now();
    const expiresAt = new Date(now + 86400000).toISOString();

    const robotsContent = `
User-agent: *
Disallow: /

User-agent: ChangeWatch
Disallow: /private/
Allow: /private/open-door
Allow: /public/
`;

    db.prepare(`
      INSERT INTO robots_cache (origin, raw_content, http_status, response_headers, cached_at, expires_at)
      VALUES (?, ?, 200, '{}', ?, ?)
    `).run(origin, robotsContent, new Date(now).toISOString(), expiresAt);

    // /private/open-door should be ALLOWED because Allow: /private/open-door is longer/more specific
    const openRes = await checkRobotsPermission(db, `${origin}/private/open-door`, now);
    expect(openRes.allowed).toBe(true);

    // /private/other should be DISALLOWED
    const privateRes = await checkRobotsPermission(db, `${origin}/private/secret`, now);
    expect(privateRes.allowed).toBe(false);
    expect(privateRes.reason).toBe('robots_disallowed');

    // /public/docs should be ALLOWED
    const publicRes = await checkRobotsPermission(db, `${origin}/public/docs`, now);
    expect(publicRes.allowed).toBe(true);
  });

  it('separates caching between http and https of the same hostname', async () => {
    const httpOrigin = 'http://split.example.com';
    const httpsOrigin = 'https://split.example.com';
    const now = Date.now();
    const expiresAt = new Date(now + 86400000).toISOString();

    // HTTP origin disallows everything
    db.prepare(`
      INSERT INTO robots_cache (origin, raw_content, http_status, response_headers, cached_at, expires_at)
      VALUES (?, 'User-agent: *\nDisallow: /', 200, '{}', ?, ?)
    `).run(httpOrigin, new Date(now).toISOString(), expiresAt);

    // HTTPS origin allows everything
    db.prepare(`
      INSERT INTO robots_cache (origin, raw_content, http_status, response_headers, cached_at, expires_at)
      VALUES (?, 'User-agent: *\nAllow: /', 200, '{}', ?, ?)
    `).run(httpsOrigin, new Date(now).toISOString(), expiresAt);

    const httpCheck = await checkRobotsPermission(db, `${httpOrigin}/data`, now);
    const httpsCheck = await checkRobotsPermission(db, `${httpsOrigin}/data`, now);

    expect(httpCheck.allowed).toBe(false);
    expect(httpCheck.reason).toBe('robots_disallowed');

    expect(httpsCheck.allowed).toBe(true);
  });
});
