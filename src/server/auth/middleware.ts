import type { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb } from '../db/index.js';
import { getSession, type Session } from './sessions.js';
import { env } from '../config.js';

// Extend Express Request interface to include session and user
declare global {
  namespace Express {
    interface Request {
      session?: Session;
      user?: Session['user'];
    }
  }
}

/**
 * Attaches the authenticated session and user to the request if a valid session cookie exists.
 */
export function attachSession(req: Request, _res: Response, next: NextFunction): void {
  const token = req.cookies?.cw_session;
  if (!token) {
    return next();
  }

  try {
    const db = getDb();
    const session = getSession(db, token);
    if (session) {
      req.session = session;
      req.user = session.user;
    }
  } catch (err) {
    console.error('Error attaching session:', err);
  }

  next();
}

/**
 * Enforces that an authenticated session is present.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session || !req.user) {
    res.status(401).json({ error: 'Unauthorized: Authentication required' });
    return;
  }
  next();
}

/**
 * Rate limiter for sensitive auth routes (login, register).
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // Limit each IP to 30 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => env.NODE_ENV === 'test' || req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1',
  message: { error: 'Too many authentication attempts, please try again later.' },
});
