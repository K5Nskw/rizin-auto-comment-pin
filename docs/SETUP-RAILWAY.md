# 1. Railway にデプロイする

## 1-1. プロジェクトを作る

1. https://railway.app にログイン
2. **New Project** → **Deploy from GitHub repo** → このリポジトリを選択
3. リポジトリに `Dockerfile` と `railway.json` があるので、ビルド設定は自動で認識されます

## 1-2. Postgres を追加する

1. プロジェクト画面で **New** → **Database** → **Add PostgreSQL**
2. 追加すると `DATABASE_URL` がアプリ側に自動で注入されます（手動設定不要）

> Postgres には OAuth のトークンと Cookie が保存されます。
> ここが消えると再連携が必要になるので、削除しないでください。

## 1-3. 公開URLを発行する

1. アプリのサービスを選択 → **Settings** → **Networking**
2. **Generate Domain** をクリック
3. `https://xxxxx.up.railway.app` のようなURLが発行されます

このURLは OAuth のリダイレクト先と YouTube の push 通知の宛先になるので、必ず発行してください。

## 1-4. 環境変数を設定する

**Variables** タブで以下を設定します。`.env.example` に全項目の説明があります。

### 必須

| 変数 | 値 |
|---|---|
| `PUBLIC_URL` | 1-3 で発行したURL（末尾のスラッシュなし） |
| `ADMIN_USER` | 管理画面のユーザー名（例: `admin`） |
| `ADMIN_PASSWORD` | 管理画面のパスワード（推測されにくいもの） |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` の出力（64文字のhex） |
| `WEBSUB_SECRET` | `openssl rand -hex 16` の出力 |

### 連携時に設定（後からでOK）

| 変数 | 取得先 |
|---|---|
| `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` | [docs/SETUP-YOUTUBE.md](SETUP-YOUTUBE.md) |
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | [docs/SETUP-TIKTOK.md](SETUP-TIKTOK.md) |

### 任意

| 変数 | 既定値 | 説明 |
|---|---|---|
| `NOTIFY_WEBHOOK_URL` | なし | Discord / Slack の Incoming Webhook URL |
| `ENABLE_BROWSER_AUTOMATION` | `true` | `false` にするとピン留めを行わず通知のみ |
| `POLL_INTERVAL_MINUTES` | `5` | 新着チェックの間隔 |
| `MAX_VIDEO_AGE_HOURS` | `48` | これより古い動画にはコメントしない |
| `DRY_RUN` | `false` | `true` にすると投稿せず通知だけ出す（テスト用） |

### 鍵の生成コマンド

```bash
openssl rand -hex 32   # ENCRYPTION_KEY
openssl rand -hex 16   # WEBSUB_SECRET
```

## 1-5. 動作確認

デプロイ完了後、`https://<発行されたURL>/admin/` を開きます。
ブラウザの認証ダイアログで `ADMIN_USER` / `ADMIN_PASSWORD` を入力するとダッシュボードが表示されます。

黄色い警告ボックスに未設定の項目が出るので、それが消えるまで環境変数を埋めてください。

## メモ：イメージサイズについて

既定ではピン留め用の Chromium をイメージに含めるため、ビルド後のイメージは約1GBになります。
ピン留めが不要（通知だけでよい）なら、**Settings → Build → Build Args** に
`INSTALL_BROWSER=false` を追加するとイメージが大幅に小さくなります。
その場合は `ENABLE_BROWSER_AUTOMATION=false` も併せて設定してください。

## メモ：スリープさせないこと

このツールは常駐して新着を監視します。
Railway のプランでサービスがスリープする設定になっていると検知が遅れるので、
常時起動のままにしてください。
