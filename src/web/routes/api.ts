import { Router } from 'express';
import { z } from 'zod';
import { browserAvailable, checkLogin, normaliseStorageState } from '../../browser/session.js';
import { config, configWarnings, legalUrls } from '../../config.js';
import {
  browserSessionInfo,
  createTemplate,
  deleteAccount,
  deleteBrowserSession,
  deleteTemplate,
  getAccount,
  getSetting,
  jobStats,
  listJobs,
  listTemplates,
  recentLogs,
  saveBrowserSession,
  updateTemplate,
} from '../../db/repo.js';
import { errMessage } from '../../logger.js';
import { subscribe, subscriptionState } from '../../platforms/youtube/websub.js';
import { pollAll } from '../../scheduler.js';
import {
  clampComment,
  pickBody,
  renderTemplate,
  selectTemplate,
  TEMPLATE_VARIABLES,
  validateTemplateBody,
} from '../../templates/engine.js';
import type { Platform } from '../../types.js';
import { requeueJob } from '../../worker.js';

export const apiRouter: Router = Router();

const platformSchema = z.enum(['youtube', 'tiktok']);

const templateSchema = z.object({
  name: z.string().min(1, '名前を入力してください'),
  platform: z.enum(['all', 'youtube', 'tiktok']),
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(9999),
  matchType: z.enum(['always', 'keyword', 'regex']),
  matchValue: z.string(),
  bodies: z.array(z.string()).min(1, 'コメント本文を1つ以上入力してください'),
  pin: z.boolean(),
  delaySeconds: z.number().int().min(0).max(86_400),
});

/** Wraps a handler so any throw becomes a clean JSON error instead of a 500 page. */
const handle =
  (fn: (req: any, res: any) => Promise<unknown>) =>
  async (req: any, res: any): Promise<void> => {
    try {
      const result = await fn(req, res);
      if (!res.headersSent) res.json(result ?? { ok: true });
    } catch (e) {
      if (!res.headersSent) res.status(400).json({ ok: false, error: errMessage(e) });
    }
  };

/* --------------------------------- status --------------------------------- */

apiRouter.get(
  '/status',
  handle(async () => {
    const [youtube, tiktok, stats, websub, sessions] = await Promise.all([
      getAccount('youtube'),
      getAccount('tiktok'),
      jobStats(),
      subscriptionState(),
      browserSessionInfo(),
    ]);
    return {
      warnings: configWarnings(),
      publicUrl: config.PUBLIC_URL,
      // Surfaced so the operator can copy them straight into the Google /
      // TikTok developer consoles instead of assembling them by hand.
      legal: legalUrls(),
      redirectUris: {
        youtube: `${config.PUBLIC_URL}/oauth/youtube/callback`,
        tiktok: `${config.PUBLIC_URL}/oauth/tiktok/callback`,
      },
      dryRun: config.DRY_RUN,
      pollIntervalMinutes: config.POLL_INTERVAL_MINUTES,
      maxVideoAgeHours: config.MAX_VIDEO_AGE_HOURS,
      browser: {
        enabled: config.ENABLE_BROWSER_AUTOMATION,
        available: await browserAvailable(),
        sessions,
      },
      websub,
      stats,
      accounts: {
        youtube: youtube && {
          displayName: youtube.displayName,
          externalId: youtube.externalId,
          connectedAt: youtube.connectedAt,
        },
        tiktok: tiktok && {
          displayName: tiktok.displayName,
          externalId: tiktok.externalId,
          connectedAt: tiktok.connectedAt,
        },
      },
    };
  }),
);

apiRouter.get('/variables', (_req, res) => {
  res.json(TEMPLATE_VARIABLES);
});

/* -------------------------------- templates -------------------------------- */

apiRouter.get(
  '/templates',
  handle(async () => listTemplates()),
);

apiRouter.post(
  '/templates',
  handle(async (req) => {
    const input = templateSchema.parse(req.body);
    return createTemplate(cleanBodies(input));
  }),
);

apiRouter.put(
  '/templates/:id',
  handle(async (req) => {
    const input = templateSchema.parse(req.body);
    const updated = await updateTemplate(Number(req.params.id), cleanBodies(input));
    if (!updated) throw new Error('テンプレートが見つかりません');
    return updated;
  }),
);

apiRouter.delete(
  '/templates/:id',
  handle(async (req) => {
    await deleteTemplate(Number(req.params.id));
    return { ok: true };
  }),
);

