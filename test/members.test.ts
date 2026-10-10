import assert from 'node:assert/strict';
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

const ALL = ['project.view', 'project.edit', 'details.view', 'details.edit', 'contract.view', 'contract.edit', 'events.view', 'members.manage'];

describe('招待', () => {
  test('招待を発行・受諾すると指定した役割と権限で参加できる', async () => {
    const manager = await user();
    const invitee = await user();
    const id = await manager.createProject('招待テスト');
    const inv = await manager.post(`/api/projects/${id}/invitations`, {
      role: 'maintainer',
      permissions: ['project.view', 'events.view'],
      ttlHours: 24,
    });
    assert.equal(inv.status, 201);
    assert.match(inv.body.token, /^[A-Za-z0-9_-]{43}$/);
    // トークンは平文で保存しない
    const stored = await env.db.query('SELECT token_hash FROM project_invitations WHERE id = $1', [inv.body.id]);
    assert.notEqual(stored.rows[0].token_hash.toString('base64url'), inv.body.token);
    // 招待一覧にトークンは含まれない
    const list = await manager.get(`/api/projects/${id}/invitations`);
    assert.equal(JSON.stringify(list.body).includes(inv.body.token), false);
    assert.equal(list.body.invitations[0].status, 'pending');

    const acc = await invitee.post('/api/invitations/accept', { token: inv.body.token });
    assert.equal(acc.status, 201);
    assert.equal(acc.body.membershipStatus, 'active');
    const detail = await invitee.get(`/api/projects/${id}`);
    assert.equal(detail.body.access.role, 'maintainer');
    assert.deepEqual(detail.body.access.permissions, ['project.view', 'events.view']);
    assert.equal((await manager.get(`/api/projects/${id}/invitations`)).body.invitations[0].status, 'accepted');
  });

  test('招待の受諾にはログインが必要', async () => {
    const manager = await user();
    const id = await manager.createProject();
    const inv = await manager.post(`/api/projects/${id}/invitations`, { role: 'other', permissions: ['project.view'] });
    const anon = env.client();
    await anon.init();
    assert.equal((await anon.post('/api/invitations/accept', { token: inv.body.token })).status, 401);
    // 未使用のまま残る
    const invitee = await user();
    assert.equal((await invitee.post('/api/invitations/accept', { token: inv.body.token })).status, 201);
  });

  test('取り消した招待は使用できない', async () => {
    const manager = await user();
    const invitee = await user();
    const id = await manager.createProject();
    const inv = await manager.post(`/api/projects/${id}/invitations`, { role: 'other', permissions: ['project.view'] });
    assert.equal((await manager.delete(`/api/projects/${id}/invitations/${inv.body.id}`)).status, 204);
    const res = await invitee.post('/api/invitations/accept', { token: inv.body.token });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'invitation_invalid');
    assert.equal((await invitee.get(`/api/projects/${id}`)).status, 404);
  });

  test('期限切れの招待は使用できない', async () => {
    const manager = await user();
    const invitee = await user();
    const id = await manager.createProject();
    const inv = await manager.post(`/api/projects/${id}/invitations`, { role: 'other', permissions: ['project.view'] });
    await env.db.query(
      "UPDATE project_invitations SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second' WHERE id = $1",
      [inv.body.id],
    );
    const res = await invitee.post('/api/invitations/accept', { token: inv.body.token });
    assert.equal(res.status, 404);
    assert.equal((await manager.get(`/api/projects/${id}/invitations`)).body.invitations[0].status, 'expired');
  });

  test('使用済みの招待は再利用できない', async () => {
    const manager = await user();
    const first = await user();
    const second = await user();
    const id = await manager.createProject();
    const inv = await manager.post(`/api/projects/${id}/invitations`, { role: 'other', permissions: ['project.view'] });
    assert.equal((await first.post('/api/invitations/accept', { token: inv.body.token })).status, 201);
    assert.equal((await second.post('/api/invitations/accept', { token: inv.body.token })).status, 404);
    assert.equal((await second.get(`/api/projects/${id}`)).status, 404);
  });

  test('同じ招待を同時に使用しても参加できるのは1人だけ', async () => {
    const manager = await user();
    const id = await manager.createProject();
    const inv = await manager.post(`/api/projects/${id}/invitations`, { role: 'other', permissions: ['project.view'] });
    const users = await Promise.all(Array.from({ length: 10 }, () => user()));
    const results = await Promise.all(users.map((u) => u.post('/api/invitations/accept', { token: inv.body.token })));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(results.filter((r) => r.status === 404).length, 9);
    const members = await manager.get(`/api/projects/${id}/members`);
    assert.equal(members.body.members.length, 2);
  });

  test('不正・推測したトークンは同じエラーになる', async () => {
    const u = await user();
    const a = await u.post('/api/invitations/accept', { token: 'short' });
    const b = await u.post('/api/invitations/accept', { token: 'A'.repeat(43) });
    assert.equal(a.status, 404);
    assert.deepEqual(a.body, b.body);
  });

  test('既に参加している案件の招待は消費されない', async () => {
    const manager = await user();
    const member = await user();
    const other = await user();
    const id = await manager.createProject();
    await inviteAndJoin(manager, member, id, ['project.view']);
    const inv = await manager.post(`/api/projects/${id}/invitations`, { role: 'other', permissions: ['project.view'] });
    assert.equal((await member.post('/api/invitations/accept', { token: inv.body.token })).status, 409);
    assert.equal((await other.post('/api/invitations/accept', { token: inv.body.token })).status, 201);
  });

  test('members.manage を持たない参加者は招待を発行・取消できない', async () => {
    const manager = await user();
    const member = await user();
    const id = await manager.createProject();
    await inviteAndJoin(manager, member, id, ['project.view', 'project.edit', 'contract.edit']);
    assert.equal((await member.post(`/api/projects/${id}/invitations`, { role: 'other', permissions: ALL })).status, 403);
    const inv = await manager.post(`/api/projects/${id}/invitations`, { role: 'other', permissions: [] });
    assert.equal((await member.delete(`/api/projects/${id}/invitations/${inv.body.id}`)).status, 403);
    assert.equal((await member.get(`/api/projects/${id}/invitations`)).status, 403);
  });

  test('承認制の招待は管理者の承認まで案件情報にアクセスできない', async () => {
    const manager = await user();
    const invitee = await user();
    const id = await manager.createProject('承認制');
    const inv = await manager.post(`/api/projects/${id}/invitations`, {
      role: 'contractor',
      permissions: ['project.view'],
      requiresApproval: true,
    });
    const acc = await invitee.post('/api/invitations/accept', { token: inv.body.token });
    assert.equal(acc.body.membershipStatus, 'pending_approval');
    assert.equal((await invitee.get(`/api/projects/${id}`)).status, 404);
    const listed = (await invitee.get('/api/projects')).body.projects[0];
    assert.equal(listed.membershipStatus, 'pending_approval');
    assert.equal(listed.name, null);
    assert.equal((await manager.post(`/api/projects/${id}/members/${acc.body.membershipId}/approve`)).status, 204);
    assert.equal((await invitee.get(`/api/projects/${id}`)).body.project.name, '承認制');
  });

  test('招待で参加した後に権限を失効すると即時にアクセスできなくなる', async () => {
    const manager = await user();
    const member = await user();
    const id = await manager.createProject();
    const { membershipId } = await inviteAndJoin(manager, member, id, ['project.view', 'details.view']);
    assert.equal((await member.get(`/api/projects/${id}/products`)).status, 200);
    assert.equal((await manager.delete(`/api/projects/${id}/members/${membershipId}`)).status, 204);
    assert.equal((await member.get(`/api/projects/${id}`)).status, 404);
    assert.equal((await member.get(`/api/projects/${id}/products`)).status, 404);
    assert.equal((await member.get('/api/projects')).body.total, 0);
    const audit = await manager.get(`/api/projects/${id}/audit`);
    assert.ok(audit.body.audit.some((e: any) => e.action === 'member_revoked' && e.targetMembershipId === membershipId));
  });

  test('管理者を失効すると、その管理者が発行した未使用の招待も失効する', async () => {
    const owner = await user();
    const sub = await user();
    const id = await owner.createProject();
    const { membershipId } = await inviteAndJoin(owner, sub, id, ['members.manage']);
    const inv = await sub.post(`/api/projects/${id}/invitations`, { role: 'other', permissions: ['project.view'] });
    assert.equal(inv.status, 201);
    assert.equal((await owner.patch(`/api/projects/${id}/members/${membershipId}`, { permissions: [] })).status, 204);
    const late = await user();
    assert.equal((await late.post('/api/invitations/accept', { token: inv.body.token })).status, 404);
  });
});

