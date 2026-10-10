import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import pg from 'pg';
import { migrate } from '../src/migrate.ts';

const adminUrl = process.env.TEST_PG_ADMIN_URL!;
const created: string[] = [];

async function admin(sql: string) {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  await c.query(sql);
  await c.end();
}

async function freshDb(): Promise<string> {
  const name = `myid_migrate_${randomBytes(6).toString('hex')}`;
  await admin(`CREATE DATABASE ${name}`);
  created.push(name);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

after(async () => {
  for (const name of created) await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
});

const allMigrations = async () =>
  (await readdir(path.join(import.meta.dirname, '..', 'migrations'))).filter((f) => f.endsWith('.sql')).sort();

test('空のDBにマイグレーションを適用でき、再実行しても変化しない', async () => {
  const url = await freshDb();
  assert.deepEqual(await migrate(url), await allMigrations());
  assert.deepEqual(await migrate(url), []);
});

test('適用済みマイグレーションの内容が変わっていれば停止する', async () => {
  const url = await freshDb();
  await migrate(url);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = '001_initial.sql'");
  await c.end();
  await assert.rejects(migrate(url), /applied migration was modified/);
});

test('002: 既存の製品コード・契約番号は変換されず、適用後は小文字・日本語を保存できる', async () => {
  const url = await freshDb();
  assert.deepEqual(await migrate(url, { until: '001_initial.sql' }), ['001_initial.sql']);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('BEGIN');
  const user = await c.query("INSERT INTO auth_users (webauthn_user_handle) VALUES ($1) RETURNING id", [randomBytes(32)]);
  const project = await c.query("INSERT INTO projects (name) VALUES ('移行テスト') RETURNING id");
  const projectId = project.rows[0].id;
  const m = await c.query(
    "INSERT INTO project_memberships (project_id, user_id, role, status) VALUES ($1, $2, 'customer', 'active') RETURNING id",
    [projectId, user.rows[0].id],
  );
  await c.query("INSERT INTO project_permissions (membership_id, permission) VALUES ($1, 'members.manage')", [m.rows[0].id]);
  await c.query("INSERT INTO project_products (project_id, product_code, quantity) VALUES ($1, 'RL-LOCK-01', 1)", [projectId]);
  await c.query(
    "INSERT INTO project_contracts (project_id, contract_reference, amount_jpy, billing_status) VALUES ($1, 'C-0001', 1, 'paid')",
    [projectId],
  );
  await c.query('COMMIT');
  // 旧制約では小文字を保存できない
  await assert.rejects(
    c.query("INSERT INTO project_products (project_id, product_code, quantity) VALUES ($1, 'rl-lock-01', 1)", [projectId]),
    (err: any) => err.code === '23514',
  );

  assert.deepEqual(await migrate(url, { until: '002_relax_reference_codes.sql' }), ['002_relax_reference_codes.sql']);
  const products = await c.query('SELECT product_code FROM project_products ORDER BY created_at');
  assert.deepEqual(products.rows.map((r) => r.product_code), ['RL-LOCK-01']);
  const contract = await c.query('SELECT contract_reference FROM project_contracts');
  assert.equal(contract.rows[0].contract_reference, 'C-0001');

  await c.query("INSERT INTO project_products (project_id, product_code, quantity) VALUES ($1, 'rl-lock-01 本体', 1)", [projectId]);
  // DB制約でも前後の空白・制御文字・長さを拒否する
  for (const bad of [' lead', 'trail ', 'a\nb', 'x'.repeat(65), '']) {
    await assert.rejects(
      c.query('INSERT INTO project_products (project_id, product_code, quantity) VALUES ($1, $2, 1)', [projectId, bad]),
      (err: any) => err.code === '23514',
      JSON.stringify(bad),
    );
  }
  await c.end();
});

test('003: 権限を役割に変換し、承認待ち・期限付きの参加と廃止した業務データを削除する', async () => {
  const url = await freshDb();
  await migrate(url, { until: '002_relax_reference_codes.sql' });
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const newUser = async () =>
    (await c.query('INSERT INTO auth_users (webauthn_user_handle) VALUES ($1) RETURNING id', [randomBytes(32)])).rows[0].id;
  await c.query('BEGIN');
  const projectId = (await c.query("INSERT INTO projects (name, status) VALUES ('移行', 'active') RETURNING id")).rows[0].id;
  const addMember = async (status: string, permissions: string[], validUntil: string | null = null) => {
    const m = await c.query(
      `INSERT INTO project_memberships (project_id, user_id, role, status, valid_until)
       VALUES ($1, $2, 'other', $3, $4) RETURNING id`,
      [projectId, await newUser(), status, validUntil],
    );
    for (const p of permissions) {
      await c.query('INSERT INTO project_permissions (membership_id, permission) VALUES ($1, $2)', [m.rows[0].id, p]);
    }
    return m.rows[0].id as string;
  };
  const owner = await addMember('active', ['project.view', 'members.manage']);
  const subManager = await addMember('active', ['members.manage']);
  const viewer = await addMember('active', ['project.view', 'contract.view']);
  const noView = await addMember('active', ['details.view']);
  const pending = await addMember('pending_approval', ['project.view']);
  const temporary = await addMember('active', ['project.view'], new Date(Date.now() + 86400_000).toISOString());
  await c.query("INSERT INTO project_products (project_id, product_code, quantity) VALUES ($1, 'p', 1)", [projectId]);
  await c.query(
    "INSERT INTO project_audit_log (project_id, action, role, permissions) VALUES ($1, 'member_updated', 'other', '{project.view}')",
    [projectId],
  );
  await c.query('COMMIT');
  await c.query("UPDATE project_memberships SET created_at = now() - interval '2 days', valid_until = now() - interval '1 day' WHERE id = $1", [temporary]);

  assert.deepEqual(await migrate(url, { until: '003_simplify_mvp.sql' }), ['003_simplify_mvp.sql']);
  const roles = await c.query('SELECT id, role FROM project_memberships ORDER BY created_at');
  const byId = Object.fromEntries(roles.rows.map((r) => [r.id, r.role]));
  assert.deepEqual(byId, { [owner]: 'manager', [subManager]: 'manager', [viewer]: 'member', [noView]: 'member' });
  assert.equal(byId[pending], undefined);
  assert.equal(byId[temporary], undefined);
  for (const table of ['project_permissions', 'project_invitation_permissions', 'project_products', 'project_work_schedules', 'project_contracts', 'project_events']) {
    assert.equal((await c.query('SELECT to_regclass($1) AS t', [table])).rows[0].t, null, table);
  }
  const cols = await c.query(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('projects', 'project_memberships', 'project_invitations') ORDER BY 1, 2",
  );
  const colNames = cols.rows.map((r) => `${r.table_name}.${r.column_name}`);
  for (const removed of ['projects.status', 'project_memberships.status', 'project_memberships.valid_until', 'project_invitations.role', 'project_invitations.requires_approval']) {
    assert.equal(colNames.includes(removed), false, removed);
  }
  // 過去の監査ログは残る
  const audit = await c.query("SELECT role, permissions::text[] AS permissions FROM project_audit_log WHERE action = 'member_updated'");
  assert.deepEqual(audit.rows, [{ role: 'other', permissions: ['project.view'] }]);
  // 管理者がいなくなる変更は引き続き拒否される
  await assert.rejects(
    c.query("UPDATE project_memberships SET role = 'member' WHERE project_id = $1", [projectId]),
    (err: any) => err.code === 'MI001',
  );
  await c.end();
});

test('004: 既存の参加関係に案件内で安定した表示番号を付与する', async () => {
  const url = await freshDb();
  await migrate(url, { until: '003_simplify_mvp.sql' });
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const userIds = [];
  for (let i = 0; i < 3; i++) {
    userIds.push((await c.query('INSERT INTO auth_users (webauthn_user_handle) VALUES ($1) RETURNING id', [randomBytes(32)])).rows[0].id);
  }
  await c.query('BEGIN');
  const projectId = (await c.query("INSERT INTO projects (name) VALUES ('表示名移行') RETURNING id")).rows[0].id;
  for (let i = 0; i < userIds.length; i++) {
    await c.query(
      `INSERT INTO project_memberships (project_id, user_id, role, created_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
      [projectId, userIds[i], i === 0 ? 'manager' : 'member', i],
    );
  }
  await c.query('COMMIT');

  assert.deepEqual(await migrate(url), ['004_project_member_display_names.sql']);
  const members = await c.query(
    'SELECT display_name, display_number FROM project_memberships WHERE project_id = $1 ORDER BY created_at',
    [projectId],
  );
  assert.deepEqual(members.rows, [
    { display_name: null, display_number: 1 },
    { display_name: null, display_number: 2 },
    { display_name: null, display_number: 3 },
  ]);
  const extraUser = (await c.query('INSERT INTO auth_users (webauthn_user_handle) VALUES ($1) RETURNING id', [randomBytes(32)])).rows[0].id;
  await assert.rejects(
    c.query(
      "INSERT INTO project_memberships (project_id, user_id, role, display_number) VALUES ($1, $2, 'member', 2)",
      [projectId, extraUser],
    ),
    (err: any) => err.code === '23505',
  );
  await c.end();
});
