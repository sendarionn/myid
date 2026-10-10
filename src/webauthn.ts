import { randomBytes } from 'node:crypto';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { Request } from 'express';
import type { Config } from './config.ts';
import { type Db, PG_UNIQUE_VIOLATION, pgErrorCode, type Tx, withTransaction } from './db.ts';
import { HttpError } from './http.ts';
import { sessionHash } from './session.ts';

type Ceremony = 'registration' | 'authentication' | 'reauthentication' | 'passkey_addition';

type StoredChallenge = {
  challenge: string;
  user_id: string | null;
  pending_user_handle: Buffer | null;
};

type CredentialRow = {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: Buffer;
  sign_count: string;
  transports: string[];
  webauthn_user_handle: Buffer;
};

// 失敗理由を区別しない（Credentialの存在有無などを漏らさない）
const verificationFailed = () => new HttpError(400, 'verification_failed');

const ALLOWED_TRANSPORTS = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);

// ブラウザに渡すアカウント名
// 利用者が付ける識別名はブラウザ側で上書きし、サーバーには送らない
const DEFAULT_USER_NAME = 'myid';

async function storeChallenge(
  db: Db,
  config: Config,
  req: Request,
  ceremony: Ceremony,
  challenge: string,
  userId: string | null,
  pendingUserHandle: Buffer | null,
): Promise<void> {
  await db.query('DELETE FROM webauthn_challenges WHERE expires_at < now()');
  // 同一セッション・同一種別の未使用Challengeは置き換える
  await db.query(
    `INSERT INTO webauthn_challenges (session_hash, ceremony, challenge, user_id, pending_user_handle, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))
     ON CONFLICT (session_hash, ceremony) DO UPDATE
       SET challenge = EXCLUDED.challenge,
           user_id = EXCLUDED.user_id,
           pending_user_handle = EXCLUDED.pending_user_handle,
           created_at = now(),
           expires_at = EXCLUDED.expires_at`,
    [sessionHash(req), ceremony, challenge, userId, pendingUserHandle, config.challengeTtlMs / 1000],
  );
}

// 取得と同時に削除する
// 同じChallengeで並列に検証しても、行を取得できるのは1リクエストだけになる
async function consumeChallenge(db: Db, req: Request, ceremony: Ceremony): Promise<StoredChallenge> {
  const { rows } = await db.query<StoredChallenge & { expired: boolean }>(
    `DELETE FROM webauthn_challenges
     WHERE session_hash = $1 AND ceremony = $2
     RETURNING challenge, user_id, pending_user_handle, expires_at <= now() AS expired`,
    [sessionHash(req), ceremony],
  );
  const row = rows[0];
  if (!row || row.expired) throw verificationFailed();
  return row;
}

function parseRegistrationResponse(body: unknown): RegistrationResponseJSON {
  const r = (body as { response?: unknown } | undefined)?.response as RegistrationResponseJSON | undefined;
  if (!r || typeof r.id !== 'string' || r.id !== r.rawId || r.type !== 'public-key') throw verificationFailed();
  return r;
}

function parseAuthenticationResponse(body: unknown): AuthenticationResponseJSON {
  const r = (body as { response?: unknown } | undefined)?.response as AuthenticationResponseJSON | undefined;
  if (!r || typeof r.id !== 'string' || r.id !== r.rawId || r.type !== 'public-key') throw verificationFailed();
  return r;
}

async function verifyRegistration(config: Config, response: RegistrationResponseJSON, challenge: string) {
  let result;
  try {
    result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpId,
      requireUserVerification: true,
    });
  } catch {
    throw verificationFailed();
  }
  if (!result.verified || !result.registrationInfo.userVerified) throw verificationFailed();
  return result.registrationInfo;
}

type RegistrationInfo = Awaited<ReturnType<typeof verifyRegistration>>;

