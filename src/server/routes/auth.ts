import { Router, type Response } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { createSession, deleteSession } from '../auth/sessions.js';
import { authRateLimiter } from '../auth/middleware.js';
import { env } from '../config.js';

export const authRouter = Router();

const RegisterSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8, 'Password must be at least 8 characters long').max(128),
  displayName: z.string().min(1).max(100),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const COOKIE_NAME = 'cw_session';

function setSessionCookie(res: Response, rawToken: string, expiresAt: string) {
  res.cookie(COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires: new Date(expiresAt),
    path: '/',
  });
}

authRouter.post('/register', authRateLimiter, async (req, res) => {
  try {
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.format() });
      return;
    }

    const { email, password, displayName } = parsed.data;
    const db = getDb();

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (existing) {
      res.status(409).json({ error: 'User with this email already exists' });
      return;
    }

    const userId = crypto.randomUUID();
    const { hash, salt, iterations } = await hashPassword(password);
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO users (id, email, password_hash, password_salt, password_iterations, display_name, digest_enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `).run(userId, email.toLowerCase(), hash, salt, iterations, displayName, now);

    const { rawToken, csrfToken, expiresAt } = createSession(db, userId);
    setSessionCookie(res, rawToken, expiresAt);

    res.status(201).json({
      user: {
        id: userId,
        email: email.toLowerCase(),
        displayName,
        digestEnabled: 0,
      },
      csrfToken,
    });
  } catch (err: unknown) {
    console.error('Error in /register:', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

authRouter.post('/login', authRateLimiter, async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.format() });
    return;
  }

  const { email, password } = parsed.data;
  const db = getDb();

  const user = db.prepare(`
    SELECT id, email, password_hash as passwordHash, password_salt as passwordSalt,
           password_iterations as passwordIterations, display_name as displayName,
           digest_enabled as digestEnabled
    FROM users WHERE email = ?
  `).get(email.toLowerCase()) as {
    id: string;
    email: string;
    passwordHash: string;
    passwordSalt: string;
    passwordIterations: number;
    displayName: string;
    digestEnabled: number;
  } | undefined;

  if (!user) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const isValid = await verifyPassword(password, user.passwordHash, user.passwordSalt, user.passwordIterations);
  if (!isValid) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const { rawToken, csrfToken, expiresAt } = createSession(db, user.id);
  setSessionCookie(res, rawToken, expiresAt);

  res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      digestEnabled: user.digestEnabled,
    },
    csrfToken,
  });
});

authRouter.post('/logout', (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) {
    deleteSession(getDb(), token);
  }
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  if (!req.session || !req.user) {
    res.json({ user: null, csrfToken: null });
    return;
  }

  res.json({
    user: req.user,
    csrfToken: req.session.csrfToken,
  });
});
