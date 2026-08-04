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

export type MatchType = 'always' | 'keyword' | 'regex' | 'clip';

/**
 * AutoClipMaker が作った切り抜きの、元になった動画。
 *
 * 切り抜き自体のタイトルだけでは「どの試合の話か」が分からないので、
 * コメントに元動画のリンクを載せるためにここまで持ってくる。
 */
export interface ClipSource {
  /** 元動画のURL。切り抜きコメントの主役。 */
  url: string;
  title?: string;
  videoId?: string;
  /** 切り抜いた位置（元動画の秒）。「元動画の 12:34 から」に使う。 */
  startSec?: number;
}

export interface Template {
  id: number;
  name: string;
  platform: Platform | 'all';
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

export interface VideoRecord {
  key: string;
  platform: Platform;
  videoId: string;
  title: string;
  description: string;
  url: string;
  publishedAt: Date | null;
  detectedAt: Date;
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
  /** AutoClipMaker から来た切り抜きなら、その元動画。 */
  source?: ClipSource;
}
