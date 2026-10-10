import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { migrate } from '../src/migrate.ts';
import { startLocalPg } from './pg.ts';

// 開発用: ローカルPostgreSQL（.local/pgdata）を起動し、マイグレーション後にサーバーを起動する
const root = path.join(import.meta.dirname, '..');
const local = await startLocalPg({ dir: path.join(root, '.local', 'pgdata'), persistent: true });
const admin = new pg.Client({ connectionString: local.url('postgres') });
await admin.connect();
const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'myid'");
if (!exists.rowCount) await admin.query('CREATE DATABASE myid');
await admin.end();

const databaseUrl = local.url('myid');
console.log((await migrate(databaseUrl)).join(', ') || 'no pending migrations');

const child = spawn(process.execPath, [path.join(root, 'src', 'server.ts')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    ORIGIN: process.env.ORIGIN ?? 'http://localhost:3000',
    // 開発用のセッション秘密は起動ごとに生成する（再起動でセッションは無効になる）
    SESSION_SECRET: process.env.SESSION_SECRET ?? randomBytes(32).toString('base64url'),
  },
});
const stop = async () => {
  child.kill('SIGTERM');
  await local.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', async (code) => {
  await local.stop();
  process.exit(code ?? 0);
});
