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
  test('案件を作成すると作成者が全権限の管理者になる', async () => {
    const a = await user();
    const id = await a.createProject('案件A');
    const res = await a.get(`/api/projects/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.project.name, '案件A');
    assert.equal(res.body.project.status, 'planning');
    assert.ok(res.body.access.permissions.includes('members.manage'));
    // ユーザーIDは返さない
    assert.equal(JSON.stringify(res.body).includes('userId'), false);
  });

  test('不正な入力は拒否される', async () => {
    const a = await user();
    assert.equal((await a.post('/api/projects', { name: '' })).status, 400);
    assert.equal((await a.post('/api/projects', { name: 'x'.repeat(101) })).status, 400);
    assert.equal((await a.post('/api/projects', { name: 1 })).status, 400);
    const id = await a.createProject();
    assert.equal((await a.patch(`/api/projects/${id}`, { status: 'unknown' })).status, 400);
    assert.equal((await a.post(`/api/projects/${id}/products`, { productCode: 'lower', quantity: 1 })).status, 400);
    assert.equal((await a.post(`/api/projects/${id}/schedules`, { workType: 'installation', scheduledOn: '2026-13-40' })).status, 400);
  });

  test('案件を編集でき、イベントが記録される', async () => {
    const a = await user();
    const id = await a.createProject('旧名');
    assert.equal((await a.patch(`/api/projects/${id}`, { name: '新名', status: 'active' })).status, 204);
    assert.equal((await a.post(`/api/projects/${id}/products`, { productCode: 'RL-LOCK-01', quantity: 2 })).status, 201);
    assert.equal(
      (await a.post(`/api/projects/${id}/schedules`, { workType: 'installation', scheduledOn: '2026-11-01' })).status,
      201,
    );
    assert.equal(
      (await a.put(`/api/projects/${id}/contract`, { contractReference: 'C-0001', amountJpy: 120000, billingStatus: 'billed' })).status,
      204,
    );
    const p = await a.get(`/api/projects/${id}`);
    assert.equal(p.body.project.name, '新名');
    assert.equal(p.body.project.status, 'active');
    const events = await a.get(`/api/projects/${id}/events`);
    assert.deepEqual(
      events.body.events.map((e: any) => e.eventType),
      ['project_created', 'project_renamed', 'status_changed', 'product_added', 'schedule_added', 'contract_updated'],
    );
    const sc = events.body.events.find((e: any) => e.eventType === 'status_changed');
    assert.equal(sc.statusFrom, 'planning');
    assert.equal(sc.statusTo, 'active');
    assert.equal((await a.get(`/api/projects/${id}/contract`)).body.contract.amountJpy, '120000');
  });

  test('案件一覧には自分が参加している案件だけが表示される', async () => {
    const a = await user();
    const b = await user();
    const pa = await a.createProject('Aの案件');
    await b.createProject('Bの案件');
    const list = await a.get('/api/projects');
    assert.deepEqual(list.body.projects.map((p: any) => p.id), [pa]);
    assert.equal(list.body.total, 1);
  });

  test('他人の案件へのアクセスは存在しない案件と同じ404になる', async () => {
    const a = await user();
    const b = await user();
    const id = await a.createProject('秘密の案件');
    const paths = ['', '/products', '/schedules', '/contract', '/events', '/members', '/invitations', '/audit'];
    for (const suffix of paths) {
      const own = await b.get(`/api/projects/${id}${suffix}`);
      const missing = await b.get(`/api/projects/${randomUUID()}${suffix}`);
      const malformed = await b.get(`/api/projects/not-a-uuid${suffix}`);
      assert.equal(own.status, 404, suffix);
      assert.deepEqual(own.body, missing.body);
      assert.deepEqual(own.body, malformed.body);
    }
    assert.equal((await b.patch(`/api/projects/${id}`, { name: '乗っ取り' })).status, 404);
    assert.equal((await b.put(`/api/projects/${id}/contract`, { contractReference: 'X', amountJpy: 1, billingStatus: 'paid' })).status, 404);
    assert.equal((await b.post(`/api/projects/${id}/invitations`, { role: 'other', permissions: ['members.manage'] })).status, 404);
    assert.equal((await b.delete(`/api/projects/${id}/members/${randomUUID()}`)).status, 404);
    assert.equal((await a.get(`/api/projects/${id}`)).body.project.name, '秘密の案件');
  });

  test('案件IDを書き換えても自分の権限は他の案件に及ばない', async () => {
    const a = await user();
    const b = await user();
    const aProject = await a.createProject('Aの案件');
    const bProject = await b.createProject('Bの案件');
    // B の案件で取得した参加関係IDを A の案件のパスに使っても操作できない
    const bMembers = await b.get(`/api/projects/${bProject}/members`);
    const bMembershipId = bMembers.body.members[0].id;
    assert.equal((await b.patch(`/api/projects/${aProject}/members/${bMembershipId}`, { permissions: ['members.manage'] })).status, 404);
    assert.equal((await b.patch(`/api/projects/${bProject}/members/${bMembershipId}`, { role: 'other' })).status, 204);
    // A の参加関係IDを B の案件のパスで操作しても見つからない
    const aMembershipId = (await a.get(`/api/projects/${aProject}/members`)).body.members[0].id;
    assert.equal((await b.delete(`/api/projects/${bProject}/members/${aMembershipId}`)).status, 404);
    assert.equal((await a.get(`/api/projects/${aProject}`)).status, 200);
  });

  test('未ログインでは案件APIを利用できない', async () => {
    const c = env.client();
    await c.init();
    assert.equal((await c.get('/api/projects')).status, 401);
    assert.equal((await c.post('/api/projects', { name: 'x' })).status, 401);
  });

  test('検索結果と件数に他人の案件や閲覧権限のない案件名は含まれない', async () => {
    const a = await user();
    const b = await user();
    await a.createProject('共通キーワード Aの案件');
    const bProject = await b.createProject('共通キーワード Bの案件');
    // A は B の案件に参加するが project.view を持たない
    await inviteAndJoin(b, a, bProject, ['details.view']);
    const search = await a.get(`/api/projects?q=${encodeURIComponent('Bの案件')}`);
    assert.equal(search.body.total, 0);
    const all = await a.get(`/api/projects?q=${encodeURIComponent('共通キーワード')}`);
    assert.equal(all.body.total, 1);
    // 一覧には参加中として表示されるが名前・状態は返さない
    const list = await a.get('/api/projects');
    const entry = list.body.projects.find((p: any) => p.id === bProject);
    assert.equal(entry.name, null);
    assert.equal(entry.status, null);
  });
});

describe('案件内の権限', () => {
  test('権限が限定された参加者は許可された情報だけを閲覧・操作できる', async () => {
    const manager = await user();
    const installer = await user();
    const id = await manager.createProject('施工案件');
    await manager.put(`/api/projects/${id}/contract`, { contractReference: 'C-1', amountJpy: 500000, billingStatus: 'not_billed' });
    await manager.post(`/api/projects/${id}/schedules`, { workType: 'installation', scheduledOn: '2026-12-01' });
    await inviteAndJoin(manager, installer, id, ['project.view', 'details.view']);

    const detail = await installer.get(`/api/projects/${id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.project.name, '施工案件');
    assert.deepEqual(detail.body.access.permissions, ['project.view', 'details.view']);
    assert.equal((await installer.get(`/api/projects/${id}/schedules`)).body.schedules.length, 1);

    // 参加者であっても権限のない情報・操作は拒否される
    assert.equal((await installer.get(`/api/projects/${id}/contract`)).status, 403);
    assert.equal((await installer.get(`/api/projects/${id}/events`)).status, 403);
    assert.equal((await installer.get(`/api/projects/${id}/members`)).status, 403);
    assert.equal((await installer.get(`/api/projects/${id}/audit`)).status, 403);
    assert.equal((await installer.patch(`/api/projects/${id}`, { status: 'completed' })).status, 403);
    assert.equal((await installer.post(`/api/projects/${id}/schedules`, { workType: 'maintenance', scheduledOn: '2027-01-01' })).status, 403);
    assert.equal((await installer.post(`/api/projects/${id}/invitations`, { role: 'other', permissions: [] })).status, 403);
    // 403 の本文に権限のない情報は含まれない
    const denied = await installer.get(`/api/projects/${id}/contract`);
    assert.deepEqual(denied.body, { error: 'forbidden' });
  });

  test('編集権限を付与すると対応する閲覧権限も付与される', async () => {
    const manager = await user();
    const member = await user();
    const id = await manager.createProject();
    await inviteAndJoin(manager, member, id, ['contract.edit']);
    const detail = await member.get(`/api/projects/${id}`);
    assert.deepEqual(detail.body.access.permissions, ['contract.view', 'contract.edit']);
    assert.equal(detail.body.project, null);
  });

  test('権限変更は既存セッションに即時反映される', async () => {
    const manager = await user();
    const member = await user();
    const id = await manager.createProject();
    const { membershipId } = await inviteAndJoin(manager, member, id, ['project.view', 'contract.view']);
    assert.equal((await member.get(`/api/projects/${id}/contract`)).status, 200);
    assert.equal(
      (await manager.patch(`/api/projects/${id}/members/${membershipId}`, { permissions: ['project.view'] })).status,
      204,
    );
    assert.equal((await member.get(`/api/projects/${id}/contract`)).status, 403);
    assert.equal((await member.get(`/api/projects/${id}`)).status, 200);
  });

  test('参加関係の有効期限を過ぎるとアクセスできない', async () => {
    const manager = await user();
    const member = await user();
    const id = await manager.createProject();
    const { membershipId } = await inviteAndJoin(manager, member, id, ['project.view']);
    const until = new Date(Date.now() + 60_000).toISOString();
    assert.equal((await manager.patch(`/api/projects/${id}/members/${membershipId}`, { validUntil: until })).status, 204);
    assert.equal((await member.get(`/api/projects/${id}`)).status, 200);
    await env.db.query(
      "UPDATE project_memberships SET created_at = now() - interval '2 days', valid_until = now() - interval '1 second' WHERE id = $1",
      [membershipId],
    );
    assert.equal((await member.get(`/api/projects/${id}`)).status, 404);
    assert.equal((await member.get('/api/projects')).body.total, 0);
  });
});
