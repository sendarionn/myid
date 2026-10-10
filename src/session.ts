import { createHash } from 'node:crypto';
import connectPgSimple from 'connect-pg-simple';
import type { NextFunction, Request, Response } from 'express';
import session from 'express-session';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { HttpError } from './http.ts';

declare module 'express-session' {
  interface SessionData {
    csrf: string;
    // 以下は認証後のみ
    uid: string;
    authAt: number;
    reauthAt: number;
  }
}

export function sessionMiddleware(config: Config, db: Db) {
  const PgStore = connectPgSimple(session);
  return session({
    name: config.cookieSecure ? '__Host-sid' : 'sid',
    secret: config.sessionSecret,
    store: new PgStore({ pool: db, tableName: 'sessions', createTableIfMissing: false }),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    unset: 'destroy',
    cookie: {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'strict',
      path: '/',
      // 無操作タイムアウト（rolling で操作ごとに延長）
      maxAge: config.sessionIdleMs,
    },
  });
}

export function sessionHash(req: Request): Buffer {
  return createHash('sha256').update(req.sessionID).digest();
}

export function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}

export function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
}

export function destroySession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.destroy((err) => (err ? reject(err) : resolve())));
}

export type AuthedRequest = Request & { userId: string };

// セッションの内容だけを信用せず、毎回ユーザーの存在と絶対有効期限を確認する
export function requireAuth(config: Config, db: Db) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const { uid, authAt } = req.session;
    if (!uid || !authAt) return next(new HttpError(401, 'unauthenticated'));
    if (Date.now() - authAt > config.sessionAbsoluteMs) {
      await destroySession(req);
      return next(new HttpError(401, 'unauthenticated'));
    }
    const { rowCount } = await db.query('SELECT 1 FROM auth_users WHERE id = $1', [uid]);
    if (!rowCount) {
      await destroySession(req);
      return next(new HttpError(401, 'unauthenticated'));
    }
    (req as AuthedRequest).userId = uid;
    next();
  };
}

export function requireRecentAuth(config: Config) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const { reauthAt } = req.session;
    if (!reauthAt || Date.now() - reauthAt > config.reauthWindowMs) {
      return next(new HttpError(401, 'reauthentication_required'));
    }
    next();
  };
}
