import { createLogger } from '../../logger.js';
import { getAccessToken } from './oauth.js';

const log = createLogger('youtube:api');
const API = 'https://www.googleapis.com/youtube/v3';

export async function call<T>(
  path: string,
  init: RequestInit & { query?: Record<string, string> } = {},
): Promise<T> {
  const token = await getAccessToken();
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);

  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; errors?: Array<{ reason?: string }> } };
      const reason = parsed.error?.errors?.[0]?.reason;
      detail = [parsed.error?.message, reason && `(${reason})`].filter(Boolean).join(' ');
    } catch {
      /* keep raw text */
    }
    throw new Error(`YouTube API ${res.status}: ${detail}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export interface ChannelInfo {
  id: string;
  title: string;
  uploadsPlaylistId?: string;
}

export async function getMyChannel(): Promise<ChannelInfo> {
  const data = await call<{
    items?: Array<{
      id: string;
      snippet: { title: string };
      contentDetails?: { relatedPlaylists?: { uploads?: string } };
    }>;
  }>('/channels', { query: { part: 'snippet,contentDetails', mine: 'true' } });

  const item = data.items?.[0];
  if (!item) throw new Error('チャンネルが取得できませんでした。連携したアカウントを確認してください。');
  return {
    id: item.id,
    title: item.snippet.title,
    uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads,
  };
}

/**
 * Posts a new top-level comment. Costs 50 quota units.
 * Returns the comment id, which the pinner uses to find the right comment.
 */
export async function insertTopLevelComment(videoId: string, text: string): Promise<string> {
  const data = await call<{ id: string; snippet?: { topLevelComment?: { id?: string } } }>(
    '/commentThreads',
    {
      method: 'POST',
      query: { part: 'snippet' },
      body: JSON.stringify({
        snippet: {
          videoId,
          topLevelComment: { snippet: { textOriginal: text } },
        },
      }),
    },
  );
  const id = data.snippet?.topLevelComment?.id ?? data.id;
  log.info(`comment posted on ${videoId}`, { commentId: id });
  return id;
}

/**
 * Removes a comment we posted. Deleting your own comment is permitted with the
 * force-ssl scope, so this is the undo for an unwanted automatic comment.
 */
export async function deleteComment(commentId: string): Promise<void> {
  await call('/comments', { method: 'DELETE', query: { id: commentId } });
  log.info('comment deleted', { commentId });
}

export interface UploadItem {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
}

/** Used by the polling fallback and by the "check now" button. Costs 1 unit. */
export async function listRecentUploads(uploadsPlaylistId: string, max = 10): Promise<UploadItem[]> {
  const data = await call<{
    items?: Array<{
      snippet: {
        title: string;
        description: string;
        publishedAt: string;
        resourceId: { videoId: string };
      };
      contentDetails?: { videoPublishedAt?: string };
    }>;
  }>('/playlistItems', {
    query: { part: 'snippet,contentDetails', playlistId: uploadsPlaylistId, maxResults: String(max) },
  });

  return (data.items ?? []).map((i) => ({
    videoId: i.snippet.resourceId.videoId,
    title: i.snippet.title,
    description: i.snippet.description,
    publishedAt: i.contentDetails?.videoPublishedAt ?? i.snippet.publishedAt,
  }));
}

/** Confirms a video is actually public before commenting on it. */
export async function getVideoStatus(
  videoId: string,
): Promise<{ privacyStatus: string; title: string; description: string; publishedAt: string } | null> {
  const data = await call<{
    items?: Array<{
      snippet: { title: string; description: string; publishedAt: string };
      status: { privacyStatus: string };
    }>;
  }>('/videos', { query: { part: 'snippet,status', id: videoId } });

  const item = data.items?.[0];
  if (!item) return null;
  return {
    privacyStatus: item.status.privacyStatus,
    title: item.snippet.title,
    description: item.snippet.description,
    publishedAt: item.snippet.publishedAt,
  };
}
