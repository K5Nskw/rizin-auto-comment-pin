export type Platform = 'youtube' | 'tiktok';

export interface OAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms */
  expiresAt?: number;
  scope?: string;
  openId?: string;
}

export interface Account {
  platform: Platform;
  displayName: string | null;
  externalId: string | null;
  connectedAt: Date | null;
  credentials: OAuthCredentials | null;
}

export type MatchType = 'always' | 'keyword' | 'regex';

/**
 * What a template applies to. 'youtube' covers every YouTube upload including
 * Shorts, so adding 'youtube_shorts' doesn't change what existing templates
 * match; a Shorts-only template wins by having a smaller priority.
 */
export type TemplateTarget = 'all' | 'youtube' | 'youtube_shorts' | 'tiktok';

export interface Template {
  id: number;
  name: string;
  platform: TemplateTarget;
  enabled: boolean;
  priority: number;
  matchType: MatchType;
  matchValue: string;
  /** 複数あるとランダムに1つ選ばれる */
  bodies: string[];
  pin: boolean;
  delaySeconds: number;
}

export type TemplateInput = Omit<Template, 'id'>;

/** Where a clip came from, as reported by AutoClipMaker. */
export interface ClipSource {
  videoId: string;
  url: string;
  title: string;
  startSec: number | null;
}

export interface VideoRecord {
  key: string;
  platform: Platform;
  videoId: string;
  title: string;
  description: string;
  url: string;
  publishedAt: Date | null;
  detectedAt: Date;
  /** Null when it could not be determined — not the same as "not a Short". */
  isShort: boolean | null;
  /** Null for anything that didn't arrive through the clip hook. */
  source: ClipSource | null;
}

export type JobStatus = 'pending' | 'commenting' | 'pinning' | 'done' | 'needs_manual' | 'failed';

export interface Job {
  id: number;
  videoKey: string;
  platform: Platform;
  templateId: number | null;
  templateName: string;
  commentText: string;
  shouldPin: boolean;
  status: JobStatus;
  commentId: string | null;
  commentDone: boolean;
  pinDone: boolean;
  /** Whether this job should link the Short back to its source video. */
  setRelated: boolean;
  relatedDone: boolean;
  attempts: number;
  lastError: string | null;
  runAfter: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface JobWithVideo extends Job {
  video: VideoRecord;
}

/** What a watcher hands to the pipeline when it spots a new upload. */
export interface DetectedVideo {
  platform: Platform;
  videoId: string;
  title: string;
  description?: string;
  url: string;
  publishedAt: Date | null;
  raw?: unknown;
  source?: ClipSource;
  isShort?: boolean | null;
}
