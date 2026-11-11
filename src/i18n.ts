export type Lang = 'ja' | 'en';

export const messages = {
  en: {
    title: 'Ontographia PLM Demo',
    subtitle: 'Desk-fan bracket EOL / ECO — in-browser Intent executor over a static fixture',
    language: 'Language',
    loading: 'Loading Ontographia (WASM)…',
    loadError: 'Ontographia (WASM) failed to load',
    retry: 'Retry',
    abiLabel: 'ABI version',
    disclaimer:
      'Ontographia compiled the Cypher. Results come from the in-browser Intent executor over the fixture (not a graph DB; the Cypher string was not executed).',
    chipsHeading: 'Ask a change question',
    chipsHint: 'Choose one question. Each run executes the same vendored Intent over the fixture.',
    chipsDisabled: 'Chips are disabled until the WASM engine loads.',
    selectChip: 'Select a chip to run an Intent.',
    laneEbom: 'EBOM',
    laneMbom: 'MBOM',
    laneSbom: 'SBOM',
    laneBop: 'BOP',
    laneEmpty: 'No nodes in this lane.',
    mbomNote:
      'MBOM: not in this fixture. No MBOM tags or nodes exist in the vendored data, so this lane is left empty.',
    swimlaneHeading: 'Ripple swimlane',
    swimlaneHelp:
      'Nodes are placed by their fixture lane. Only nodes on the Intent path are highlighted; lane hints do not add results.',
    nodeStart: 'start',
    nodeOnPath: 'on path',
    laneHintsLabel: 'Lane hints',
    laneHintsNote: 'Hints emphasize lanes; they never add highlighted nodes.',
    hintedLaneLegend: 'Hinted lane',
    crossLaneHeading: 'Cross-lane edges',
    crossLaneHelp:
      'Fixture relationships that connect different lanes. Edges on the current Intent path are marked.',
    noCrossLaneEdges: 'No cross-lane edges in this fixture.',
    edgeOnPath: 'on path',
    hudHeading: 'Intent run',
    hudEmpty: 'No Intent has run yet. Choose a chip.',
    verified: 'Verified',
    compiledBadge: 'Ontographia compiled the Cypher',
    notExecutedNote:
      'The results below come from the in-browser Intent executor over the fixture (not a graph DB). The Cypher string above was not executed.',
    intentLabel: 'Resolved Intent',
    queryLabel: 'Compiled Cypher (audit artifact)',
    paramsLabel: 'Bound parameters',
    resultsLabel: 'Results',
    noMatches:
      'No matches. The Intent ran successfully and returned zero rows; no nodes are highlighted.',
    pathLabel: 'Traversal path',
    pathNodesLabel: 'Path nodes',
    pathEdgesLabel: 'Traversed edges',
    startNodeLabel: 'Start node',
    errorHeading: 'Intent run failed',
    compileError: 'Query compilation failed',
    executorError: 'Intent execution failed',
    freeTextHeading: 'Free-text question (in-browser model)',
    freeTextIntro:
      'Type a change question. A small model in this browser converts it to Intent JSON, which is validated before anything runs.',
    freeTextChecking: 'Checking browser GPU support…',
    webgpuNotice:
      'WebGPU is not available in this browser, so free-text is disabled. All five chips still work. No model is downloaded, and there is no CPU, WASM, or server fallback for the model.',
    freeTextConsentTitle: 'Download the model to enable free-text',
    freeTextModelLabel: 'Model',
    freeTextVramLabel: 'GPU memory (documented)',
    freeTextVramValue: '879.04 MB',
    freeTextDownloadLabel: 'Download (documented)',
    freeTextDownloadValue: '695,242,752 bytes (about 695 MB)',
    freeTextDownloadSource:
      'GPU memory is from WebLLM prebuiltAppConfig. Download size is the model repository’s documented Hugging Face usedStorage, not a measurement made by this demo.',
    freeTextConsentBody:
      'The model runs locally in this tab. Weights and model_lib are downloaded from the allowlisted hosts only after you choose the button below. Your prompt is not sent to an external inference API.',
    freeTextConsentButton: 'Download and load model',
    freeTextCachedBody:
      'You allowed this model on this browser before. Loading now reuses the browser cache when present; otherwise it downloads again.',
    freeTextLoadButton: 'Load model',
    freeTextCacheNote:
      'A later visit can load the cached model without asking for consent again. This page still never downloads the model on first paint.',
    freeTextCancel: 'Cancel',
    freeTextLoading: 'Downloading and loading the model…',
    freeTextProgress: 'Progress',
    freeTextCancelled: 'Model loading was cancelled. Chips still work.',
    freeTextLoadFailed: 'The model could not be loaded. Chips still work.',
    freeTextRetry: 'Retry',
    freeTextInputLabel: 'Your question',
    freeTextPlaceholder: 'e.g. Which products are affected by the bracket end of life?',
    freeTextConvert: 'Convert',
    freeTextGenerating: 'Converting your question in this browser…',
    freeTextProposalTitle: 'Proposed Intent (not run yet)',
    freeTextProposalMatched: 'Matches template',
    freeTextProposalCustom:
      'Modified / custom Intent: it does not match any of the five supported templates.',
    freeTextProposalPath: 'Path',
    freeTextProposalNote:
      'Nothing has run. Choose Run to execute this Intent, or Cancel to discard the proposal.',
    freeTextRunIntent: 'Run',
    freeTextCancelProposal: 'Cancel',
    freeTextRejectedTitle: 'Model output rejected',
    freeTextErrorTitle: 'Free-text failed',
    freeTextRejectedBody:
      'Nothing was compiled or executed, the Verified badge is not shown, and previous highlights were cleared.',
    freeTextInvalidBody:
      'The output was not a valid Intent: invalid JSON, an unknown or missing key, a wrong type, or Cypher text. The model is only allowed to return Intent JSON.',
    freeTextCompileBody:
      'The Intent passed the schema check but Ontographia could not compile it. Nothing was executed.',
    freeTextExecutorBody:
      'The Intent passed validation but the fixture executor rejected it. Nothing was executed.',
    freeTextGenerateBody:
      'Generation failed (possibly out of GPU memory). Chips still work. Retry will reload the model.',
    freeTextPrivacy:
      'Prompts stay in this tab. No external inference API is called; only model files come from the CSP allowlist after consent.',
    freeTextNoCypher: 'The model is asked for Intent JSON only, never Cypher.',
    invalidIntentError: 'The model output did not pass the Intent schema check.',
  },
  ja: {
    title: 'Ontographia PLM デモ',
    subtitle: 'デスクファン ブラケットの EOL / ECO — 静的フィクスチャ上で動くブラウザ内 Intent エグゼキュータ',
    language: '言語',
    loading: 'Ontographia (WASM) を読み込み中…',
    loadError: 'Ontographia (WASM) の読み込みに失敗しました',
    retry: '再試行',
    abiLabel: 'ABI バージョン',
    disclaimer:
      'Ontographia が Cypher をコンパイルしました。結果はフィクスチャ上でブラウザ内の Intent エグゼキュータが算出したものです（グラフ DB ではありません。Cypher 文字列は実行されていません）。',
    chipsHeading: '変更に関する問いを選ぶ',
    chipsHint: '問いを 1 つ選んでください。各実行は同じ同梱 Intent をフィクスチャ上で実行します。',
    chipsDisabled: 'WASM エンジンが読み込まれるまでチップは無効です。',
    selectChip: 'チップを選ぶと Intent が実行されます。',
    laneEbom: 'EBOM',
    laneMbom: 'MBOM',
    laneSbom: 'SBOM',
    laneBop: 'BOP',
    laneEmpty: 'このレーンにノードはありません。',
    mbomNote:
      'MBOM: このフィクスチャにはありません。同梱データに MBOM タグもノードも存在しないため、このレーンは空のままにしています。',
    swimlaneHeading: '波及スイムレーン',
    swimlaneHelp:
      'ノードはフィクスチャのレーンに従って配置されます。ハイライトされるのは Intent の経路上のノードだけです。レーンヒントは結果を追加しません。',
    nodeStart: '起点',
    nodeOnPath: '経路上',
    laneHintsLabel: 'レーンヒント',
    laneHintsNote: 'ヒントはレーンを強調するだけで、ハイライトするノードを追加しません。',
    hintedLaneLegend: 'ヒント対象レーン',
    crossLaneHeading: 'レーン間エッジ',
    crossLaneHelp:
      '異なるレーンを結ぶフィクスチャのリレーションです。現在の Intent 経路上のエッジには印が付きます。',
    noCrossLaneEdges: 'このフィクスチャにレーン間エッジはありません。',
    edgeOnPath: '経路上',
    hudHeading: 'Intent 実行',
    hudEmpty: 'まだ Intent を実行していません。チップを選んでください。',
    verified: '検証済み',
    compiledBadge: 'Ontographia が Cypher をコンパイルしました',
    notExecutedNote:
      '下の結果はフィクスチャ上でブラウザ内の Intent エグゼキュータが算出したものです（グラフ DB ではありません）。上の Cypher 文字列は実行されていません。',
    intentLabel: '解決された Intent',
    queryLabel: 'コンパイルされた Cypher（監査用）',
    paramsLabel: 'バインドされたパラメータ',
    resultsLabel: '結果',
    noMatches:
      '一致なし。Intent は正常に実行され、0 行を返しました。ハイライトされるノードはありません。',
    pathLabel: '走査経路',
    pathNodesLabel: '経路ノード',
    pathEdgesLabel: '走査エッジ',
    startNodeLabel: '起点ノード',
    errorHeading: 'Intent 実行に失敗しました',
    compileError: 'クエリのコンパイルに失敗しました',
    executorError: 'Intent の実行に失敗しました',
    freeTextHeading: '自由文の質問（ブラウザ内モデル）',
    freeTextIntro:
      '変更に関する質問を入力してください。このブラウザ内の小さなモデルが Intent JSON に変換し、検証してから実行します。',
    freeTextChecking: 'ブラウザの GPU 対応を確認しています…',
    webgpuNotice:
      'このブラウザでは WebGPU を利用できないため、自由文は無効です。5 つのチップは引き続き動作します。モデルのダウンロードは行わず、CPU・WASM・サーバーへのフォールバックもありません。',
    freeTextConsentTitle: 'モデルをダウンロードして自由文を有効にする',
    freeTextModelLabel: 'モデル',
    freeTextVramLabel: 'GPU メモリ（公表値）',
    freeTextVramValue: '879.04 MB',
    freeTextDownloadLabel: 'ダウンロード（公表値）',
    freeTextDownloadValue: '695,242,752 バイト（約 695 MB）',
    freeTextDownloadSource:
      'GPU メモリは WebLLM の prebuiltAppConfig の値です。ダウンロードサイズはモデルリポジトリの Hugging Face usedStorage の公表値であり、このデモでの実測値ではありません。',
    freeTextConsentBody:
      'モデルはこのタブ内で動作します。重みと model_lib は、下のボタンを選んだ後にのみ許可リストのホストからダウンロードされます。入力した質問が外部の推論 API に送信されることはありません。',
    freeTextConsentButton: 'モデルをダウンロードして読み込む',
    freeTextCachedBody:
      'このブラウザでは以前にこのモデルを許可しています。読み込むと、キャッシュがあれば再利用し、なければ再ダウンロードします。',
    freeTextLoadButton: 'モデルを読み込む',
    freeTextCacheNote:
      '次回以降の訪問では、同意を再度求めずにキャッシュ済みモデルを読み込めます。ただし、初回描画時にモデルをダウンロードすることはありません。',
    freeTextCancel: 'キャンセル',
    freeTextLoading: 'モデルをダウンロードして読み込み中…',
    freeTextProgress: '進捗',
    freeTextCancelled: 'モデルの読み込みをキャンセルしました。チップは引き続き動作します。',
    freeTextLoadFailed: 'モデルを読み込めませんでした。チップは引き続き動作します。',
    freeTextRetry: '再試行',
    freeTextInputLabel: '質問',
    freeTextPlaceholder: '例: ブラケットの生産終了で影響を受ける製品は？',
    freeTextConvert: '変換',
    freeTextGenerating: 'このブラウザ内で質問を変換しています…',
    freeTextProposalTitle: '提案された Intent（未実行）',
    freeTextProposalMatched: '一致するテンプレート',
    freeTextProposalCustom:
      '変更されたカスタム Intent: 5 つの対応テンプレートのいずれにも一致しません。',
    freeTextProposalPath: '経路',
    freeTextProposalNote:
      'まだ何も実行していません。「実行」でこの Intent を実行し、「キャンセル」で提案を破棄します。',
    freeTextRunIntent: '実行',
    freeTextCancelProposal: 'キャンセル',
    freeTextRejectedTitle: 'モデル出力を拒否しました',
    freeTextErrorTitle: '自由文の処理に失敗しました',
    freeTextRejectedBody:
      'コンパイルも実行も行っておらず、検証済みバッジは表示せず、以前のハイライトは消去しました。',
    freeTextInvalidBody:
      '出力は有効な Intent ではありませんでした（不正な JSON、未知または不足のキー、型の誤り、Cypher 文字列のいずれか）。モデルが返せるのは Intent JSON のみです。',
    freeTextCompileBody:
      'Intent はスキーマ検証を通過しましたが、Ontographia がコンパイルできませんでした。実行は行っていません。',
    freeTextExecutorBody:
      'Intent は検証を通過しましたが、フィクスチャのエグゼキュータが拒否しました。実行は行っていません。',
    freeTextGenerateBody:
      '生成に失敗しました（GPU メモリ不足の可能性があります）。チップは引き続き動作します。再試行するとモデルを読み込み直します。',
    freeTextPrivacy:
      '入力した質問はこのタブ内に留まります。外部の推論 API は呼び出しません。同意後に許可リストから取得するのはモデルファイルのみです。',
    freeTextNoCypher: 'モデルには Intent JSON のみを求め、Cypher は書かせません。',
    invalidIntentError: 'モデル出力が Intent スキーマ検証を通過しませんでした。',
  },
} as const;

export type MessageKey = keyof (typeof messages)['en'];
export type Messages = (typeof messages)['en'];
