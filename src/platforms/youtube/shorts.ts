import { createLogger, errMessage } from '../../logger.js';

const log = createLogger('youtube:shorts');

/**
 * Whether a video is a Short.
 *
 * The Data API exposes no field for this, so the check is the one YouTube
 * itself makes observable: /shorts/<id> serves the Short directly, and
 * redirects to /watch for anything that isn't one. No quota, one request.
 *
 * Returns null when the answer can't be established — a network failure must
 * not be read as "not a Short", because that silently routes a Short to the
 * wrong template.
 */
export async function detectShort(videoId: string): Promise<boolean | null> {
  try {
    const res = await fetch(`https://www.youtube.com/shorts/${encodeURIComponent(videoId)}`, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'user-agent': 'rizin-auto-comment-pin/1.0' },
      signal: AbortSignal.timeout(15_000),
    });

    // 2xx: served as a Short. 3xx to /watch: a regular upload.
    if (res.status >= 200 && res.status < 300) return true;
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location') ?? '';
      if (/\/watch/.test(location)) return false;
      log.debug(`unexpected redirect for ${videoId}: ${location}`);
      return false;
    }

    log.warn(`shorts check for ${videoId} returned ${res.status}`);
    return null;
  } catch (e) {
    log.warn(`shorts check for ${videoId} failed: ${errMessage(e)}`);
    return null;
  }
}

/** ISO 8601 duration ("PT1M30S") to seconds. */
export function parseDuration(iso: string): number | null {
  const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso);
  if (!m) return null;
  const [, d, h, min, s] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
}

/** Shorts are capped at three minutes, so anything longer is definitely not one. */
export const SHORTS_MAX_SECONDS = 180;