async function insertCredential(tx: Tx, userId: string, info: RegistrationInfo): Promise<void> {
  const transports = (info.credential.transports ?? []).filter((t) => ALLOWED_TRANSPORTS.has(t));
  try {
    await tx.query(
      `INSERT INTO passkey_credentials
         (user_id, credential_id, public_key, sign_count, transports, device_type, backed_up, aaguid)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        userId,
        info.credential.id,
        Buffer.from(info.credential.publicKey),
        info.credential.counter,
        transports,
        info.credentialDeviceType,
        info.credentialBackedUp,
        info.aaguid,
      ],
    );
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) throw new HttpError(409, 'credential_already_registered');
    throw err;
  }
}

// ---- 登録（新規匿名アカウント） ----

export async function registrationOptions(config: Config, db: Db, req: Request) {
  const userHandle = randomBytes(32);
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userName: DEFAULT_USER_NAME,
    userID: userHandle,
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    timeout: config.challengeTtlMs,
  });
  await storeChallenge(db, config, req, 'registration', options.challenge, null, userHandle);
  return options;
}

// アカウントとCredentialは検証成功後に同一トランザクションで作成する
// 中断した登録はChallengeだけが残り、期限切れで削除される
export async function registrationVerify(config: Config, db: Db, req: Request): Promise<string> {
  const response = parseRegistrationResponse(req.body);
  const stored = await consumeChallenge(db, req, 'registration');
  const info = await verifyRegistration(config, response, stored.challenge);
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      'INSERT INTO auth_users (webauthn_user_handle) VALUES ($1) RETURNING id',
      [stored.pending_user_handle],
    );
    const userId = rows[0]!.id;
    await insertCredential(tx, userId, info);
    return userId;
  });
}

// ---- Passkey追加（ログイン済み・再認証済み） ----

export async function passkeyAdditionOptions(config: Config, db: Db, req: Request, userId: string) {
  const { rows: users } = await db.query<{ webauthn_user_handle: Buffer }>(
    'SELECT webauthn_user_handle FROM auth_users WHERE id = $1',
    [userId],
  );
  const { rows: creds } = await db.query<{ credential_id: string; transports: string[] }>(
    'SELECT credential_id, transports FROM passkey_credentials WHERE user_id = $1',
    [userId],
  );
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userName: DEFAULT_USER_NAME,
    userID: new Uint8Array(users[0]!.webauthn_user_handle),
    attestationType: 'none',
    excludeCredentials: creds.map((c) => ({ id: c.credential_id, transports: c.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    timeout: config.challengeTtlMs,
  });
  await storeChallenge(db, config, req, 'passkey_addition', options.challenge, userId, null);
  return options;
}

export async function passkeyAdditionVerify(config: Config, db: Db, req: Request, userId: string): Promise<void> {
  const response = parseRegistrationResponse(req.body);
  const stored = await consumeChallenge(db, req, 'passkey_addition');
  if (stored.user_id !== userId) throw verificationFailed();
  const info = await verifyRegistration(config, response, stored.challenge);
  await withTransaction(db, (tx) => insertCredential(tx, userId, info));
}

// ---- ログイン・再認証 ----

export async function authenticationOptions(config: Config, db: Db, req: Request) {
  // 発見可能なCredentialを使い、端末内の複数アカウントはOS・ブラウザのUIで選択する
  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    userVerification: 'required',
    timeout: config.challengeTtlMs,
  });
  await storeChallenge(db, config, req, 'authentication', options.challenge, null, null);
  return options;
}

export async function reauthenticationOptions(config: Config, db: Db, req: Request, userId: string) {
  const { rows } = await db.query<{ credential_id: string; transports: string[] }>(
    'SELECT credential_id, transports FROM passkey_credentials WHERE user_id = $1',
    [userId],
  );
  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    userVerification: 'required',
    allowCredentials: rows.map((c) => ({ id: c.credential_id, transports: c.transports })),
    timeout: config.challengeTtlMs,
  });
  await storeChallenge(db, config, req, 'reauthentication', options.challenge, userId, null);
  return options;
}

async function verifyAssertion(
  config: Config,
  db: Db,
  response: AuthenticationResponseJSON,
  challenge: string,
  requireUserHandle: boolean,
): Promise<string> {
  const { rows } = await db.query<CredentialRow>(
    `SELECT c.id, c.user_id, c.credential_id, c.public_key, c.sign_count, c.transports, u.webauthn_user_handle
     FROM passkey_credentials c JOIN auth_users u ON u.id = c.user_id
     WHERE c.credential_id = $1`,
    [response.id],
  );
  const cred = rows[0];
  if (!cred) throw verificationFailed();

  // userHandle は Credential の所有者と一致しなければならない
  const userHandle = response.response.userHandle;
  if (userHandle !== undefined && userHandle !== null) {
    if (userHandle !== cred.webauthn_user_handle.toString('base64url')) throw verificationFailed();
  } else if (requireUserHandle) {
    throw verificationFailed();
  }

  let result;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpId,
      requireUserVerification: true,
      credential: {
        id: cred.credential_id,
        publicKey: new Uint8Array(cred.public_key),
        counter: Number(cred.sign_count),
        transports: cred.transports,
      },
    });
  } catch {
    throw verificationFailed();
  }
  if (!result.verified || !result.authenticationInfo.userVerified) throw verificationFailed();

  await db.query(
    `UPDATE passkey_credentials
     SET sign_count = GREATEST(sign_count, $2), backed_up = $3, last_used_at = now()
     WHERE id = $1`,
    [cred.id, result.authenticationInfo.newCounter, result.authenticationInfo.credentialBackedUp],
  );
  return cred.user_id;
}

export async function authenticationVerify(config: Config, db: Db, req: Request): Promise<string> {
  const response = parseAuthenticationResponse(req.body);
  const stored = await consumeChallenge(db, req, 'authentication');
  return verifyAssertion(config, db, response, stored.challenge, true);
}

export async function reauthenticationVerify(config: Config, db: Db, req: Request, userId: string): Promise<void> {
  const response = parseAuthenticationResponse(req.body);
  const stored = await consumeChallenge(db, req, 'reauthentication');
  if (stored.user_id !== userId) throw verificationFailed();
  const credentialOwner = await verifyAssertion(config, db, response, stored.challenge, false);
  if (credentialOwner !== userId) throw verificationFailed();
}
