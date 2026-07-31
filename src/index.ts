import { bootState } from './bootState.js';
import { config, configWarnings } from './config.js';
import { attachLogSink, migrate, pool } from './db/index.js';
import { createLogger, errMessage } from './logger.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { seedDefaultTemplates } from './templates/defaults.js';
import { startServer } from './web/server.js';

const log = createLogger('boot');

/**
 * Connects and migrates, retrying with backoff. Railway can start the app
 * before the Postgres plugin finishes provisioning, so a first failure is
 * normal and must not kill the process.
 */
async function initDatabase(): Promise<void> {
  const delaysMs = [2_000, 5_000, 10_000, 20_000, 30_000, 60_000];

  for (let attempt = 0; ; attempt++) {
    bootState.dbAttempts = attempt + 1;
    try {
      if (!config.DATABASE_URL) {
        throw new Error(
          'DATABASE_URL が設定されていません。Railway で「New → Database → Add PostgreSQL」を実行してください。',
        );
      }
      await migrate();
      attachLogSink();
      await seedDefaultTemplates();

      bootState.dbReady = true;
      bootState.dbError = null;
      log.info('database ready');
      startScheduler();
      return;
    } catch (e) {
      bootState.dbError = errMessage(e);
      const wait = delaysMs[Math.min(attempt, delaysMs.length - 1)] ?? 60_000;
      log.error(`データベースに接続できません (${attempt + 1}回目): ${bootState.dbError}`);
      log.error(`${wait / 1000}秒後に再試行します。管理画面 ${config.PUBLIC_URL}/admin/ に原因が表示されます。`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function main() {
  log.info('starting rizin-auto-comment-pin');
  for (const warning of configWarnings()) log.warn(warning);

  // Listen first. If the database is misconfigured the deploy still comes up
  // and the admin UI can show the reason, rather than the container looping
  // on an unexplained healthcheck failure.
  const server = startServer();
  log.info(`管理画面: ${config.PUBLIC_URL}/admin/`);

  void initDatabase();

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
