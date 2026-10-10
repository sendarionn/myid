import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createPool } from './db.ts';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const app = createApp(config, db);
const server = app.listen(config.port, config.host, () => {
  console.log(`listening on ${config.host}:${config.port} (origin ${config.origin}, rpId ${config.rpId})`);
});

function shutdown() {
  server.close(() => {
    void db.end().then(() => process.exit(0));
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
