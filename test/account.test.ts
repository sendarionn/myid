import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { type Client, inviteAndJoin, promoteToManager, setupEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
before(async () => {
  env = await setupEnv();
});
after(async () => {
  await env.close();
});

async function user(): Promise<Client> {
  const c = env.client();
  await c.register();
  return c;
}

async function userIdOf(c: Client): Promise<string> {
  const cred = c.authenticator.credentials[0]!;
  const { rows } = await env.db.query('SELECT user_id FROM passkey_credentials WHERE credential_id = $1', [
    cred.id.toString('base64url'),
  ]);
  return rows[0].user_id;
}

describe('アカウント削除', () => {
  test('本人が削除するとCredential・セッション・参加関係が消え、ログインできなくなる', async () => {
    const c = await user();
    const cred = c.authenticator.credentials[0]!;
    const uid = await userIdOf(c);
    // 別端末のセッション
    const other = env.client();
    other.authenticator.credentials.push(cred);
    assert.equal((await other.login(cred)).status, 200);
    const solo = await c.createProject('ひとりの案件');

    const plan = await c.get('/api/account/deletion-plan');
    assert.deepEqual(plan.body, { blockingProjectIds: [], projectsToDelete: [solo], projectsToLeave: [] });
    assert.equal((await c.delete('/api/account')).status, 400);
    assert.equal((await c.delete('/api/account', { confirm: true })).status, 204);

    for (const table of ['auth_users WHERE id', 'passkey_credentials WHERE user_id', 'sessions WHERE user_id', 'project_memberships WHERE user_id']) {
      assert.equal((await env.db.query(`SELECT 1 FROM ${table} = $1`, [uid])).rowCount, 0, table);
    }
    assert.equal((await env.db.query('SELECT 1 FROM projects WHERE id = $1', [solo])).rowCount, 0);
    // 別端末のセッションも失効している
    assert.equal((await other.get('/api/projects')).status, 401);
    assert.equal((await other.get('/api/session')).body.authenticated, false);
    // 削除後はログインできない
    const again = env.client();
    again.authenticator.credentials.push(cred);
    assert.equal((await again.login(cred)).status, 400);
  });

  test('削除には直近の再認証が必要', async () => {
    const c = await user();
    await env.db.query(
      `UPDATE sessions SET sess = jsonb_set(sess, '{reauthAt}', to_jsonb((extract(epoch FROM now() - interval '10 minutes') * 1000)::bigint))
       WHERE sess ->> 'csrf' = $1`,
      [c.csrf],
    );
    const res = await c.delete('/api/account', { confirm: true });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'reauthentication_required');
    assert.equal((await c.reauth()).status, 200);
    assert.equal((await c.delete('/api/account', { confirm: true })).status, 204);
  });

  test('他人のアカウントは削除できない（ユーザーIDを指定する経路がない）', async () => {
    const victim = await user();
    const victimId = await userIdOf(victim);
    const attacker = await user();
    const res = await attacker.request('DELETE', `/api/account/${victimId}`, { confirm: true });
    assert.equal(res.status, 404);
    // 本文のユーザーIDは無視され、自分のアカウントだけが削除される
    assert.equal((await attacker.delete('/api/account', { confirm: true, userId: victimId })).status, 204);
    assert.equal((await env.db.query('SELECT 1 FROM auth_users WHERE id = $1', [victimId])).rowCount, 1);
    assert.equal((await victim.get('/api/projects')).status, 200);
  });

  test('共有案件は削除されず、他の参加者は引き続き利用できる', async () => {
    const owner = await user();
    const member = await user();
    const id = await owner.createProject('共有案件');
    const { membershipId } = await inviteAndJoin(owner, member, id);
    const plan = await member.get('/api/account/deletion-plan');
    assert.deepEqual(plan.body.projectsToLeave, [id]);
    assert.equal((await member.delete('/api/account', { confirm: true })).status, 204);
    assert.equal((await owner.get(`/api/projects/${id}`)).body.name, '共有案件');
    const members = (await owner.get(`/api/projects/${id}/members`)).body.members;
    assert.equal(members.length, 1);
    const audit = (await owner.get(`/api/projects/${id}/audit`)).body.audit;
    assert.ok(audit.some((e: any) => e.action === 'member_left' && e.targetMembershipId === membershipId));
  });

  test('他の参加者がいる案件の唯一の管理者は削除できない', async () => {
    const owner = await user();
    const member = await user();
    const id = await owner.createProject('共有中');
    const { membershipId } = await inviteAndJoin(owner, member, id);
    const plan = await owner.get('/api/account/deletion-plan');
    assert.deepEqual(plan.body.blockingProjectIds, [id]);
    const res = await owner.delete('/api/account', { confirm: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'sole_manager_of_shared_project');
    assert.equal((await owner.get(`/api/projects/${id}`)).status, 200);
    // 他の参加者を解除すれば、自分だけの案件として一緒に削除される
    assert.equal((await owner.delete(`/api/projects/${id}/members/${membershipId}`)).status, 204);
    assert.deepEqual((await owner.get('/api/account/deletion-plan')).body.projectsToDelete, [id]);
    assert.equal((await owner.delete('/api/account', { confirm: true })).status, 204);
    assert.equal((await env.db.query('SELECT 1 FROM projects WHERE id = $1', [id])).rowCount, 0);
  });

  test('管理者が複数いる案件では削除後も残りの管理者が管理できる', async () => {
    const a = await user();
    const b = await user();
    const id = await a.createProject();
    const { membershipId } = await inviteAndJoin(a, b, id);
    await promoteToManager(env, membershipId);
    assert.equal((await a.delete('/api/account', { confirm: true })).status, 204);
    assert.equal((await b.get(`/api/projects/${id}/invitations`)).status, 200);
  });
});
