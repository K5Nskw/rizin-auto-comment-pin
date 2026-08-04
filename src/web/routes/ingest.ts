import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { safeEqual } from '../../crypto.js';
import { createLogger, errMessage } from '../../logger.js';
import { ingestVideo } from '../../pipeline.js';
import { PARSE_HINT, parseVideoUrl } from '../../videoUrl.js';

const log = createLogger('ingest');

/**
 * 外部のツールから「この動画にコメントして」と持ち込む口。
 *
 * いまの利用者は AutoClipMaker（切り抜きを作って YouTube に上げるツール）で、
 * 上げ終わった切り抜きのURLと、その元動画のURLを送ってくる。
 * 元動画のリンクは切り抜き側の説明欄だけでなくコメントにも置きたい、というのが目的。
 *
 * 管理画面（/api）とは別の口にして、共有トークンで守る。
 * 管理画面のパスワードを外部ツールに渡さずに済むようにするため。
 */
export const ingestRouter: Router = Router();

const clipSchema = z.object({
  /** 投稿した切り抜きのURL（または動画ID）。 */
  url: z.string().min(1, '切り抜きのURLを指定してください'),
  title: z.string().default(''),
  description: z.string().default(''),
  /** 元動画。これが無いと切り抜き用のテンプレートは使えない。 */
  sourceUrl: z.string().min(1, '元動画のURLを指定してください'),
  sourceTitle: z.string().default(''),
  /** 元動画のどこを切り抜いたか（秒）。 */
  sourceStartSec: z.number().nonnegative().optional(),
  /** テンプレートを使わず、この本文をそのまま投稿する。 */
  text: z.string().optional(),
  /** テンプレートのピン留め設定を上書きする。 */
  pin: z.boolean().optional(),
});

ingestRouter.post('/clip', async (req, res) => {
  if (!config.INGEST_TOKEN) {
    res.status(503).json({
      ok: false,
      error: 'INGEST_TOKEN が未設定です。環境変数に設定してから連携してください',
    });
    return;
  }

  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!safeEqual(token, config.INGEST_TOKEN)) {
    log.warn('rejected a clip with a bad token');
    res.status(401).json({ ok: false, error: 'トークンが違います' });
    return;
  }

  try {
    const input = clipSchema.parse(req.body);

    const clip = parseVideoUrl(input.url);
    if (!clip) throw new Error(`切り抜きのURLを認識できませんでした。${PARSE_HINT}`);

    const source = parseVideoUrl(input.sourceUrl);
    if (!source) throw new Error(`元動画のURLを認識できませんでした。${PARSE_HINT}`);

    const result = await ingestVideo(
      {
        platform: clip.platform,
        videoId: clip.videoId,
        title: input.title,
        description: input.description,
        url: clip.url,
        // 上げた直後に送られてくるので、いまを公開時刻として扱う
        publishedAt: new Date(),
        source: {
          url: source.url,
          title: input.sourceTitle || undefined,
          videoId: source.videoId,
          startSec: input.sourceStartSec,
        },
        raw: { via: 'ingest/clip', sourceUrl: source.url },
      },
      {
        // 送り主が「これに付けて」と名指ししている。基準時刻より前でも通す
        ignoreAge: true,
        overrideText: input.text,
        forcePin: input.pin,
      },
    );

    log.info(`clip ingested: ${clip.url}`, { created: result.created, reason: result.reason });
    res.json({ ok: true, ...result });
  } catch (e) {
    const error = e instanceof z.ZodError ? e.issues.map((i) => i.message).join(' / ') : errMessage(e);
    log.warn(`clip rejected: ${error}`);
    res.status(400).json({ ok: false, error });
  }
});
