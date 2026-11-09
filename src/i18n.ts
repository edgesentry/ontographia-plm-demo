export type Lang = 'ja' | 'en';

export const messages = {
  en: {
    title: 'Ontographia PLM Demo',
    subtitle: 'Deskfan bracket EOL / ECO — static, in-browser',
    language: 'Language',
    loading: 'Loading Ontographia (WASM)…',
    error: 'Failed to load Ontographia',
    retry: 'Retry',
    smokeHeading: 'Smoke test: query compilation',
    disclaimer:
      'This only compiles a fixed Intent into a Cypher query. It is NOT graph analysis; no graph is executed.',
    intentLabel: 'Fixed Intent',
    queryLabel: 'Generated Cypher',
    paramsLabel: 'Parameters',
    abiLabel: 'ABI version',
    compile: 'Compile query',
    compileError: 'Query compilation failed',
  },
  ja: {
    title: 'Ontographia PLM デモ',
    subtitle: 'デスクファン ブラケットの EOL / ECO — 静的・ブラウザ内完結',
    language: '言語',
    loading: 'Ontographia (WASM) を読み込み中…',
    error: 'Ontographia の読み込みに失敗しました',
    retry: '再試行',
    smokeHeading: 'スモークテスト: クエリのコンパイル',
    disclaimer:
      '固定の Intent を Cypher クエリにコンパイルするだけです。グラフ分析ではなく、グラフは実行されません。',
    intentLabel: '固定 Intent',
    queryLabel: '生成された Cypher',
    paramsLabel: 'パラメータ',
    abiLabel: 'ABI バージョン',
    compile: 'クエリをコンパイル',
    compileError: 'クエリのコンパイルに失敗しました',
  },
} as const;

export type MessageKey = keyof (typeof messages)['en'];