describe('参加者管理', () => {
  test('最後の管理者は自分の管理権限を外せず、退出もできない', async () => {
    const manager = await user();
    const id = await manager.createProject();
    const self = (await manager.get(`/api/projects/${id}/members`)).body.members[0];
    const res = await manager.patch(`/api/projects/${id}/members/${self.id}`, { permissions: ['project.view'] });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'last_manager');
    assert.equal((await manager.delete(`/api/projects/${id}/members/${self.id}`)).status, 409);
    const until = new Date(Date.now() + 3600_000).toISOString();
    assert.equal((await manager.patch(`/api/projects/${id}/members/${self.id}`, { validUntil: until })).status, 409);
    assert.ok((await manager.get(`/api/projects/${id}`)).body.access.permissions.includes('members.manage'));
  });

  test('2人の管理者が同時に互いを失効しても管理者は残る', async () => {
    const a = await user();
    const b = await user();
    const id = await a.createProject();
    const { membershipId: bId } = await inviteAndJoin(a, b, id, ALL);
    const aId = (await a.get(`/api/projects/${id}`)).body.access.membershipId;
    const results = await Promise.all([
      a.delete(`/api/projects/${id}/members/${bId}`),
      b.delete(`/api/projects/${id}/members/${aId}`),
    ]);
    assert.equal(results.filter((r) => r.status === 204).length, 1);
    const managers = await env.db.query(
      `SELECT count(*)::int AS n FROM project_memberships m JOIN project_permissions p ON p.membership_id = m.id
       WHERE m.project_id = $1 AND p.permission = 'members.manage'`,
      [id],
    );
    assert.equal(managers.rows[0].n, 1);
  });

  test('管理権限を移譲すれば元の管理者は退出できる', async () => {
    const a = await user();
    const b = await user();
    const id = await a.createProject();
    await inviteAndJoin(a, b, id, ['project.view']);
    const members = (await a.get(`/api/projects/${id}/members`)).body.members;
    const bId = members.find((m: any) => !m.isSelf).id;
    const aId = members.find((m: any) => m.isSelf).id;
    assert.equal((await a.patch(`/api/projects/${id}/members/${bId}`, { permissions: ALL })).status, 204);
    assert.equal((await a.delete(`/api/projects/${id}/members/${aId}`)).status, 204);
    assert.equal((await a.get(`/api/projects/${id}`)).status, 404);
    assert.equal((await b.get(`/api/projects/${id}/members`)).body.members.length, 1);
  });

  test('一般参加者は自分だけ退出でき、他の参加者は失効できない', async () => {
    const manager = await user();
    const m1 = await user();
    const m2 = await user();
    const id = await manager.createProject();
    const { membershipId: id1 } = await inviteAndJoin(manager, m1, id, ['project.view']);
    const { membershipId: id2 } = await inviteAndJoin(manager, m2, id, ['project.view']);
    assert.equal((await m1.delete(`/api/projects/${id}/members/${id2}`)).status, 403);
    assert.equal((await m1.delete(`/api/projects/${id}/members/${id1}`)).status, 204);
    assert.equal((await m1.get(`/api/projects/${id}`)).status, 404);
    assert.equal((await m2.get(`/api/projects/${id}`)).status, 200);
  });

  test('参加者一覧と監査ログはユーザーIDを含まず、権限変更が記録される', async () => {
    const manager = await user();
    const member = await user();
    const id = await manager.createProject();
    const { membershipId } = await inviteAndJoin(manager, member, id, ['project.view']);
    await manager.patch(`/api/projects/${id}/members/${membershipId}`, { role: 'contractor', permissions: ['project.view', 'events.view'] });
    const members = await manager.get(`/api/projects/${id}/members`);
    const audit = await manager.get(`/api/projects/${id}/audit`);
    const userIds = (await env.db.query('SELECT id FROM auth_users')).rows.map((r) => r.id);
    for (const uid of userIds) {
      assert.equal(JSON.stringify(members.body).includes(uid), false);
      assert.equal(JSON.stringify(audit.body).includes(uid), false);
    }
    const updated = audit.body.audit.find((e: any) => e.action === 'member_updated');
    assert.equal(updated.role, 'contractor');
    assert.deepEqual(updated.permissions, ['project.view', 'events.view']);
    assert.deepEqual(
      audit.body.audit.map((e: any) => e.action),
      ['member_added', 'invitation_created', 'member_added', 'member_updated'],
    );
  });
});
