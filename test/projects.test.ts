import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { type Client, inviteAndJoin, setupEnv, type TestEnv } from './helpers.ts';

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

describe('案件', () => {
  test('案件名だけで作成でき、作成者は管理者として閲覧できる', async () => {
    const a = await user();
    const id = await a.createProject('案件A');
    const res = await a.get(`/api/projects/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.name, '案件A');
    assert.ok(res.body.createdAt && res.body.updatedAt);
    assert.equal(res.body.access.role, 'manager');
    assert.deepEqual(res.body.access.actions, [
      'project.view',
      'project.rename',
      'members.view',
      'members.remove',
      'invitations.manage',
      'audit.view',
    ]);
    // ユーザーIDは返さない
    assert.equal(JSON.stringify(res.body).includes('userId'), false);
  });

  test('不正な案件名は拒否される', async () => {
    const a = await user();
    assert.equal((await a.post('/api/projects', { name: '' })).status, 400);
    assert.equal((await a.post('/api/projects', { name: '   ' })).status, 400);
    assert.equal((await a.post('/api/projects', { name: 'x'.repeat(101) })).status, 400);
    assert.equal((await a.post('/api/projects', { name: 1 })).status, 400);
    assert.equal((await a.get('/api/projects')).body.total, 0);
  });

  test('案件名は入力した表記のまま保存される', async () => {
    const a = await user();
    for (const name of ['Mixed case 案件', '<script>alert(1)</script>', "x'; DROP TABLE projects; --"]) {
      const id = await a.createProject(name);
      assert.equal((await a.get(`/api/projects/${id}`)).body.name, name);
    }
  });

  test('管理者は案件名を変更でき、監査ログに記録される', async () => {
    const a = await user();
    const id = await a.createProject('旧名');
    assert.equal((await a.patch(`/api/projects/${id}`, { name: '新名' })).status, 204);
    assert.equal((await a.get(`/api/projects/${id}`)).body.name, '新名');
    const audit = await a.get(`/api/projects/${id}/audit`);
    assert.deepEqual(
      audit.body.audit.map((e: any) => e.action),
      ['project_created', 'member_added', 'project_renamed'],
    );
  });

  test('案件一覧には自分が参加している案件だけが表示される', async () => {
    const a = await user();
    const b = await user();
    const pa = await a.createProject('Aの案件');
    await b.createProject('Bの案件');
    const list = await a.get('/api/projects');
    assert.deepEqual(list.body.projects.map((p: any) => p.id), [pa]);
    assert.equal(list.body.total, 1);
    assert.equal(list.body.projects[0].role, 'manager');
  });

  test('他人の案件へのアクセスは存在しない案件と同じ404になる', async () => {
    const a = await user();
    const b = await user();
    const id = await a.createProject('秘密の案件');
    for (const suffix of ['', '/members', '/invitations', '/audit']) {
      const own = await b.get(`/api/projects/${id}${suffix}`);
      const missing = await b.get(`/api/projects/${randomUUID()}${suffix}`);
      const malformed = await b.get(`/api/projects/not-a-uuid${suffix}`);
      assert.equal(own.status, 404, suffix);
      assert.deepEqual(own.body, missing.body);
      assert.deepEqual(own.body, malformed.body);
    }
    assert.equal((await b.patch(`/api/projects/${id}`, { name: '乗っ取り' })).status, 404);
    assert.equal((await b.post(`/api/projects/${id}/invitations`)).status, 404);
    const aMembership = (await a.get(`/api/projects/${id}`)).body.access.membershipId;
    assert.equal((await b.delete(`/api/projects/${id}/members/${aMembership}`)).status, 404);
    assert.equal((await a.get(`/api/projects/${id}`)).body.name, '秘密の案件');
  });

  test('案件IDを書き換えても他の案件の参加者を操作できない', async () => {
    const a = await user();
    const b = await user();
    const aProject = await a.createProject('Aの案件');
    const bProject = await b.createProject('Bの案件');
    const aMembershipId = (await a.get(`/api/projects/${aProject}`)).body.access.membershipId;
    // A の参加関係IDを B の案件のパスで解除しようとしても見つからない
    assert.equal((await b.delete(`/api/projects/${bProject}/members/${aMembershipId}`)).status, 404);
    assert.equal((await a.get(`/api/projects/${aProject}`)).status, 200);
  });

  test('未ログインでは案件APIを利用できない', async () => {
    const c = env.client();
    await c.init();
    assert.equal((await c.get('/api/projects')).status, 401);
    assert.equal((await c.post('/api/projects', { name: 'x' })).status, 401);
  });

  test('廃止した案件データのAPIは存在しない', async () => {
    const a = await user();
    const id = await a.createProject();
    for (const path of ['products', 'schedules', 'contract', 'events']) {
      assert.equal((await a.get(`/api/projects/${id}/${path}`)).status, 404, path);
    }
  });
});

describe('一般参加者', () => {
  test('案件と参加者一覧を閲覧でき、管理操作はAPIを直接呼んでも拒否される', async () => {
    const manager = await user();
    const member = await user();
    const other = await user();
    const id = await manager.createProject('共有案件');
    const { membershipId } = await inviteAndJoin(manager, member, id);
    const { membershipId: otherId } = await inviteAndJoin(manager, other, id);
    const managerMembershipId = (await manager.get(`/api/projects/${id}`)).body.access.membershipId;

    const detail = await member.get(`/api/projects/${id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.name, '共有案件');
    assert.equal(detail.body.access.role, 'member');
    assert.deepEqual(detail.body.access.actions, ['project.view', 'members.view']);
    const members = await member.get(`/api/projects/${id}/members`);
    assert.equal(members.status, 200);
    assert.equal(members.body.members.length, 3);
    assert.deepEqual(Object.keys(members.body.members[0]).sort(), ['displayName', 'hasDisplayName', 'id', 'isSelf', 'joinedAt', 'role']);

    const denied = [
      await member.patch(`/api/projects/${id}`, { name: '変更' }),
      await member.post(`/api/projects/${id}/invitations`),
      await member.get(`/api/projects/${id}/invitations`),
      await member.get(`/api/projects/${id}/audit`),
      await member.delete(`/api/projects/${id}/members/${otherId}`),
      await member.delete(`/api/projects/${id}/members/${managerMembershipId}`),
    ];
    for (const res of denied) {
      assert.equal(res.status, 403);
      assert.deepEqual(res.body, { error: 'forbidden' });
    }
    const inv = await manager.post(`/api/projects/${id}/invitations`);
    assert.equal((await member.delete(`/api/projects/${id}/invitations/${inv.body.id}`)).status, 403);
    assert.equal((await manager.get(`/api/projects/${id}`)).body.name, '共有案件');
    assert.equal((await manager.get(`/api/projects/${id}/members`)).body.members.length, 3);
    assert.ok(membershipId);
  });

  test('参加者一覧はユーザーIDを含まない', async () => {
    const manager = await user();
    const member = await user();
    const id = await manager.createProject();
    await inviteAndJoin(manager, member, id);
    const userIds = (await env.db.query('SELECT id FROM auth_users')).rows.map((r) => r.id);
    for (const c of [manager, member]) {
      const body = JSON.stringify((await c.get(`/api/projects/${id}/members`)).body);
      for (const u of userIds) assert.equal(body.includes(u), false);
    }
    const audit = JSON.stringify((await manager.get(`/api/projects/${id}/audit`)).body);
    for (const u of userIds) assert.equal(audit.includes(u), false);
  });
});
