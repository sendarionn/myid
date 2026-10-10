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

describe('招待', () => {
  test('管理者が招待リンクを発行し、受諾した人が一般参加者として参加できる', async () => {
    const manager = await user();
    const invitee = await user();
    const id = await manager.createProject('招待テスト');
    const inv = await manager.post(`/api/projects/${id}/invitations`);
    assert.equal(inv.status, 201);
    assert.match(inv.body.token, /^[A-Za-z0-9_-]{43}$/);
    // 有効期限は72時間に固定
    const ttl = new Date(inv.body.expiresAt).getTime() - Date.now();
    assert.ok(ttl > 71 * 3600_000 && ttl <= 72 * 3600_000);
    // トークンは平文で保存しない
    const stored = await env.db.query('SELECT token_hash FROM project_invitations WHERE id = $1', [inv.body.id]);
    assert.notEqual(stored.rows[0].token_hash.toString('base64url'), inv.body.token);
    // 招待一覧にトークンは含まれない
    const list = await manager.get(`/api/projects/${id}/invitations`);
    assert.equal(JSON.stringify(list.body).includes(inv.body.token), false);
    assert.equal(list.body.invitations[0].status, 'pending');

    const acc = await invitee.post('/api/invitations/accept', { token: inv.body.token });
    assert.equal(acc.status, 201);
    assert.equal(acc.body.projectId, id);
    const detail = await invitee.get(`/api/projects/${id}`);
    assert.equal(detail.body.access.role, 'member');
    assert.equal(detail.body.name, '招待テスト');
    const listed = await invitee.get('/api/projects');
    assert.deepEqual(listed.body.projects.map((p: any) => [p.id, p.role]), [[id, 'member']]);
    assert.equal((await manager.get(`/api/projects/${id}/invitations`)).body.invitations[0].status, 'accepted');
  });

  test('招待時に役割・権限・承認制・有効期限を指定しても反映されない', async () => {
    const manager = await user();
    const invitee = await user();
    const id = await manager.createProject();
    const inv = await manager.post(`/api/projects/${id}/invitations`, {
      role: 'manager',
      permissions: ['members.manage', 'project.edit'],
      requiresApproval: true,
      ttlHours: 168,
    });
    assert.equal(inv.status, 201);
    assert.ok(new Date(inv.body.expiresAt).getTime() - Date.now() <= 72 * 3600_000);
    const acc = await invitee.post('/api/invitations/accept', { token: inv.body.token, role: 'manager' });
    assert.equal(acc.status, 201);
    const detail = await invitee.get(`/api/projects/${id}`);
    assert.equal(detail.body.access.role, 'member');
    // 管理操作はできない
    assert.equal((await invitee.post(`/api/projects/${id}/invitations`)).status, 403);
    assert.equal((await invitee.patch(`/api/projects/${id}`, { name: 'x' })).status, 403);
  });

  test('招待の受諾にはログインが必要で、トークンだけでは案件情報を得られない', async () => {
    const manager = await user();
    const id = await manager.createProject('非公開の案件名');
    const inv = await manager.post(`/api/projects/${id}/invitations`);
    const anon = env.client();
    await anon.init();
    const res = await anon.post('/api/invitations/accept', { token: inv.body.token });
    assert.equal(res.status, 401);
    assert.equal(JSON.stringify(res.body).includes('非公開の案件名'), false);
    // 未使用のまま残る
    const invitee = await user();
    assert.equal((await invitee.post('/api/invitations/accept', { token: inv.body.token })).status, 201);
  });

  test('取り消した招待は使用できない', async () => {
    const manager = await user();
    const invitee = await user();
    const id = await manager.createProject();
    const inv = await manager.post(`/api/projects/${id}/invitations`);
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
    const inv = await manager.post(`/api/projects/${id}/invitations`);
    await env.db.query(
      "UPDATE project_invitations SET created_at = now() - interval '4 days', expires_at = now() - interval '1 second' WHERE id = $1",
      [inv.body.id],
    );
    const res = await invitee.post('/api/invitations/accept', { token: inv.body.token });
    assert.equal(res.status, 404);
    assert.equal((await manager.get(`/api/projects/${id}/invitations`)).body.invitations[0].status, 'expired');
    assert.equal((await invitee.get(`/api/projects/${id}`)).status, 404);
  });

  test('使用済みの招待は再利用できない', async () => {
    const manager = await user();
    const first = await user();
    const second = await user();
    const id = await manager.createProject();
    const inv = await manager.post(`/api/projects/${id}/invitations`);
    assert.equal((await first.post('/api/invitations/accept', { token: inv.body.token })).status, 201);
    assert.equal((await second.post('/api/invitations/accept', { token: inv.body.token })).status, 404);
    assert.equal((await second.get(`/api/projects/${id}`)).status, 404);
  });

  test('同じ招待を同時に使用しても参加できるのは1人だけ', async () => {
    const manager = await user();
    const id = await manager.createProject();
    const inv = await manager.post(`/api/projects/${id}/invitations`);
    const users = await Promise.all(Array.from({ length: 10 }, () => user()));
    const results = await Promise.all(users.map((u) => u.post('/api/invitations/accept', { token: inv.body.token })));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(results.filter((r) => r.status === 404).length, 9);
    assert.equal((await manager.get(`/api/projects/${id}/members`)).body.members.length, 2);
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
    await inviteAndJoin(manager, member, id);
    const inv = await manager.post(`/api/projects/${id}/invitations`);
    assert.equal((await member.post('/api/invitations/accept', { token: inv.body.token })).status, 409);
    assert.equal((await manager.post('/api/invitations/accept', { token: inv.body.token })).status, 409);
    assert.equal((await other.post('/api/invitations/accept', { token: inv.body.token })).status, 201);
  });

  test('参加を解除すると即時にアクセスできなくなる', async () => {
    const manager = await user();
    const member = await user();
    const id = await manager.createProject();
    const { membershipId } = await inviteAndJoin(manager, member, id);
    assert.equal((await member.get(`/api/projects/${id}`)).status, 200);
    assert.equal((await manager.delete(`/api/projects/${id}/members/${membershipId}`)).status, 204);
    assert.equal((await member.get(`/api/projects/${id}`)).status, 404);
    assert.equal((await member.get(`/api/projects/${id}/members`)).status, 404);
    assert.equal((await member.get('/api/projects')).body.total, 0);
    const audit = await manager.get(`/api/projects/${id}/audit`);
    assert.ok(audit.body.audit.some((e: any) => e.action === 'member_revoked' && e.targetMembershipId === membershipId));
  });

  test('解除された管理者が発行した未使用の招待は失効する', async () => {
    const owner = await user();
    const sub = await user();
    const id = await owner.createProject();
    const { membershipId } = await inviteAndJoin(owner, sub, id);
    await promoteToManager(env, membershipId);
    const inv = await sub.post(`/api/projects/${id}/invitations`);
    assert.equal(inv.status, 201);
    assert.equal((await owner.delete(`/api/projects/${id}/members/${membershipId}`)).status, 204);
    const late = await user();
    assert.equal((await late.post('/api/invitations/accept', { token: inv.body.token })).status, 404);
  });
});

