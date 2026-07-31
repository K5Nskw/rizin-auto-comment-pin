import { config, oauthRedirect } from '../../config.js';
import { getAccount, saveAccount, updateCredentials } from '../../db/repo.js';
import { createLogger } from '../../logger.js';
import type { OAuthCredentials } from '../../types.js';

const log = createLogger('tiktok:oauth');

const AUTH_ENDPOINT = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_ENDPOINT = 'https://open.tiktokapis.com/v2/oauth/token/';

/**
 * video.list is what lets us see new uploads. There is no public scope that
 * allows posting or pinning a comment on an organic video — see docs/TIKTOK.md.
 */
export const TIKTOK_SCOPES = ['user.info.basic', 'video.list'];

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_key: config.TIKTOK_CLIENT_KEY,
    scope: TIKTOK_SCOPES.join(','),
    response_type: 'code',
    redirect_uri: oauthRedirect('tiktok'),
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

interface TikTokTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  open_id?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TikTokTokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cache-control': 'no-cache',
    },
    body: new URLSearchParams({
      client_key: config.TIKTOK_CLIENT_KEY,
      client_secret: config.TIKTOK_CLIENT_SECRET,
      ...body,
    }).toString(),
  });
  const json = (await res.json()) as TikTokTokenResponse;
  if (!res.ok || json.error || !json.access_token) {
    throw new Error(
      `TikTok token error: ${json.error ?? res.status} ${json.error_description ?? ''}`.trim(),
    );
  }
  return json;
}

export async function exchangeCode(code: string): Promise<OAuthCredentials> {
  const json = await tokenRequest({
    code: decodeURIComponent(code),
    grant_type: 'authorization_code',
    redirect_uri: oauthRedirect('tiktok'),
  });
  return {
    accessToken: json.access_token!,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in ?? 86_400) * 1000,
    scope: json.scope,
    openId: json.open_id,
  };
}

async function refresh(creds: OAuthCredentials): Promise<OAuthCredentials> {
  if (!creds.refreshToken) {
    throw new Error('TikTok の refresh token がありません。管理画面から再連携してください。');
  }
  const json = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
  });
  log.info('access token refreshed');
  return {
    ...creds,
    accessToken: json.access_token!,
    refreshToken: json.refresh_token ?? creds.refreshToken,
    expiresAt: Date.now() + (json.expires_in ?? 86_400) * 1000,
  };
}

export async function getAccessToken(): Promise<string> {
  const account = await getAccount('tiktok');
  if (!account?.credentials) throw new Error('TikTok が未連携です。管理画面から連携してください。');

  const creds = account.credentials;
  if (creds.expiresAt && creds.expiresAt - Date.now() > 60_000) return creds.accessToken;

  const fresh = await refresh(creds);
  await updateCredentials('tiktok', fresh);
  return fresh.accessToken;
}

export async function persistConnection(creds: OAuthCredentials, user: { openId: string; displayName: string }) {
  await saveAccount('tiktok', {
    displayName: user.displayName,
    externalId: user.openId,
    credentials: creds,
  });
}
