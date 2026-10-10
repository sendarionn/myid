import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { setupEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
before(async () => {
  env = await setupEnv();
});
after(async () => {
  await env.close();
});

const count = async (table: string) => Number((await env.db.query(`SELECT count(*) FROM ${table}`)).rows[0].count);

describe('匿名Passkey登録', () => {
  test('個人情報なしで登録でき、認証済みセッションになる', async () => {
    const c = env.client();
    await c.register();
    const s = await c.get('/api/session');
    assert.equal(s.body.authenticated, true);
    // auth_users は個人情報の列を持たない
    const cols = await env.db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'auth_users' ORDER BY ordinal_position",
    );
    assert.deepEqual(
      cols.rows.map((r) => r.column_name),
      ['id', 'webauthn_user_handle', 'created_at'],
    );
  });

  test('登録オプションのユーザー名は固定値で、サーバーは識別名を受け取らない', async () => {
    const c = env.client();
    await c.init();
    const opts = await c.post('/api/auth/register/options', { label: '仕事用' });
    assert.equal(opts.body.user.name, 'myid');
    assert.equal(opts.body.authenticatorSelection.userVerification, 'required');
    assert.equal(opts.body.authenticatorSelection.residentKey, 'required');
  });

  test('中断した登録はアカウントを残さない', async () => {
    const before = await count('auth_users');
    const c = env.client();
    await c.init();
    await c.post('/api/auth/register/options');
    assert.equal(await count('auth_users'), before);
  });

  test('Challengeなしの検証は失敗しアカウントを作らない', async () => {
    const before = await count('auth_users');
    const c = env.client();
    await c.init();
    const opts = await c.post('/api/auth/register/options');
    const response = c.authenticator.create(opts.body);
    const other = env.client();
    await other.init();
    // 別セッションでは Challenge を取得できない
    const res = await other.post('/api/auth/register/verify', { response });
    assert.equal(res.status, 400);
    assert.equal(await count('auth_users'), before);
  });

  test('User Verificationなしの登録は拒否される', async () => {
    const c = env.client();
    await c.init();
    const opts = await c.post('/api/auth/register/options');
    const res = await c.post('/api/auth/register/verify', {
      response: c.authenticator.create(opts.body, { userVerified: false }),
    });
    assert.equal(res.status, 400);
  });

  test('Origin不一致の登録は拒否される', async () => {
    const c = env.client();
    await c.init();
    const opts = await c.post('/api/auth/register/options');
    const res = await c.post('/api/auth/register/verify', {
      response: c.authenticator.create(opts.body, { origin: 'https://evil.test' }),
    });
    assert.equal(res.status, 400);
  });

  test('RP ID不一致の登録は拒否される', async () => {
    const c = env.client();
    await c.init();
    const opts = await c.post('/api/auth/register/options');
    const res = await c.post('/api/auth/register/verify', {
      response: c.authenticator.create(opts.body, { rpId: 'evil.test' }),
    });
    assert.equal(res.status, 400);
  });

  test('同じCredential IDの重複登録は拒否される', async () => {
    const fixed = Buffer.alloc(32, 7);
    const a = env.client();
    await a.init();
    let opts = await a.post('/api/auth/register/options');
    let res = await a.post('/api/auth/register/verify', {
      response: a.authenticator.create(opts.body, { credentialIdBytes: fixed }),
    });
    assert.equal(res.status, 201);
    const b = env.client();
    await b.init();
    const before = await count('auth_users');
    opts = await b.post('/api/auth/register/options');
    res = await b.post('/api/auth/register/verify', {
      response: b.authenticator.create(opts.body, { credentialIdBytes: fixed }),
    });
    assert.equal(res.status, 409);
    // アカウントも作られない
    assert.equal(await count('auth_users'), before);
  });
});