describe('他案件のIDを使った操作', () => {
  test('他案件の招待IDは自分の案件のパスで取り消せない', async () => {
    const a = await user();
    const b = await user();
    const invitee = await user();
    const aProject = await a.createProject();
    const bProject = await b.createProject();
    const inv = await b.post(`/api/projects/${bProject}/invitations`);
    assert.equal((await a.delete(`/api/projects/${aProject}/invitations/${inv.body.id}`)).status, 404);
    assert.equal((await invitee.post('/api/invitations/accept', { token: inv.body.token })).status, 201);
  });

  test('他案件の参加関係IDは自分の案件のパスで解除できない', async () => {
    const a = await user();
    const b = await user();
    const member = await user();
    const aProject = await a.createProject();
    const bProject = await b.createProject();
    const { membershipId } = await inviteAndJoin(b, member, bProject);
    assert.equal((await a.delete(`/api/projects/${aProject}/members/${membershipId}`)).status, 404);
    assert.equal((await member.get(`/api/projects/${bProject}`)).status, 200);
  });
});

describe('参加者管理', () => {
  test('未設定の表示名は安定した仮表示になる', async () => {
    const manager = await user();
    const first = await user();
    const second = await user();
    const id = await manager.createProject();
    await inviteAndJoin(manager, first, id);
    await inviteAndJoin(manager, second, id);

    const initial = await manager.get(`/api/projects/${id}/members`);
    assert.deepEqual(initial.body.members.map((m: any) => m.displayName), ['参加者1', '参加者2', '参加者3']);
    assert.deepEqual(Object.keys(initial.body.members[0]).sort(), ['displayName', 'hasDisplayName', 'id', 'isSelf', 'joinedAt', 'role']);

    await env.db.query('UPDATE project_memberships SET created_at = now() - display_number * interval \'1 day\' WHERE project_id = $1', [id]);
    const reordered = await manager.get(`/api/projects/${id}/members`);
    assert.deepEqual(
      Object.fromEntries(reordered.body.members.map((m: any) => [m.id, m.displayName])),
      Object.fromEntries(initial.body.members.map((m: any) => [m.id, m.displayName])),
    );
  });

  test('自分の表示名を案件ごとに変更でき、重複も許可する', async () => {
    const manager = await user();
    const member = await user();
    const projectA = await manager.createProject('A');
    const projectB = await manager.createProject('B');
    await inviteAndJoin(manager, member, projectA);

    assert.equal((await manager.patch(`/api/projects/${projectA}/membership`, { displayName: '  田中 taro  ' })).status, 204);
    assert.equal((await member.patch(`/api/projects/${projectA}/membership`, { displayName: '田中 taro' })).status, 204);
    const names = (await manager.get(`/api/projects/${projectA}/members`)).body.members.map((m: any) => m.displayName);
    assert.deepEqual(names, ['田中 taro', '田中 taro']);
    assert.equal((await manager.get(`/api/projects/${projectB}/members`)).body.members[0].displayName, '参加者1');

    assert.equal((await manager.patch(`/api/projects/${projectA}/membership`, { displayName: '   ' })).status, 204);
    assert.equal((await manager.get(`/api/projects/${projectA}/members`)).body.members[0].displayName, '参加者1');

    assert.equal((await manager.patch(`/api/projects/${projectA}/membership`, { displayName: '<script>alert(1)</script>' })).status, 204);
    assert.equal((await manager.get(`/api/projects/${projectA}/members`)).body.members[0].displayName, '<script>alert(1)</script>');
  });

  test('表示名の入力を検証する', async () => {
    const a = await user();
    const id = await a.createProject();
    for (const displayName of ['x'.repeat(101), 'a\nb', 1, null]) {
      assert.equal((await a.patch(`/api/projects/${id}/membership`, { displayName })).status, 400, JSON.stringify(displayName));
    }
    assert.equal((await a.get(`/api/projects/${id}/members`)).body.members[0].displayName, '参加者1');
  });

  test('他人や他案件の表示名は変更できず、表示名は認可に影響しない', async () => {
    const manager = await user();
    const member = await user();
    const outsider = await user();
    const id = await manager.createProject();
    const { membershipId } = await inviteAndJoin(manager, member, id);

    assert.equal((await manager.patch(`/api/projects/${id}/members/${membershipId}`, { displayName: '改ざん' })).status, 404);
    assert.equal((await outsider.patch(`/api/projects/${id}/membership`, { displayName: '部外者' })).status, 404);
    assert.equal((await member.patch(`/api/projects/${id}/membership`, { displayName: '管理者' })).status, 204);
    assert.equal((await member.post(`/api/projects/${id}/invitations`)).status, 403);
    assert.equal((await manager.delete(`/api/projects/${id}/members/${membershipId}`)).status, 204);
  });

  test('最後の管理者は退出できない', async () => {
    const manager = await user();
    const member = await user();
    const id = await manager.createProject();
    await inviteAndJoin(manager, member, id);
    const self = (await manager.get(`/api/projects/${id}`)).body.access.membershipId;
    const res = await manager.delete(`/api/projects/${id}/members/${self}`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'last_manager');
    assert.equal((await manager.get(`/api/projects/${id}`)).body.access.role, 'manager');
  });

  test('2人の管理者が同時に互いを解除しても管理者は残る', async () => {
    const a = await user();
    const b = await user();
    const id = await a.createProject();
    const { membershipId: bId } = await inviteAndJoin(a, b, id);
    await promoteToManager(env, bId);
    const aId = (await a.get(`/api/projects/${id}`)).body.access.membershipId;
    const results = await Promise.all([
      a.delete(`/api/projects/${id}/members/${bId}`),
      b.delete(`/api/projects/${id}/members/${aId}`),
    ]);
    assert.equal(results.filter((r) => r.status === 204).length, 1);
    const managers = await env.db.query(
      "SELECT count(*)::int AS n FROM project_memberships WHERE project_id = $1 AND role = 'manager'",
      [id],
    );
    assert.equal(managers.rows[0].n, 1);
  });

  test('一般参加者は自分だけ退出できる', async () => {
    const manager = await user();
    const m1 = await user();
    const m2 = await user();
    const id = await manager.createProject();
    const { membershipId: id1 } = await inviteAndJoin(manager, m1, id);
    await inviteAndJoin(manager, m2, id);
    assert.equal((await m1.delete(`/api/projects/${id}/members/${id1}`)).status, 204);
    assert.equal((await m1.get(`/api/projects/${id}`)).status, 404);
    assert.equal((await m2.get(`/api/projects/${id}`)).status, 200);
    const audit = (await manager.get(`/api/projects/${id}/audit`)).body.audit;
    assert.ok(audit.some((e: any) => e.action === 'member_left' && e.targetMembershipId === id1));
  });

  test('DB制約: 管理者が0人になる変更はアプリを経由しなくても拒否される', async () => {
    const a = await user();
    const id = await a.createProject();
    await assert.rejects(
      env.db.query("UPDATE project_memberships SET role = 'member' WHERE project_id = $1", [id]),
      (err: any) => err.code === 'MI001',
    );
    await assert.rejects(
      env.db.query('DELETE FROM project_memberships WHERE project_id = $1', [id]),
      (err: any) => err.code === 'MI001',
    );
    await assert.rejects(
      env.db.query("INSERT INTO projects (name) VALUES ('管理者なし')"),
      (err: any) => err.code === 'MI001',
    );
  });

  test('DB制約: 参加関係の役割は manager と member だけ', async () => {
    const a = await user();
    const id = await a.createProject();
    await assert.rejects(
      env.db.query("UPDATE project_memberships SET role = 'owner' WHERE project_id = $1", [id]),
      (err: any) => err.code === '22P02',
    );
  });
});
