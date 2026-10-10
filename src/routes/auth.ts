import { Router } from 'express';
import { deleteAccount, deletionPlan } from '../account.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db.ts';
import { HttpError, isUuid, notFound } from '../http.ts';
import { newCsrfToken } from '../security.ts';
import {
  type AuthedRequest,
  destroySession,
  regenerateSession,
  requireAuth,
  requireRecentAuth,
  saveSession,
} from '../session.ts';
import * as webauthn from '../webauthn.ts';
import type { Request } from 'express';

async function startAuthenticatedSession(req: Request, userId: string): Promise<void> {
  // セッション固定攻撃対策としてIDを再生成し、CSRFトークンも作り直す
  await regenerateSession(req);
  const now = Date.now();
  req.session.uid = userId;
  req.session.authAt = now;
  req.session.reauthAt = now;
  req.session.csrf = newCsrfToken();
  await saveSession(req);
}

export function authRouter(config: Config, db: Db): Router {
  const r = Router();
  const auth = requireAuth(config, db);
  const recent = requireRecentAuth(config);

  // CSRFトークンの取得と認証状態の確認
  r.get('/session', async (req, res) => {
    if (!req.session.csrf) {
      req.session.csrf = newCsrfToken();
      await saveSession(req);
    }
    let authenticated = false;
    if (req.session.uid && req.session.authAt && Date.now() - req.session.authAt <= config.sessionAbsoluteMs) {
      const { rowCount } = await db.query('SELECT 1 FROM auth_users WHERE id = $1', [req.session.uid]);
      authenticated = rowCount === 1;
    }
    res.json({
      csrfToken: req.session.csrf,
      authenticated,
      reauthValidUntil:
        authenticated && req.session.reauthAt
          ? new Date(req.session.reauthAt + config.reauthWindowMs).toISOString()
          : null,
    });
  });

  r.post('/auth/register/options', async (req, res) => {
    res.json(await webauthn.registrationOptions(config, db, req));
  });

  r.post('/auth/register/verify', async (req, res) => {
    const userId = await webauthn.registrationVerify(config, db, req);
    await startAuthenticatedSession(req, userId);
    res.status(201).json({ csrfToken: req.session.csrf });
  });

  r.post('/auth/login/options', async (req, res) => {
    res.json(await webauthn.authenticationOptions(config, db, req));
  });

  r.post('/auth/login/verify', async (req, res) => {
    const userId = await webauthn.authenticationVerify(config, db, req);
    await startAuthenticatedSession(req, userId);
    res.json({ csrfToken: req.session.csrf });
  });

  r.post('/auth/logout', async (req, res) => {
    await destroySession(req);
    res.clearCookie(config.cookieSecure ? '__Host-sid' : 'sid', { path: '/' });
    res.status(204).end();
  });

  r.post('/auth/reauth/options', auth, async (req, res) => {
    res.json(await webauthn.reauthenticationOptions(config, db, req, (req as AuthedRequest).userId));
  });

  r.post('/auth/reauth/verify', auth, async (req, res) => {
    await webauthn.reauthenticationVerify(config, db, req, (req as AuthedRequest).userId);
    req.session.reauthAt = Date.now();
    await saveSession(req);
    res.json({ reauthValidUntil: new Date(req.session.reauthAt + config.reauthWindowMs).toISOString() });
  });

  // ---- Passkey管理 ----

  r.get('/account/passkeys', auth, async (req, res) => {
    const { rows } = await db.query(
      `SELECT id, left(credential_id, 8) AS credential_id_prefix, device_type, backed_up, transports,
              created_at, last_used_at
       FROM passkey_credentials WHERE user_id = $1 ORDER BY created_at`,
      [(req as AuthedRequest).userId],
    );
    res.json({ passkeys: rows });
  });

  r.post('/account/passkeys/options', auth, recent, async (req, res) => {
    res.json(await webauthn.passkeyAdditionOptions(config, db, req, (req as AuthedRequest).userId));
  });

  r.post('/account/passkeys/verify', auth, recent, async (req, res) => {
    await webauthn.passkeyAdditionVerify(config, db, req, (req as AuthedRequest).userId);
    res.status(201).end();
  });

  r.delete('/account/passkeys/:id', auth, recent, async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) throw notFound();
    // 最後の1件はDBトリガーが拒否する（409 last_passkey）
    const { rowCount } = await db.query('DELETE FROM passkey_credentials WHERE id = $1 AND user_id = $2', [
      id,
      (req as AuthedRequest).userId,
    ]);
    if (!rowCount) throw notFound();
    res.status(204).end();
  });

  // ---- アカウント削除 ----

  r.get('/account/deletion-plan', auth, async (req, res) => {
    res.json(await deletionPlan(db, (req as AuthedRequest).userId));
  });

  r.delete('/account', auth, recent, async (req, res) => {
    if ((req.body as { confirm?: unknown } | undefined)?.confirm !== true) throw new HttpError(400, 'confirmation_required');
    await deleteAccount(db, (req as AuthedRequest).userId);
    await destroySession(req);
    res.clearCookie(config.cookieSecure ? '__Host-sid' : 'sid', { path: '/' });
    res.status(204).end();
  });

  return r;
}