function cleanBodies<T extends { bodies: string[]; matchType: string; matchValue: string }>(input: T): T {
  const bodies = input.bodies.map((b) => b.trim()).filter(Boolean);
  if (!bodies.length) throw new Error('コメント本文が空です');

  for (const b of bodies) {
    const errors = validateTemplateBody(b);
    if (errors.length) throw new Error(errors.join(' / '));
  }
  if (input.matchType === 'regex') {
    try {
      new RegExp(input.matchValue);
    } catch {
      throw new Error('正規表現が不正です');
    }
  }
  if (input.matchType !== 'always' && !input.matchValue.trim()) {
    throw new Error('条件（キーワード / 正規表現）を入力してください');
  }
  return { ...input, bodies };
}

/**
 * Answers "if a video with this title were posted right now, what exactly
 * would the bot say?" — the main way to check template changes before they run.
 */
apiRouter.post(
  '/templates/preview',
  handle(async (req) => {
    const schema = z.object({
      title: z.string().default('【RIZIN】試合ハイライト｜〇〇 vs 〇〇'),
      description: z.string().default(''),
      platform: platformSchema.default('youtube'),
      body: z.string().optional(),
    });
    const input = schema.parse(req.body ?? {});

    const templates = await listTemplates();
    const matched = selectTemplate(templates, {
      title: input.title,
      description: input.description,
      platform: input.platform,
    });

    const account = await getAccount(input.platform);
    const ctx = {
      title: input.title,
      url:
        input.platform === 'youtube'
          ? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
          : 'https://www.tiktok.com/@rizin/video/1234567890',
      videoId: input.platform === 'youtube' ? 'dQw4w9WgXcQ' : '1234567890',
      platform: input.platform,
      channel: account?.displayName ?? 'RIZIN',
      publishedAt: new Date(),
    };

    // An explicit body previews unsaved edits; otherwise preview the template
    // that would actually be selected.
    const source = input.body ?? (matched ? pickBody(matched) : '');
    if (!source) {
      return { matched: null, rendered: '', note: '一致するテンプレートがありません' };
    }

    const rendered = renderTemplate(source, ctx);
    const { text, truncated } = clampComment(rendered, input.platform);
    return {
      matched: matched ? { id: matched.id, name: matched.name, pin: matched.pin, delaySeconds: matched.delaySeconds } : null,
      rendered: text,
      length: text.length,
      truncated,
      warnings: validateTemplateBody(source),
    };
  }),
);

/* ----------------------------------- jobs ---------------------------------- */

apiRouter.get(
  '/jobs',
  handle(async () => listJobs(50)),
);

apiRouter.post(
  '/jobs/:id/retry',
  handle(async (req) => {
    await requeueJob(Number(req.params.id));
    return { ok: true };
  }),
);

apiRouter.post(
  '/poll',
  handle(async () => pollAll()),
);

apiRouter.get(
  '/logs',
  handle(async () => recentLogs(150)),
);

/* --------------------------------- accounts -------------------------------- */

apiRouter.post(
  '/accounts/:platform/disconnect',
  handle(async (req) => {
    await deleteAccount(platformSchema.parse(req.params.platform));
    return { ok: true };
  }),
);

apiRouter.post(
  '/websub/subscribe',
  handle(async () => {
    await subscribe('subscribe');
    return { ok: true, note: '購読リクエストを送信しました（数秒後に反映されます）' };
  }),
);

/* ----------------------------- browser sessions ---------------------------- */

apiRouter.post(
  '/browser/:platform/session',
  handle(async (req) => {
    const platform = platformSchema.parse(req.params.platform) as Platform;
    const raw = z.object({ cookies: z.string().min(2) }).parse(req.body);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.cookies);
    } catch {
      throw new Error('JSON として読み取れませんでした');
    }

    const domain = platform === 'youtube' ? '.youtube.com' : '.tiktok.com';
    const state = normaliseStorageState(parsed, domain);
    await saveBrowserSession(platform, state);

    const cookieCount = (state as { cookies?: unknown[] }).cookies?.length ?? 0;
    return { ok: true, cookieCount };
  }),
);

apiRouter.post(
  '/browser/:platform/check',
  handle(async (req) => checkLogin(platformSchema.parse(req.params.platform) as Platform)),
);

apiRouter.delete(
  '/browser/:platform/session',
  handle(async (req) => {
    await deleteBrowserSession(platformSchema.parse(req.params.platform) as Platform);
    return { ok: true };
  }),
);

apiRouter.get(
  '/browser/:platform/screenshot',
  handle(async (req) => {
    const platform = platformSchema.parse(req.params.platform);
    return (await getSetting(`last_failure_screenshot:${platform}`)) ?? { empty: true };
  }),
);
