// Fixed local prompt set for the five vendored Intent gold files.
//
// This is a small regression/demo check, not a benchmark: it is not run in CI,
// it is not run by `npm run smoke`, and it never downloads the model. Each gold
// Intent has at least one Japanese and one English paraphrase.

export type IntentPromptLang = 'ja' | 'en';

export interface IntentPrompt {
  intent_file: string;
  lang: IntentPromptLang;
  text: string;
}

export const intentPromptSet: readonly IntentPrompt[] = [
  {
    intent_file: '01_affected_products.json',
    lang: 'ja',
    text: 'ブラケット DEMO-BRKT-01 の生産終了で影響を受ける製品を教えてください。',
  },
  {
    intent_file: '01_affected_products.json',
    lang: 'ja',
    text: 'DEMO-BRKT-01 を含んでいるデスクファンの組み立て品はどれですか。',
  },
  {
    intent_file: '01_affected_products.json',
    lang: 'en',
    text: 'Which desk-fan assemblies are affected by the end of life of bracket DEMO-BRKT-01?',
  },
  {
    intent_file: '01_affected_products.json',
    lang: 'en',
    text: 'List the products that contain part DEMO-BRKT-01.',
  },
  {
    intent_file: '02_affected_bop.json',
    lang: 'ja',
    text: 'OP-BRKT-MOUNT はどのワークセンターで実行されていますか。',
  },
  {
    intent_file: '02_affected_bop.json',
    lang: 'ja',
    text: 'ブラケット取り付け工程の製造設備を知りたいです。',
  },
  {
    intent_file: '02_affected_bop.json',
    lang: 'en',
    text: 'Which work center performs operation OP-BRKT-MOUNT?',
  },
  {
    intent_file: '02_affected_bop.json',
    lang: 'en',
    text: 'Where is the bracket mounting operation run?',
  },
  {
    intent_file: '03_affected_customers.json',
    lang: 'ja',
    text: 'DEMO-BRKT-01 を使う製品を注文している顧客は誰ですか。',
  },
  {
    intent_file: '03_affected_customers.json',
    lang: 'ja',
    text: 'ブラケット変更の影響が及ぶ顧客を挙げてください。',
  },
  {
    intent_file: '03_affected_customers.json',
    lang: 'en',
    text: 'Which customers ordered the assemblies that contain DEMO-BRKT-01?',
  },
  {
    intent_file: '03_affected_customers.json',
    lang: 'en',
    text: 'List the customers affected by the bracket change.',
  },
  {
    intent_file: '04_alternatives.json',
    lang: 'ja',
    text: 'DEMO-BRKT-01 の代替部品はありますか。',
  },
  {
    intent_file: '04_alternatives.json',
    lang: 'ja',
    text: 'ブラケットの代替候補を教えてください。',
  },
  {
    intent_file: '04_alternatives.json',
    lang: 'en',
    text: 'Is there an alternate part for DEMO-BRKT-01?',
  },
  {
    intent_file: '04_alternatives.json',
    lang: 'en',
    text: 'What alternate bracket can replace the end-of-life part?',
  },
  {
    intent_file: '05_residual_risk.json',
    lang: 'ja',
    text: 'open の ECO DEMO-ECO-FAN-01 でまだ影響を受ける項目は何ですか。',
  },
  {
    intent_file: '05_residual_risk.json',
    lang: 'ja',
    text: '変更後も残るリスク対象を教えてください。',
  },
  {
    intent_file: '05_residual_risk.json',
    lang: 'en',
    text: 'Which items are still affected by open ECO DEMO-ECO-FAN-01?',
  },
  {
    intent_file: '05_residual_risk.json',
    lang: 'en',
    text: 'What residual risk remains from the open engineering change?',
  },
];
