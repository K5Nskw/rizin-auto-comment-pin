import { Router } from 'express';
import { randomToken } from '../../crypto.js';
import { createLogger, errMessage } from '../../logger.js';
import { getMyUser } from '../../platforms/tiktok/api.js';
import * as tiktokOAuth from '../../platforms/tiktok/oauth.js';
import { getMyChannel } from '../../platforms/youtube/api.js';
import * as youtubeOAuth from '../../platforms/youtube/oauth.js';
import { ensureSubscription } from '../../platforms/youtube/websub.js';
import { requireAdmin } from '../auth.js';

const log = createLogger('oauth');

/** Short-lived CSRF states. Single replica, so an in-memory map is enough. */
const states = new Map<string, { platform: string; expires: number }>();

function issueState(platform: string): string {
  const token = randomToken();
  states.set(token, { platform, expires: Date.now() + 10 * 60_000 });
  for (const [k, v] of states) if (v.expires < Date.now()) states.delete(k);
  return token;
}

function consumeState(token: unknown, platform: string): boolean {
  if (typeof token !== 'string') return false;
  const entry = states.get(token);
  states.delete(token);
  return Boolean(entry && entry.platform === platform && entry.expires > Date.now());
}

export const oauthRouter: Router = Router();

const page = (title: string, body: string, ok = true) => `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:80px auto;padding:0 20px;line-height:1.7}
.box{border:1px solid ${ok ? '#22c55e' : '#ef4444'};border-left-width:6px;border-radius:8px;padding:20px}
code{background:#f3f4f6;padding:2px 6px;border-radius:4px}</style></head>
<body><div class="box"><h2>${title}</h2>${body}</div>
<p><a href="/admin/">← 管理画面に戻る</a></p></body></html>`;

/* ---------------------------------- start --------------------------------- */

oauthRouter.get('/youtube/start', requireAdmin, (_req, res) => {
  res.redirect(youtubeOAuth.buildAuthUrl(issueState('youtube')));
});

oauthRouter.get('/tiktok/start', requireAdmin, (_req, res) => {
  res.redirect(tiktokOAuth.buildAuthUrl(issueState('tiktok')));
});

/* -------------------------------- callbacks -------------------------------- */

oauthRouter.get('/youtube/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    res.status(400).send(page('YouTube 連携に失敗しました', `<p>${String(error)}</p>`, false));
    return;
  }
  if (!consumeState(state, 'youtube')) {
    res.status(400).send(page('不正なリクエストです', '<p>state が一致しません。もう一度やり直してください。</p>', false));
    return;
  }
  try {
    const creds = await youtubeOAuth.exchangeCode(String(code));
    // Persist first so getMyChannel() can authenticate with the new token.
    await youtubeOAuth.persistConnection(creds, { id: '', title: '' });
    const channel = await getMyChannel();
    await youtubeOAuth.persistConnection(creds, channel);
    await ensureSubscription().catch((e) => log.warn(`websub after connect: ${errMessage(e)}`));

    log.info(`youtube connected: ${channel.title}`);
    res.send(
      page(
        'YouTube を連携しました',
        `<p>チャンネル: <code>${escapeHtml(channel.title)}</code><br>ID: <code>${channel.id}</code></p>`,
      ),
    );
  } catch (e) {
    log.error(`youtube oauth failed: ${errMessage(e)}`);
    res.status(500).send(page('YouTube 連携に失敗しました', `<p>${escapeHtml(errMessage(e))}</p>`, false));
  }
});

oauthRouter.get('/tiktok/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    res.status(400).send(page('TikTok 連携に失敗しました', `<p>${String(error)}</p>`, false));
    return;
  }
  if (!consumeState(state, 'tiktok')) {
    res.status(400).send(page('不正なリクエストです', '<p>state が一致しません。もう一度やり直してください。</p>', false));
    return;
  }
  try {
    const creds = await tiktokOAuth.exchangeCode(String(code));
    await tiktokOAuth.persistConnection(creds, { openId: creds.openId ?? '', displayName: '' });
    const user = await getMyUser();
    await tiktokOAuth.persistConnection(creds, user);

    log.info(`tiktok connected: ${user.displayName}`);
    res.send(
      page('TikTok を連携しました', `<p>アカウント: <code>${escapeHtml(user.displayName)}</code></p>`),
    );
  } catch (e) {
    log.error(`tiktok oauth failed: ${errMessage(e)}`);
    res.status(500).send(page('TikTok 連携に失敗しました', `<p>${escapeHtml(errMessage(e))}</p>`, false));
  }
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