describe('ログイン・ログアウト', () => {
  test('Passkeyでログインでき、セッションIDが再生成される', async () => {
    const c = env.client();
    const cred = await c.register();
    await c.post('/api/auth/logout');
    await c.init();
    const preLoginCookie = c.cookie;
    const res = await c.login(cred);
    assert.equal(res.status, 200);
    assert.notEqual(c.cookie, preLoginCookie);
    assert.equal((await c.get('/api/session')).body.authenticated, true);
  });

  test('ログイン前のセッションCookieはログイン後に使えない（セッション固定対策）', async () => {
    const c = env.client();
    const cred = await c.register();
    await c.post('/api/auth/logout');
    await c.init();
    const fixedCookie = c.cookie;
    const fixedCsrf = c.csrf;
    await c.login(cred);
    const attacker = env.client();
    attacker.cookie = fixedCookie;
    attacker.csrf = fixedCsrf;
    assert.equal((await attacker.get('/api/projects')).status, 401);
  });

  test('同一端末で複数アカウントを作成し、切り替えてログインできる', async () => {
    const c = env.client();
    const cred1 = await c.register();
    const p1 = await c.createProject('アカウント1の案件');
    await c.post('/api/auth/logout');
    const cred2 = await c.register();
    assert.notEqual(cred1.userHandle, cred2.userHandle);
    assert.equal((await c.get('/api/projects')).body.total, 0);
    await c.post('/api/auth/logout');

    assert.equal((await c.login(cred1)).status, 200);
    const list1 = await c.get('/api/projects');
    assert.deepEqual(list1.body.projects.map((p: any) => p.id), [p1]);
    await c.post('/api/auth/logout');

    assert.equal((await c.login(cred2)).status, 200);
    assert.equal((await c.get('/api/projects')).body.total, 0);
  });

  test('ログアウトでサーバー側セッションが失効し、古いCookieは使えない', async () => {
    const c = env.client();
    await c.register();
    const oldCookie = c.cookie;
    const sid = decodeURIComponent(oldCookie!.split('=')[1]!).slice(2).split('.')[0];
    assert.equal((await env.db.query('SELECT 1 FROM sessions WHERE sid = $1', [sid])).rowCount, 1);
    assert.equal((await c.post('/api/auth/logout')).status, 204);
    assert.equal((await env.db.query('SELECT 1 FROM sessions WHERE sid = $1', [sid])).rowCount, 0);
    const replay = env.client();
    replay.cookie = oldCookie;
    assert.equal((await replay.get('/api/projects')).status, 401);
  });

  test('期限切れのChallengeは拒否される', async () => {
    const c = env.client();
    const cred = await c.register();
    await c.post('/api/auth/logout');
    await c.init();
    const opts = await c.post('/api/auth/login/options');
    await env.db.query(
      "UPDATE webauthn_challenges SET created_at = now() - interval '10 minutes', expires_at = now() - interval '1 second' WHERE challenge = $1",
      [opts.body.challenge],
    );
    const res = await c.post('/api/auth/login/verify', { response: c.authenticator.get(opts.body, cred) });
    assert.equal(res.status, 400);
  });

  test('使用済みChallengeの再利用は拒否される', async () => {
    const c = env.client();
    const cred = await c.register();
    await c.post('/api/auth/logout');
    await c.init();
    const opts = await c.post('/api/auth/login/options');
    const response = c.authenticator.get(opts.body, cred);
    const first = await c.post('/api/auth/login/verify', { response });
    assert.equal(first.status, 200);
    const second = await c.post('/api/auth/login/verify', { response });
    assert.equal(second.status, 400);
  });

  test('同じ応答の並列リプレイは1件だけ成功する', async () => {
    const c = env.client();
    const cred = await c.register();
    await c.post('/api/auth/logout');
    await c.init();
    const opts = await c.post('/api/auth/login/options');
    const response = c.authenticator.get(opts.body, cred);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => c.post('/api/auth/login/verify', { response })),
    );
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    // 残りは Challenge 消費済み（400）か、成功側がセッションを再生成した後のCSRF不一致（403）で拒否される
    assert.ok(results.every((r) => r.status === 200 || r.status === 400 || r.status === 403));
    const userId = (await env.db.query('SELECT user_id FROM passkey_credentials WHERE credential_id = $1', [response.id]))
      .rows[0].user_id;
    assert.equal((await env.db.query('SELECT 1 FROM sessions WHERE user_id = $1', [userId])).rowCount, 1);
  });

  const loginWith = async (overrides: Record<string, unknown>) => {
    const c = env.client();
    const cred = await c.register();
    await c.post('/api/auth/logout');
    await c.init();
    const opts = await c.post('/api/auth/login/options');
    const res = await c.post('/api/auth/login/verify', { response: c.authenticator.get(opts.body, cred, overrides) });
    return { c, res };
  };

  test('Origin不一致のログインは拒否される', async () => {
    assert.equal((await loginWith({ origin: 'https://evil.test' })).res.status, 400);
  });

  test('RP ID不一致のログインは拒否される', async () => {
    assert.equal((await loginWith({ rpId: 'evil.test' })).res.status, 400);
  });

  test('User Verificationなしのログインは拒否される', async () => {
    assert.equal((await loginWith({ userVerified: false })).res.status, 400);
  });

  test('ClientDataのtype不一致は拒否される', async () => {
    assert.equal((await loginWith({ type: 'webauthn.create' })).res.status, 400);
  });

  test('未登録のCredential IDは拒否される', async () => {
    const { res, c } = await loginWith({ credentialId: Buffer.alloc(32, 1).toString('base64url') });
    assert.equal(res.status, 400);
    assert.equal((await c.get('/api/session')).body.authenticated, false);
  });

  test('他人のCredential IDと自分の署名の組み合わせは拒否される', async () => {
    const victim = env.client();
    const victimCred = await victim.register();
    const { res } = await loginWith({ credentialId: victimCred.id.toString('base64url'), userHandle: victimCred.userHandle });
    assert.equal(res.status, 400);
  });

  test('userHandle不一致は拒否される', async () => {
    const other = env.client();
    const otherCred = await other.register();
    assert.equal((await loginWith({ userHandle: otherCred.userHandle })).res.status, 400);
  });

  test('userHandleなしのログインは拒否される', async () => {
    assert.equal((await loginWith({ userHandle: null })).res.status, 400);
  });

  test('絶対有効期限を過ぎたセッションは失効する', async () => {
    const c = env.client();
    await c.register();
    await env.db.query(
      `UPDATE sessions SET sess = jsonb_set(sess, '{authAt}', to_jsonb((extract(epoch FROM now() - interval '13 hours') * 1000)::bigint))
       WHERE sess ->> 'csrf' = $1`,
      [c.csrf],
    );
    assert.equal((await c.get('/api/projects')).status, 401);
    assert.equal((await c.get('/api/session')).body.authenticated, false);
  });
});

