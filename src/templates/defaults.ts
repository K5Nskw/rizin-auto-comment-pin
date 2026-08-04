import { countTemplates, createTemplate, getSetting, setSetting } from '../db/repo.js';
import { createLogger } from '../logger.js';
import type { TemplateInput } from '../types.js';

const log = createLogger('templates');

/**
 * Seeded only when the templates table is empty, so edits made in the admin UI
 * are never overwritten by a redeploy.
 */
export const DEFAULT_TEMPLATES: TemplateInput[] = [
  {
    name: '試合ハイライト用',
    platform: 'all',
    enabled: true,
    // 記者会見より後に判定させる。「記者会見ダイジェスト」のような
    // 両方に当たるタイトルを、より具体的な会見用テンプレートに渡すため。
    priority: 20,
    matchType: 'keyword',
    matchValue: 'ハイライト, HIGHLIGHT, 全試合, 試合結果, 名勝負',
    bodies: [
      '🔥 {{title}}\n[[この一戦、何度でも見たい。|決着の瞬間をもう一度。|痺れる展開でした。]]\n\n▼ 大会情報・チケットはこちら\nhttps://jp.rizinff.com/\n\n#RIZIN',
      '⚡️ ハイライト公開！\n[[皆さんのベストバウトはどの試合ですか？|一番熱くなった試合をコメントで教えてください！]]\n\n▼ 次回大会情報\nhttps://jp.rizinff.com/\n\n#RIZIN',
    ],
    pin: true,
    delaySeconds: 30,
  },
  {
    name: '記者会見・会見用',
    platform: 'all',
    enabled: true,
    priority: 10,
    matchType: 'keyword',
    matchValue: '会見, 記者会見, 前日, 計量, 公開練習',
    bodies: [
      '📣 {{title}}\n[[大会に向けて緊張感が高まってきました。|いよいよ本番が近づいてきました。]]\n\n▼ 大会情報・チケット\nhttps://jp.rizinff.com/\n\n#RIZIN',
    ],
    pin: true,
    delaySeconds: 30,
  },
  {
    name: 'ショート動画用（短文）',
    platform: 'tiktok',
    enabled: true,
    priority: 30,
    matchType: 'always',
    matchValue: '',
    bodies: [
      '🔥[[最高の瞬間|この一撃|痺れる展開]]！続きはプロフィールのリンクから👊 #RIZIN',
      '👊 感想はコメントで教えてください！ #RIZIN',
    ],
    pin: true,
    delaySeconds: 60,
  },
  {
    name: 'デフォルト（すべての動画）',
    platform: 'all',
    enabled: true,
    priority: 999,
    matchType: 'always',
    matchValue: '',
    bodies: [
      '📺 {{title}}\nご視聴ありがとうございます！\n\n▼ 大会情報・チケットはこちら\nhttps://jp.rizinff.com/\n\n#RIZIN',
    ],
    pin: true,
    delaySeconds: 30,
  },
];

/**
 * AutoClipMaker から届いた切り抜き専用のテンプレート。
 *
 * 「使う条件＝切り抜き」なので、通常の新着検知では絶対に当たらない。
 * 元動画へのリンクを置くのがこのテンプレートの存在理由。
 */
export const CLIP_TEMPLATE: TemplateInput = {
  name: '切り抜き用（元動画リンク）',
  platform: 'all',
  enabled: true,
  // 切り抜きにだけ当たるので、他のどれよりも先に判定させて構わない
  priority: 5,
  matchType: 'clip',
  matchValue: '',
  bodies: [
    '▼ 元動画（フル）はこちら\n{{sourceUrlAt}}\n\n[[続きはぜひ本編で。|この続きが気になる方はこちらから。]]\n\n#RIZIN',
  ],
  pin: true,
  delaySeconds: 30,
};

export async function seedDefaultTemplates(): Promise<void> {
  if ((await countTemplates()) === 0) {
    for (const t of DEFAULT_TEMPLATES) await createTemplate(t);
    log.info(`seeded ${DEFAULT_TEMPLATES.length} default templates`);
  }

  // 切り抜き用は後から足した機能なので、テンプレートが既にある環境にも1回だけ入れる。
  // 消したものが復活しないよう、入れたことを覚えておく。
  if (!(await getSetting<boolean>('clip_template_seeded'))) {
    await createTemplate(CLIP_TEMPLATE);
    await setSetting('clip_template_seeded', true);
    log.info('seeded the clip template');
  }
}
