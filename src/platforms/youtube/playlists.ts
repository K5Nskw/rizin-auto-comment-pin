import { createLogger, errMessage } from '../../logger.js';
import { call } from './api.js';

const log = createLogger('youtube:playlists');

export type PlaylistOrder = 'newest' | 'first' | 'last';

export interface PlaylistConfig {
  /** Used to build the template variables, e.g. `highlight` -> {{playlist_highlight_url}} */
  key: string;
  playlistId: string;
  label: string;
  order: PlaylistOrder;
}

export interface PlaylistVideo {
  videoId: string;
  title: string;
  url: string;
  publishedAt: string | null;
}

interface CacheEntry {
  at: number;
  video: PlaylistVideo;
}

/**
 * Playlists change far more slowly than we post, and every comment would
 * otherwise trigger a lookup. Short TTL keeps a freshly added video from being
 * missed for long.
 */
const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, CacheEntry>();

export function clearPlaylistCache(): void {
  cache.clear();
}

interface PlaylistItem {
  snippet: {
    title: string;
    position: number;
    resourceId: { videoId: string };
  };
  contentDetails?: { videoPublishedAt?: string };
  status?: { privacyStatus?: string };
}

/**
 * Accepts a bare ID or any YouTube URL containing one. Pasting the whole
 * playlist URL is the natural thing to do, and the API answers a URL with an
 * opaque "Invalid Value" that says nothing about the cause.
 */
export function normalisePlaylistId(input: string): string {
  const trimmed = input.trim().replace(/^["'<]|["'>]$/g, '');

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const list = new URL(trimmed).searchParams.get('list');
      if (list) return list.trim();
    } catch {
      /* fall through to the raw value */
    }
  }

  // Also handles a bare "list=PL..." fragment pasted on its own.
  const match = trimmed.match(/[?&]?list=([^&\s]+)/);
  if (match?.[1]) return match[1];

  return trimmed;
}

const PLAYLIST_ID_HINT =
  '再生リストIDは PL / UU / FL / LL / OL などで始まる文字列です。' +
  'YouTubeの再生リストを開いたときのURL「...playlist?list=PLxxxxxxxx」の list= 以降を入力してください。' +
  '（URLをそのまま貼り付けても自動で抽出します）';

/**
 * "Latest" depends on how the playlist is maintained: some are curated with
 * the newest entry pinned to the top, some are appended to. The operator picks
 * which rule applies rather than us guessing.
 */
export async function fetchLatestFromPlaylist(config: PlaylistConfig): Promise<PlaylistVideo> {
  const playlistId = normalisePlaylistId(config.playlistId);
  const cacheKey = `${playlistId}:${config.order}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.video;

  const fetchItems = async (part: string) =>
    call<{ items?: PlaylistItem[] }>('/playlistItems', {
      query: { part, playlistId, maxResults: '50' },
    });

  let data: { items?: PlaylistItem[] };
  try {
    data = await fetchItems('snippet,contentDetails,status');
  } catch (e) {
    const message = errMessage(e);
    // Retry without `status` to distinguish an unsupported part from a bad
    // playlist ID — both surface as an opaque 400.
    if (/\b400\b/.test(message)) {
      try {
        data = await fetchItems('snippet,contentDetails');
        log.warn('playlistItems: status part rejected, continuing without it');
      } catch {
        throw new Error(
          `再生リストID「${playlistId}」を取得できませんでした（${message}）。${PLAYLIST_ID_HINT}`,
        );
      }
    } else if (/404|playlistNotFound/i.test(message)) {
      throw new Error(
        `再生リスト「${playlistId}」が見つかりません。IDが正しいか、再生リストが「非公開」になっていないか確認してください。`,
      );
    } else {
      throw e;
    }
  }

  // Deleted and private entries stay in the playlist but have no usable video.
  const items = (data.items ?? []).filter(
    (i) =>
      i.snippet?.resourceId?.videoId &&
      i.contentDetails?.videoPublishedAt &&
      i.status?.privacyStatus !== 'private',
  );

  if (!items.length) {
    throw new Error(
      `再生リスト「${playlistId}」に公開中の動画がありません（非公開・削除済みの動画は除外されます）。`,
    );
  }

  let chosen: PlaylistItem;
  if (config.order === 'newest') {
    chosen = items.reduce((a, b) =>
      new Date(b.contentDetails!.videoPublishedAt!) > new Date(a.contentDetails!.videoPublishedAt!) ? b : a,
    );
  } else if (config.order === 'first') {
    chosen = items.reduce((a, b) => (b.snippet.position < a.snippet.position ? b : a));
  } else {
    chosen = items.reduce((a, b) => (b.snippet.position > a.snippet.position ? b : a));
  }

  const video: PlaylistVideo = {
    videoId: chosen.snippet.resourceId.videoId,
    title: chosen.snippet.title,
    url: `https://www.youtube.com/watch?v=${chosen.snippet.resourceId.videoId}`,
    publishedAt: chosen.contentDetails?.videoPublishedAt ?? null,
  };

  cache.set(cacheKey, { at: Date.now(), video });
  log.debug(`resolved ${config.key} -> ${video.videoId}`);
  return video;
}

export const playlistVariableNames = (key: string) => [`playlist_${key}_url`, `playlist_${key}_title`];

/** Which configured playlists a template body actually references. */
export function referencedPlaylistKeys(body: string, configs: PlaylistConfig[]): PlaylistConfig[] {
  return configs.filter((c) =>
    playlistVariableNames(c.key).some((v) => new RegExp(`\\{\\{\\s*${v}\\s*\\}\\}`).test(body)),
  );
}

/**
 * Resolves every playlist variable a body uses.
 *
 * Failures are returned rather than swallowed: substituting an empty string
 * would publish a comment with a dangling "→" and no link, so the caller stops
 * instead of posting something broken.
 */
export async function resolvePlaylistVariables(
  body: string,
  configs: PlaylistConfig[],
): Promise<{ values: Record<string, string>; errors: string[] }> {
  const values: Record<string, string> = {};
  const errors: string[] = [];

  for (const config of referencedPlaylistKeys(body, configs)) {
    try {
      const video = await fetchLatestFromPlaylist(config);
      values[`playlist_${config.key}_url`] = video.url;
      values[`playlist_${config.key}_title`] = video.title;
    } catch (e) {
      errors.push(`再生リスト「${config.label || config.key}」の取得に失敗: ${errMessage(e)}`);
    }
  }

  return { values, errors };
}
