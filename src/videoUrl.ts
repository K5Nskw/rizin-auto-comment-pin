import type { Platform } from './types.js';

export interface ParsedVideo {
  platform: Platform;
  videoId: string;
  /** Canonical URL, so the stored entry is readable in the UI. */
  url: string;
}

/**
 * Extracts a platform and video id from a pasted link or a bare id.
 *
 * Kept deliberately strict: a wrong guess here would exclude the wrong video,
 * so anything unrecognised is rejected with an explanation rather than
 * half-matched.
 */
export function parseVideoUrl(input: string): ParsedVideo | null {
  const raw = input.trim().replace(/^["'<]|["'>]$/g, '');
  if (!raw) return null;

  // Bare YouTube id (11 chars) — the common thing to paste from a URL bar.
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) {
    return { platform: 'youtube', videoId: raw, url: youtubeUrl(raw) };
  }

  // Bare TikTok id (long numeric).
  if (/^\d{15,25}$/.test(raw)) {
    return { platform: 'tiktok', videoId: raw, url: `https://www.tiktok.com/video/${raw}` };
  }

  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  const segments = parsed.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be') {
    const id = segments[0];
    return id ? { platform: 'youtube', videoId: id, url: youtubeUrl(id) } : null;
  }

  if (host === 'youtube.com' || host === 'm.youtube.com' || host.endsWith('.youtube.com')) {
    const v = parsed.searchParams.get('v');
    if (v) return { platform: 'youtube', videoId: v, url: youtubeUrl(v) };

    // /shorts/<id>, /live/<id>, /embed/<id>
    const idx = segments.findIndex((s) => s === 'shorts' || s === 'live' || s === 'embed');
    const id = idx >= 0 ? segments[idx + 1] : undefined;
    return id ? { platform: 'youtube', videoId: id, url: youtubeUrl(id) } : null;
  }

  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    // Short links (vm.tiktok.com/xxxx) need an HTTP redirect to resolve, which
    // this cannot do offline — the caller reports that rather than guessing.
    const idx = segments.findIndex((s) => s === 'video' || s === 'photo');
    const id = idx >= 0 ? segments[idx + 1] : undefined;
    if (id && /^\d+$/.test(id)) {
      const user = segments.find((s) => s.startsWith('@'));
      return {
        platform: 'tiktok',
        videoId: id,
        url: user
          ? `https://www.tiktok.com/${user}/video/${id}`
          : `https://www.tiktok.com/video/${id}`,
      };
    }
    return null;
  }

  return null;
}

const youtubeUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

export const PARSE_HINT =
  '動画のURLを貼り付けてください。' +
  '例: https://www.youtube.com/watch?v=xxxxxxxxxxx / https://youtu.be/xxxxxxxxxxx / ' +
  'https://www.tiktok.com/@account/video/1234567890。' +
  'TikTok の短縮URL（vm.tiktok.com）は展開してから貼り付けてください。';
