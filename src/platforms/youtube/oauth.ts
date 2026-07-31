import { config, oauthRedirect } from '../../config.js';
import { getAccount, saveAccount, updateCredentials } from '../../db/repo.js';
import { createLogger } from '../../logger.js';
import type { OAuthCredentials } from '../../types.js';

const log = createLogger('youtube:oauth');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** force-ssl is the scope that allows writing comments; it also covers reads. */
export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.force-ssl'];

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.YOUTUBE_CLIENT_ID,
    redirect_uri: oauthRedirect('youtube'),
    response_type: 'code',
    scope: YOUTUBE_SCOPES.join(' '),
    access_type: 'offline',
    // Force the consent screen so Google always returns a refresh_token, even
    // on a re-connect where it would otherwise be omitted.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<GoogleTokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json()) as GoogleTokenResponse;
  if (!res.ok || json.error) {
    throw new Error(`Google token error: ${json.error ?? res.status} ${json.error_description ?? ''}`.trim());
  }
  return json;
}

export async function exchangeCode(code: string): Promise<OAuthCredentials> {
  const json = await tokenRequest({
    code,
    client_id: config.YOUTUBE_CLIENT_ID,
    client_secret: config.YOUTUBE_CLIENT_SECRET,
    redirect_uri: oauthRedirect('youtube'),
    grant_type: 'authorization_code',
  });
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    scope: json.scope,
  };
}

async function refresh(creds: OAuthCredentials): Promise<OAuthCredentials> {
  if (!creds.refreshToken) {
    throw new Error('refresh token がありません。管理画面から YouTube を再連携してください。');
  }
  const json = await tokenRequest({
    refresh_token: creds.refreshToken,
    client_id: config.YOUTUBE_CLIENT_ID,
    client_secret: config.YOUTUBE_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  log.info('access token refreshed');
  return {
    ...creds,
    accessToken: json.access_token,
    // Google keeps the original refresh token unless it rotates one in.
    refreshToken: json.refresh_token ?? creds.refreshToken,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
}

/** Returns a token guaranteed valid for at least the next minute. */
export async function getAccessToken(): Promise<string> {
  const account = await getAccount('youtube');
  if (!account?.credentials) throw new Error('YouTube が未連携です。管理画面から連携してください。');

  const creds = account.credentials;
  if (creds.expiresAt && creds.expiresAt - Date.now() > 60_000) return creds.accessToken;

  const fresh = await refresh(creds);
  await updateCredentials('youtube', fresh);
  return fresh.accessToken;
}

export async function persistConnection(creds: OAuthCredentials, channel: { id: string; title: string }) {
  await saveAccount('youtube', {
    displayName: channel.title,
    externalId: channel.id,
    credentials: creds,
  });
}
