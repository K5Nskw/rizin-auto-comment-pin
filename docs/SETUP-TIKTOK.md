# 3. TikTok を連携する

## 先に知っておくこと

TikTok の公開APIでできるのは **新着動画の検知だけ** です。

| やりたいこと | 可否 |
|---|---|
| 自分の投稿一覧を取得（新着検知） | ✅ `video.list` スコープで可能 |
| 自分の動画にコメントを投稿 | ❌ 公開APIなし |
| コメントをピン留め | ❌ 公開APIなし |

TikTok Business API には広告(Ads)のコメント管理APIがありますが、
これは広告に紐づくコメント用で、通常投稿のコメントには使えず、ピン留め機能もありません。

そのため **TikTokのコメント投稿とピン留めは、両方ともブラウザ自動操作で行います。**
→ [docs/BROWSER-SESSION.md](BROWSER-SESSION.md) の設定が必須です。

TikTok連携（このページの手順）は「新着をいつ検知するか」のためだけに必要です。

---

## 3-1. TikTok 開発者アプリを作る

1. https://developers.tiktok.com/ にログイン
2. **Manage apps** → **Connect an app**
3. アプリ名・説明・アイコンなどを入力

## 3-2. 製品（Products）を追加する

**Login Kit** と **Display API** を追加します。

## 3-3. スコープを申請する

以下のスコープを有効にします。

```
user.info.basic
video.list
```

> `video.list` は審査が必要な場合があります。用途欄には
> 「自社アカウントの新規投稿を検知して、自社の運用フローに連携するため」
> のように記載してください。審査には数日かかることがあります。

## 3-4. リダイレクトURIを登録する

**Login Kit** の設定にある Redirect URI に以下を追加：

```
https://<Railwayで発行したURL>/oauth/tiktok/callback
```

例: `https://rizin-auto-comment-pin-production.up.railway.app/oauth/tiktok/callback`

## 3-5. Railway に設定する

アプリの **Client key** と **Client secret** を Railway の Variables に追加：

```
TIKTOK_CLIENT_KEY=<Client key>
TIKTOK_CLIENT_SECRET=<Client secret>
```

## 3-6. 連携する

1. 管理画面 → **アカウント連携** タブ
2. **TikTok を連携する** をクリック
3. RIZINのTikTokアカウントでログイン → 権限を許可

ダッシュボードの TikTok カードにアカウント名が表示されればOKです。

---

## 検知のタイミングについて

TikTok には push 通知の仕組みがないため、`POLL_INTERVAL_MINUTES`（既定5分）ごとに
投稿一覧を確認します。投稿から最大5分ほど遅れてコメントされます。

すぐ反映したい場合は管理画面の **「今すぐ新着チェック」** を押してください。

また、テンプレートの「投稿までの待ち時間」を長め（60〜120秒）に設定しておくと、
動画の公開処理が完了する前にコメントしてしまうのを避けられます。

## 連携せずに使うことはできる？

できます。TikTok連携をしない場合、TikTokの新着は検知されません。
YouTubeだけ自動化して、TikTokは手動、という運用も可能です。