describe('CSRF', () => {
  test('CSRFトークンなしの状態変更は拒否される', async () => {
    const c = env.client();
    await c.register();
    const res = await c.request('POST', '/api/projects', { name: 'x' }, { 'x-csrf-token': '' });
    assert.equal(res.status, 403);
  });

  test('Origin不一致の状態変更は拒否される', async () => {
    const c = env.client();
    await c.register();
    c.origin = 'https://evil.test';
    assert.equal((await c.post('/api/projects', { name: 'x' })).status, 403);
  });

  test('JSON以外の本文は拒否される', async () => {
    const c = env.client();
    await c.register();
    const res = await fetch(`${c.baseUrl}/api/projects`, {
      method: 'POST',
      headers: { origin: c.origin, cookie: c.cookie!, 'x-csrf-token': c.csrf!, 'content-type': 'text/plain' },
      body: '{"name":"x"}',
    });
    assert.equal(res.status, 415);
  });
});

describe('Passkey管理', () => {
  test('Passkeyを追加・一覧・削除でき、最後の1件は削除できない', async () => {
    const c = env.client();
    const cred1 = await c.register();
    const opts = await c.post('/api/account/passkeys/options');
    assert.equal(opts.status, 200);
    // 既存Credentialは除外対象として渡される
    assert.deepEqual(opts.body.excludeCredentials.map((x: any) => x.id), [cred1.id.toString('base64url')]);
    // 同じアカウントの userHandle で作成される
    assert.equal(opts.body.user.id, cred1.userHandle);
    // 同じ認証器には重複登録されない
    assert.throws(() => c.authenticator.create(opts.body), /InvalidStateError/);
    const cred2 = await c.addPasskey();

    let list = await c.get('/api/account/passkeys');
    assert.equal(list.body.passkeys.length, 2);
    assert.equal(list.body.passkeys[0].public_key, undefined);

    // 追加したPasskeyでもログインできる
    await c.post('/api/auth/logout');
    assert.equal((await c.login(cred2)).status, 200);

    const first = list.body.passkeys[0].id;
    assert.equal((await c.delete(`/api/account/passkeys/${first}`)).status, 204);
    list = await c.get('/api/account/passkeys');
    assert.equal(list.body.passkeys.length, 1);
    const last = await c.delete(`/api/account/passkeys/${list.body.passkeys[0].id}`);
    assert.equal(last.status, 409);
    assert.equal(last.body.error, 'last_passkey');
    // 削除したPasskeyではログインできない
    await c.post('/api/auth/logout');
    assert.equal((await c.login(cred1)).status, 400);
  });

  test('重要操作は直近の再認証を要求する', async () => {
    const c = env.client();
    const cred = await c.register();
    await env.db.query(
      `UPDATE sessions SET sess = jsonb_set(sess, '{reauthAt}', to_jsonb((extract(epoch FROM now() - interval '10 minutes') * 1000)::bigint))
       WHERE sess ->> 'csrf' = $1`,
      [c.csrf],
    );
    const denied = await c.post('/api/account/passkeys/options');
    assert.equal(denied.status, 401);
    assert.equal(denied.body.error, 'reauthentication_required');
    assert.equal((await c.reauth(cred)).status, 200);
    assert.equal((await c.post('/api/account/passkeys/options')).status, 200);
  });

  test('他人のCredentialでは再認証できない', async () => {
    const other = env.client();
    const otherCred = await other.register();
    const c = env.client();
    await c.register();
    const opts = await c.post('/api/auth/reauth/options');
    const res = await c.post('/api/auth/reauth/verify', { response: other.authenticator.get(opts.body, otherCred) });
    assert.equal(res.status, 400);
  });

  test('他人のPasskeyは削除できない', async () => {
    const victim = env.client();
    await victim.register();
    const victimPasskey = (await victim.get('/api/account/passkeys')).body.passkeys[0].id;
    await victim.addPasskey();
    const c = env.client();
    await c.register();
    assert.equal((await c.delete(`/api/account/passkeys/${victimPasskey}`)).status, 404);
    assert.equal((await victim.get('/api/account/passkeys')).body.passkeys.length, 2);
  });

  test('同時に2件のPasskeyを削除しても0件にはならない', async () => {
    const c = env.client();
    await c.register();
    await c.addPasskey();
    const ids = (await c.get('/api/account/passkeys')).body.passkeys.map((p: any) => p.id);
    const results = await Promise.all(ids.map((id: string) => c.delete(`/api/account/passkeys/${id}`)));
    assert.deepEqual(results.map((r) => r.status).sort(), [204, 409]);
    assert.equal((await c.get('/api/account/passkeys')).body.passkeys.length, 1);
  });
});
