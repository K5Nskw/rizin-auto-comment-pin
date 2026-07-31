import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { safeEqual } from '../crypto.js';

/**
 * HTTP Basic auth over the whole admin surface. When ADMIN_PASSWORD is unset
 * the app stays open (so a fresh deploy is reachable) and configWarnings()
 * shouts about it on the dashboard.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!config.ADMIN_PASSWORD) return next();

  const header = req.headers.authorization ?? '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    if (safeEqual(user, config.ADMIN_USER) && safeEqual(pass, config.ADMIN_PASSWORD)) {
      return next();
    }
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="rizin-auto-comment-pin", charset="UTF-8"');
  res.status(401).send('認証が必要です');
}
