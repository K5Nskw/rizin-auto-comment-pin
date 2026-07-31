import { config } from '../config.js';
import { createLogger, errMessage } from '../logger.js';

const log = createLogger('notify');

/**
 * Sends to a Discord or Slack incoming webhook, detected from the URL shape.
 * Never throws — a broken webhook must not break the pipeline.
 */
export async function notify(title: string, body: string): Promise<void> {
  const url = config.NOTIFY_WEBHOOK_URL;
  if (!url) return;

  const isSlack = url.includes('hooks.slack.com');
  const payload = isSlack
    ? { text: `*${title}*\n${body}` }
    : { content: `**${title}**\n${body}`.slice(0, 1900) };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) log.warn(`webhook returned ${res.status}`);
  } catch (e) {
    log.warn(`webhook failed: ${errMessage(e)}`);
  }
}

/** Used when the API cannot finish the job and a human has to tap a button. */
export async function notifyManualAction(opts: {
  platform: string;
  title: string;
  url: string;
  comment: string;
  what: string;
}): Promise<void> {
  await notify(
    `🖐 手動対応が必要です (${opts.platform})`,
    [
      `動画: ${opts.title}`,
      opts.url,
      '',
      `やること: ${opts.what}`,
      '',
      '--- コメント本文 ---',
      opts.comment,
    ].join('\n'),
  );
}
