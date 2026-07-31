import { config, configWarnings } from './config.js';
import { attachLogSink, migrate, pool } from './db/index.js';
import { createLogger, errMessage } from './logger.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { seedDefaultTemplates } from './templates/defaults.js';
import { startServer } from './web/server.js';

const log = createLogger('boot');

async function main() {
  log.info('starting rizin-auto-comment-pin');

  await migrate();
  attachLogSink();
  await seedDefaultTemplates();

  for (const warning of configWarnings()) log.warn(warning);

  const server = startServer();
  startScheduler();

  log.info(`管理画面: ${config.PUBLIC_URL}/admin/`);

  const shutdown = (signal: string) => {
    log.info(`${signal} received, shutting down`);
    stopScheduler();
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
    // Don't hang forever if a connection is stuck.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  log.error(`unhandled rejection: ${errMessage(reason)}`);
});

main().catch((e) => {
  log.error(`起動に失敗しました: ${errMessage(e)}`);
  process.exit(1);
});
