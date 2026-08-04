import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { safeEqual } from '../../crypto.js';
import { createLogger, errMessage } from '../../logger.js';
import { ingestVideo } from '../../pipeline.js';
import { parseVideoUrl } from '../../videoUrl.js';

const log = createLogger('ingest');

export const ingestRouter: Router = Router();

/**
 * Receiving end of AutoClipMaker's comment hook.
 *
 * It posts a clip and tells us where the clip came from, so the source video
 * is known outright rather than guessed from matching titles. The response
 * shape ({ok, created, reason}) is what its client reads; 4xx makes it stop
 * retrying, which is right for a bad token and wrong for a transient fault.
 */
const clipSchema = z.object({
  url: z.string().min(1, 'url を指定してください'),
  title: z.string().optional().default(''),
  sourceUrl: z.string().optional().default(''),
  sourceTitle: z.string().optional().default(''),
  sourceStartSec: z.number().int().nonnegative().optional(),
});

ingestRouter.post('/clip', async (req, res) => {
  // "トークン" in the message matters: the sender treats messages mentioning it
  // as permanent and stops retrying instead of hammering a closed door.
  if (!config.INGEST_TOKEN) {
    res.status(401).json({
      ok: false,
      error: 'INGEST_TOKEN が未設定のため受け付けられません。受信側の環境変数を設定してください。',
    });
    return;
  }

  const header = String(req.headers.authorization ?? '');
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented || !safeEqual(presented, config.INGEST_TOKEN)) {
    log.warn('rejected clip hook with a bad token');
    res.status(401).json({ ok: false, error: 'トークンが一致しません（INGEST_TOKEN を確認してください）' });
    return;
  }

  let input: z.infer<typeof clipSchema>;
  try {
    input = clipSchema.parse(req.body);
  } catch (e) {
    const message = e instanceof z.ZodError ? e.issues.map((i) => i.message).join(' / ') : errMessage(e);
    res.status(400).json({ ok: false, error: message });
    return;
  }

  const clip = parseVideoUrl(input.url);
  if (!clip || clip.platform !== 'youtube') {
    res.status(400).json({ ok: false, error: `url を認識できませんでした: ${input.url}` });
    return;
  }

  const source = input.sourceUrl ? parseVideoUrl(input.sourceUrl) : null;
  if (input.sourceUrl && !source) {
    log.warn(`sourceUrl を認識できませんでした: ${input.sourceUrl}`);
  }

  try {
    const result = await ingestVideo(
      {
        platform: 'youtube',
        videoId: clip.videoId,
        title: input.title,
        description: '',
        url: clip.url,
        // The hook fires at upload time, so this is the moment it went up.
        publishedAt: new Date(),
        source: source
          ? {
              videoId: source.videoId,
              url: source.url,
              title: input.sourceTitle,
              startSec: input.sourceStartSec ?? null,
            }
          : undefined,
      },
      // An explicit hand-off, not a feed sweep: the watermark and age cutoffs
      // exist to stop the back catalogue being swept up, and neither applies to
      // a clip we were just told about. De-duplication still holds — one job
      // per video — so a re-sent hook cannot produce a second comment.
      { ignoreAge: true },
    );

    log.info(`clip ${clip.videoId} -> ${result.reason}`);
    res.json({ ok: true, created: result.created, reason: result.reason });
  } catch (e) {
    const message = errMessage(e);
    log.error(`clip hook failed: ${message}`);
    res.status(500).json({ ok: false, error: message });
  }
});
