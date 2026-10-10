import type { NextFunction, Request, Response } from 'express';
import { LAST_MANAGER, LAST_PASSKEY, pgErrorCode } from './db.ts';

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

// 存在しない・アクセス権がない・ID形式が不正の区別をしない
export const notFound = () => new HttpError(404, 'not_found');
export const forbidden = () => new HttpError(403, 'forbidden');
export const badRequest = (code = 'invalid_request') => new HttpError(400, code);
export const conflict = (code: string) => new HttpError(409, code);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.code });
    return;
  }
  const code = pgErrorCode(err);
  if (code === LAST_MANAGER) {
    res.status(409).json({ error: 'last_manager' });
    return;
  }
  // 同時操作によるデッドロック・直列化失敗はロールバック済みなので再試行可能として返す
  if (code === '40P01' || code === '40001') {
    res.status(409).json({ error: 'conflict_retry' });
    return;
  }
  if (code === LAST_PASSKEY) {
    res.status(409).json({ error: 'last_passkey' });
    return;
  }
  const status = typeof err === 'object' && err !== null && 'status' in err ? Number(err.status) : 500;
  if (status >= 400 && status < 500) {
    // body-parser の不正JSON・サイズ超過など
    res.status(status).json({ error: 'invalid_request' });
    return;
  }
  // DBエラーの detail には値が含まれるため、名前・コード・スタックだけを記録する
  const e = err instanceof Error ? err : new Error(String(err));
  console.error(JSON.stringify({ level: 'error', name: e.name, code, message: e.message, stack: e.stack }));
  res.status(500).json({ error: 'internal_error' });
}
