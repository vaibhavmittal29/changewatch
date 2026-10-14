import type { Request, Response, NextFunction } from 'express';

/**
 * Middleware that checks the X-CSRF-Token header against the active session's csrf_token
 * on state-changing HTTP methods (POST, PUT, PATCH, DELETE).
 */
export function verifyCsrf(req: Request, res: Response, next: NextFunction): void {
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (safeMethods.includes(req.method)) {
    return next();
  }

  // Exempt public auth endpoints from CSRF token check (they haven't logged in yet)
  const exemptPaths = ['/api/auth/register', '/api/auth/login'];
  if (exemptPaths.includes(req.path)) {
    return next();
  }

  const session = req.session;
  if (!session) {
    res.status(401).json({ error: 'Unauthorized: No active session' });
    return;
  }

  const clientCsrfToken = req.headers['x-csrf-token'] || req.headers['x-xsrf-token'];

  if (!clientCsrfToken || clientCsrfToken !== session.csrfToken) {
    res.status(403).json({ error: 'Forbidden: Invalid or missing CSRF token' });
    return;
  }

  next();
}
