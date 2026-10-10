import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Config } from './config.ts';
import { HttpError } from './http.ts';

export function securityHeaders(config: Config) {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    });
    if (config.cookieSecure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

export function newCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// 状態変更リクエストは Origin 一致・JSON・セッションに紐付くCSRFトークンをすべて要求する
export function csrfProtection(config: Config) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (req.get('origin') !== config.origin) return next(new HttpError(403, 'csrf'));
    // 本文がある場合はJSONに限定する（本文なしは null）
    if (req.is('application/json') === false) return next(new HttpError(415, 'unsupported_media_type'));
    const expected = req.session.csrf;
    const actual = req.get('x-csrf-token');
    if (!expected || !actual) return next(new HttpError(403, 'csrf'));
    const a = Buffer.from(expected);
    const b = Buffer.from(actual);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return next(new HttpError(403, 'csrf'));
    next();
  };
}
