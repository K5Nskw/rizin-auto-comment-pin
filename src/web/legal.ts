import { Router } from 'express';
import { config } from '../config.js';

/**
 * Public privacy policy and terms pages.
 *
 * TikTok's app review requires a reachable privacy policy URL, and Google's
 * OAuth consent screen asks for one too. Serving them from this app means the
 * URL is live the moment the service is deployed, and the text always matches
 * what the code actually does.
 *
 * These pages are intentionally mounted before the admin auth middleware —
 * a reviewer has to be able to open them without credentials.
 */
export const legalRouter: Router = Router();

const LAST_UPDATED = '2026-07-31';

const org = () => config.LEGAL_ORG_NAME || '(LEGAL_ORG_NAME 未設定)';
const email = () => config.LEGAL_CONTACT_EMAIL || '(LEGAL_CONTACT_EMAIL 未設定)';

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function layout(title: string, body: string): string {
  const missing = !config.LEGAL_ORG_NAME || !config.LEGAL_CONTACT_EMAIL;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
 body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif;
      max-width:780px;margin:0 auto;padding:40px 20px 80px;line-height:1.8;color:#1a1a1a}
 h1{font-size:26px;margin-bottom:4px} h2{font-size:18px;margin-top:36px;border-bottom:1px solid #e5e5e5;padding-bottom:6px}
 h3{font-size:15px;margin-top:24px} .meta{color:#666;font-size:13px;margin-bottom:28px}
 ul{padding-left:22px} li{margin:4px 0} code{background:#f4f4f5;padding:2px 5px;border-radius:4px;font-size:13px}
 .warn{background:#fff4e5;border:1px solid #f59e0b;border-radius:8px;padding:12px 16px;margin-bottom:24px;font-size:14px}
 .ja{background:#fafafa;border-left:3px solid #ddd;padding:2px 18px;margin-top:40px}
 footer{margin-top:48px;padding-top:16px;border-top:1px solid #e5e5e5;color:#666;font-size:13px}
 a{color:#0b62d0}
</style></head><body>
${missing ? '<div class="warn"><strong>設定が未完了です。</strong>環境変数 <code>LEGAL_ORG_NAME</code> と <code>LEGAL_CONTACT_EMAIL</code> を設定してから、このURLを審査に提出してください。</div>' : ''}
<h1>${escape(title)}</h1>
<div class="meta">Last updated: ${LAST_UPDATED}</div>
${body}
<footer>${escape(org())} &middot; Contact: ${escape(email())}</footer>
</body></html>`;
}

/* -------------------------------------------------------------------------- */

legalRouter.get('/privacy', (_req, res) => {
  res.type('html').send(
    layout(
      'Privacy Policy',
      `
<p>This policy describes how the internal content-operations tool operated by
<strong>${escape(org())}</strong> (&ldquo;we&rdquo;) handles data. The tool is used solely by our own
staff to operate our own official social media accounts. It is not offered to
the public and has no external end users.</p>

<h2>1. Who this applies to</h2>
<p>The only person who connects an account to this tool is a member of our own
staff, acting for accounts we own. We do not process data belonging to any
other social media user.</p>

<h2>2. What we access and store</h2>

<h3>Connected account information</h3>
<ul>
  <li>Account identifier and display name of the connected account (e.g. TikTok <code>open_id</code> and display name, YouTube channel ID and channel title)</li>
  <li>OAuth access tokens and refresh tokens issued to us for our own account</li>
</ul>

<h3>Our own published videos</h3>
<ul>
  <li>Video identifier, title, description, publication time and public URL of videos published by our own accounts</li>
</ul>

<h3>Operational data</h3>
<ul>
  <li>Comment text generated from templates that our staff maintain</li>
  <li>Processing status and error logs for each detected video</li>
</ul>

<p>We do <strong>not</strong> access, collect, request or store: other users' profiles,
other users' videos, viewer or follower lists, direct messages, comments written by
other users, payment information, or location data.</p>

<h2>3. Why we process it</h2>
<ul>
  <li>To detect when our own account publishes a new video</li>
  <li>To generate a standardized informational comment for that video from our own templates</li>
  <li>To record whether that step succeeded, so our staff can follow up on failures</li>
</ul>
<p>The data is used for no other purpose. We do not use it for advertising,
profiling, analytics about individuals, or model training.</p>

<h2>4. Sharing</h2>
<p>We do not sell, rent, trade or otherwise share this data with third parties.
Data is not disclosed except where required by law.</p>
<p>The tool runs on infrastructure provided by our hosting provider, which
processes the data only as a technical service provider on our behalf.</p>

<h2>5. Storage and security</h2>
<ul>
  <li>Data is stored in a private database that is not publicly reachable</li>
  <li>Access tokens and session credentials are encrypted at rest using AES-256-GCM</li>
  <li>The administrative interface requires authentication</li>
  <li>All communication with platform APIs uses HTTPS</li>
</ul>

<h2>6. Retention and deletion</h2>
<p>Credentials are retained only while the account remains connected.
Disconnecting an account from the tool's administrative interface deletes the
stored tokens immediately. Operational logs are automatically deleted after 30
days. Records of processed videos are retained so that the same video is never
commented on twice; these can be deleted on request.</p>

<h2>7. Revoking access</h2>
<p>Because the connected account is our own, access can be revoked at any time
either from the tool's administrative interface or from the platform's own
application settings (for example, TikTok's &ldquo;Manage app permissions&rdquo; screen or
Google's &ldquo;Third-party apps with account access&rdquo; page). Revoking access
immediately stops all data collection.</p>

<h2>8. Children</h2>
<p>The tool is an internal business system used only by our staff. It is not
directed at, and is not made available to, children.</p>

<h2>9. Changes</h2>
<p>If this policy changes, the revised version will be published at this URL with
an updated &ldquo;Last updated&rdquo; date.</p>

<h2>10. Contact</h2>
<p>Questions about this policy can be directed to
<a href="mailto:${escape(email())}">${escape(email())}</a>.</p>

<div class="ja">
<h2>プライバシーポリシー（日本語）</h2>
<p>本ポリシーは、${escape(org())}（以下「当社」）が自社の公式ソーシャルメディア
アカウントを運用するために使用する社内ツールにおける、データの取り扱いを説明する
ものです。本ツールは当社スタッフのみが使用し、一般には提供していません。</p>

<h3>取得・保存する情報</h3>
<ul>
  <li>連携した自社アカウントの識別子および表示名</li>
  <li>自社アカウントに対して発行されたアクセストークン・リフレッシュトークン</li>
  <li>自社が公開した動画の ID・タイトル・説明文・公開日時・公開URL</li>
  <li>テンプレートから生成したコメント文、および処理状況・エラーログ</li>
</ul>
<p>第三者のプロフィール、第三者の動画、視聴者・フォロワー情報、ダイレクトメッセージ、
第三者が書いたコメント、決済情報、位置情報は、取得も保存も行いません。</p>

<h3>利用目的</h3>
<p>自社アカウントの新規投稿の検知、当該投稿に対する定型告知コメントの生成、および
その処理結果の記録に限って利用します。広告配信・個人のプロファイリング・
機械学習の学習データとしての利用は行いません。</p>

<h3>第三者提供</h3>
<p>取得した情報を第三者に販売・貸与・共有することはありません。法令に基づく場合を
除き、外部に開示しません。</p>

<h3>保管とセキュリティ</h3>
<p>データは外部から直接アクセスできない非公開のデータベースに保管します。
アクセストークンおよびセッション情報は AES-256-GCM により暗号化して保存し、
管理画面へのアクセスには認証を必要とします。</p>

<h3>保存期間と削除</h3>
<p>認証情報は連携が有効な間のみ保持し、管理画面から連携を解除した時点で削除されます。
動作ログは30日で自動削除されます。処理済み動画の記録は、同一動画への二重投稿を
防ぐために保持しますが、ご要望に応じて削除します。</p>

<h3>アクセスの取り消し</h3>
<p>連携先は当社自身のアカウントであるため、管理画面または各プラットフォームの
アプリ連携設定からいつでもアクセスを取り消せます。取り消し後、データの取得は
直ちに停止します。</p>

<h3>お問い合わせ</h3>
<p><a href="mailto:${escape(email())}">${escape(email())}</a></p>
</div>
`,
    ),
  );
});

legalRouter.get('/terms', (_req, res) => {
  res.type('html').send(
    layout(
      'Terms of Service',
      `
<p>These terms govern the use of the internal content-operations tool operated by
<strong>${escape(org())}</strong> (&ldquo;the Tool&rdquo;).</p>

<h2>1. Scope of use</h2>
<p>The Tool is an internal system. It is made available only to authorised staff of
${escape(org())} and only for operating social media accounts that ${escape(org())} owns.
It is not offered, sold or licensed to the public, and no public sign-up exists.</p>

<h2>2. Permitted use</h2>
<p>Authorised users may use the Tool to detect newly published videos on our own
accounts and to prepare and publish informational comments on those videos.
Any other use is not permitted.</p>

<h2>3. Platform rules</h2>
<p>Use of the Tool is subject to the terms of service, developer terms and
community guidelines of each connected platform. Where these terms conflict with
a platform's rules, the platform's rules take precedence.</p>

<h2>4. Account security</h2>
<p>Authorised users are responsible for keeping administrative credentials
confidential and for revoking access when a staff member no longer requires it.</p>

<h2>5. Availability</h2>
<p>The Tool is provided on an &ldquo;as is&rdquo; basis for internal use. No availability
guarantee is offered, and it may be modified or discontinued at any time.</p>

<h2>6. Liability</h2>
<p>To the extent permitted by law, ${escape(org())} accepts no liability for indirect or
consequential loss arising from use of the Tool.</p>

<h2>7. Contact</h2>
<p><a href="mailto:${escape(email())}">${escape(email())}</a></p>

<div class="ja">
<h2>利用規約（日本語）</h2>
<p>本規約は、${escape(org())}（以下「当社」）が運用する社内向けツール（以下「本ツール」）
の利用条件を定めるものです。</p>
<h3>適用範囲</h3>
<p>本ツールは社内システムであり、当社の権限を有するスタッフが、当社が保有する
ソーシャルメディアアカウントを運用する目的でのみ利用できます。一般への提供・販売・
ライセンスは行っておらず、一般向けの登録機能もありません。</p>
<h3>許可される利用</h3>
<p>自社アカウントの新規投稿の検知、および当該投稿への告知コメントの作成・投稿に
限ります。それ以外の利用は認められません。</p>
<h3>各プラットフォームの規約</h3>
<p>本ツールの利用は、連携する各プラットフォームの利用規約・開発者規約・コミュニティ
ガイドラインに従います。本規約とこれらが矛盾する場合は、各プラットフォームの規約が
優先します。</p>
<h3>免責</h3>
<p>本ツールは社内利用を前提に現状有姿で提供され、稼働を保証するものではありません。
法令上許容される範囲で、本ツールの利用に起因する間接損害について当社は責任を
負いません。</p>
<h3>お問い合わせ</h3>
<p><a href="mailto:${escape(email())}">${escape(email())}</a></p>
</div>
`,
    ),
  );
});
