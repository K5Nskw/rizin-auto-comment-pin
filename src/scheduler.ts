import { config } from './config.js';
import { pruneLogs } from './db/index.js';
import { createLogger, errMessage } from './logger.js';
import { pollTikTok } from './platforms/tiktok/watcher.js';
import { pollYouTube } from './platforms/youtube/watcher.js';
import { ensureSubscription } from './platforms/youtube/websub.js';
import { runDueJobs } from './worker.js';

const log = createLogger('scheduler');

const timers: NodeJS.Timeout[] = [];

/** setInterval that never lets a rejection take the process down. */
function every(ms: number, name: string, fn: () => Promise<unknown>) {
  const tick = () => {
    fn().catch((e) => log.error(`${name} failed: ${errMessage(e)}`));
  };
  timers.push(setInterval(tick, ms));
  return tick;
}

export async function pollAll(): Promise<{ youtube: unknown; tiktok: unknown }> {
  const [youtube, tiktok] = await Promise.all([pollYouTube(), pollTikTok()]);
  return { youtube, tiktok };
}

export function startScheduler(): void {
  const pollMs = Math.max(1, config.POLL_INTERVAL_MINUTES) * 60_000;

  every(30_000, 'worker', runDueJobs);
  every(pollMs, 'poll', pollAll);
  every(6 * 3_600_000, 'websub-renew', ensureSubscription);
  every(24 * 3_600_000, 'prune-logs', () => pruneLogs(30));

  log.info(`scheduler started (poll every ${config.POLL_INTERVAL_MINUTES}m, worker every 30s)`);

  // Kick off an initial pass shortly after boot, once the DB is warm.
  setTimeout(() => {
    ensureSubscription().catch((e) => log.warn(`initial websub failed: ${errMessage(e)}`));
    pollAll().catch((e) => log.warn(`initial poll failed: ${errMessage(e)}`));
  }, 5_000);
}

export function stopScheduler(): void {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}
