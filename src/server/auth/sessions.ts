import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

export interface Session {
  id: string;
  userId: string;
  csrfToken: string;
  expiresAt: string;
  user: {
    id: string;
    email: string;
    displayName: string;
    digestEnabled: number;
  };
}

export function sha256(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Creates a new session with an unhashed token returned to the caller for cookie setting,
 * and a hashed token stored in the database.
 */
export function createSession(db: Database.Database, userId: string, daysValid = 7): { rawToken: string; csrfToken: string; expiresAt: string } {
  const sessionId = crypto.randomUUID();
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(rawToken);
  const csrfToken = crypto.randomBytes(32).toString('hex');

  const expiresDate = new Date();
  expiresDate.setDate(expiresDate.getDate() + daysValid);
  const expiresAt = expiresDate.toISOString();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, csrf_token, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(sessionId, userId, tokenHash, csrfToken, expiresAt, now);

  return { rawToken, csrfToken, expiresAt };
}

/**
 * Resolves a valid, unexpired session and associated user profile.
 */
export function getSession(db: Database.Database, rawToken: string): Session | null {
  if (!rawToken) return null;
  const tokenHash = sha256(rawToken);
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    SELECT s.id, s.user_id as userId, s.csrf_token as csrfToken, s.expires_at as expiresAt,
           u.email, u.display_name as displayName, u.digest_enabled as digestEnabled
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `);

  const row = stmt.get(tokenHash, now) as {
    id: string;
    userId: string;
    csrfToken: string;
    expiresAt: string;
    email: string;
    displayName: string;
    digestEnabled: number;
  } | undefined;

  if (!row) return null;

  return {
    id: row.id,
    userId: row.userId,
    csrfToken: row.csrfToken,
    expiresAt: row.expiresAt,
    user: {
      id: row.userId,
      email: row.email,
      displayName: row.displayName,
      digestEnabled: row.digestEnabled,
    },
  };
}

/**
 * Deletes a session by raw token.
 */
export function deleteSession(db: Database.Database, rawToken: string): void {
  if (!rawToken) return;
  const tokenHash = sha256(rawToken);
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}
