import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { migrate } from '../src/migrate.ts';
import { startLocalPg } from './pg.ts';

// テスト用PostgreSQLを一時ディレクトリで起動し、マイグレーション済みのテンプレートDBを作る
// 各テストファイルはテンプレートから独立したDBを複製して使う
// TEST_PG_ADMIN_URL を指定した場合は既存のPostgreSQL（Docker等）を使う
const root = path.join(import.meta.dirname, '..');
let adminUrl = process.env.TEST_PG_ADMIN_URL;
let stop = async () => {};
if (!adminUrl) {
  const dir = path.join(os.tmpdir(), `myid-test-pg-${process.pid}`);
  const local = await startLocalPg({ dir, persistent: false });
  adminUrl = local.url('postgres');
  stop = async () => {
    await local.stop();
    await rm(dir, { recursive: true, force: true });
  };
}

let code = 1;
try {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS myid_test_template');
  await admin.query('CREATE DATABASE myid_test_template');
  await admin.end();
  const templateUrl = new URL(adminUrl);
  templateUrl.pathname = '/myid_test_template';
  await migrate(templateUrl.toString());

  const files = process.argv.slice(2);
  const child = spawn(
    process.execPath,
    ['--test', '--test-concurrency=4', ...(files.length ? files : [path.join(root, 'test', '*.test.ts')])],
    { stdio: 'inherit', env: { ...process.env, TEST_PG_ADMIN_URL: adminUrl, TEST_PG_TEMPLATE: 'myid_test_template' } },
  );
  code = await new Promise<number>((resolve) => child.on('exit', (c) => resolve(c ?? 1)));
} finally {
  await stop();
}
process.exit(code);
