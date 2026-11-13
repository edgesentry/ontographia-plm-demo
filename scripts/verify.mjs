import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const fail = (message) => {
  console.error('verify FAILED:', message);
  process.exit(1);
};
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const section = (name) => console.log(`\n== ${name} ==`);

/**
 * Load a dependency-free TypeScript module without a runtime TS loader.
 * `typescript` (already a devDependency) transpiles the source, then Node
 * imports the result from a data URL. Node 22 safe; no brittle source regex.
 */
async function loadTsModule(relativePath) {
  const source = readFileSync(join(root, relativePath), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: relativePath,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

section('typecheck');
sh('npx', ['tsc', '--noEmit']);

section('vendored data');
const dataDir = join(root, 'vendor/ontographia/data');
for (const file of ['plm.native.yaml', 'chips.json', 'fixtures/deskfan_eol.graph.json']) {
  if (!existsSync(join(dataDir, file))) fail(`missing data file ${file}`);
}
const intentFiles = readdirSync(join(dataDir, 'intents'))
  .filter((file) => file.endsWith('.json'))
  .sort();
if (intentFiles.length !== 5) fail(`expected 5 intents, got ${intentFiles.length}`);
const intents = new Map();
for (const file of intentFiles) {
  try {
    intents.set(file, JSON.parse(readFileSync(join(dataDir, 'intents', file), 'utf8')));
  } catch (error) {
    fail(`invalid Intent JSON ${file}: ${error.message}`);
  }
}

const chipsRaw = JSON.parse(readFileSync(join(dataDir, 'chips.json'), 'utf8'));
const chipList = Array.isArray(chipsRaw) ? chipsRaw : chipsRaw.chips;
if (!Array.isArray(chipList) || chipList.length !== 5) fail('chips.json must list 5 chips');
const validLanes = new Set(['ebom', 'mbom', 'sbom', 'bop']);
for (const chip of chipList) {
  for (const key of ['label_ja', 'label_en', 'description_ja', 'description_en']) {
    if (!chip[key] || !String(chip[key]).trim()) fail(`chip ${chip.chip_id || '?'} missing ${key}`);
  }
  if (!Array.isArray(chip.lane_hints) || chip.lane_hints.length === 0) {
    fail(`chip ${chip.chip_id || '?'} missing lane_hints`);
  }
  for (const lane of chip.lane_hints) {
    if (!validLanes.has(lane)) fail(`chip ${chip.chip_id} has unknown lane hint ${lane}`);
  }
}
const chipIntentFiles = chipList.map((chip) => basename(chip.intent_path));
if (new Set(chipIntentFiles).size !== 5) fail('chip intent_path values must resolve to 5 distinct filenames');
for (const file of chipIntentFiles) {
  if (!intentFiles.includes(file)) fail(`chip intent_path does not resolve under data/intents/: ${file}`);
}

const fixtureText = readFileSync(join(dataDir, 'fixtures/deskfan_eol.graph.json'), 'utf8');
const fixture = JSON.parse(fixtureText);
if (!Array.isArray(fixture.nodes) || fixture.nodes.length !== 18) {
  fail(`fixture must contain 18 nodes, got ${fixture.nodes?.length}`);
}
if (!Array.isArray(fixture.edges)) fail('fixture must contain an edges array');
if (new Set(fixture.nodes.map((node) => node.id)).size !== fixture.nodes.length) {
  fail('fixture node ids must be unique');
}
for (const node of fixture.nodes) {
  const lane = node.properties?.lane;
  if (!validLanes.has(lane)) fail(`fixture node ${node.id} has unknown lane ${String(lane)}`);
  if (lane === 'mbom') fail(`fixture node ${node.id} is tagged MBOM; the vendored fixture has no MBOM data`);
}

for (const [relative, text] of [
  ['chips.json', readFileSync(join(dataDir, 'chips.json'), 'utf8')],
  ['fixtures/deskfan_eol.graph.json', fixtureText],
  ...intentFiles.map((file) => [`intents/${file}`, readFileSync(join(dataDir, 'intents', file), 'utf8')]),
  ['plm.native.yaml', readFileSync(join(dataDir, 'plm.native.yaml'), 'utf8')],
]) {
  if (/pfas/i.test(text)) fail(`PFAS content in ${relative}`);
}

section('i18n');
const { messages } = await loadTsModule('src/i18n.ts');
const enKeys = Object.keys(messages.en);
const jaKeys = Object.keys(messages.ja);
if (enKeys.join('|') !== jaKeys.join('|')) fail('ja/en i18n key sets or order differ');
if (enKeys.length === 0) fail('i18n has no messages');
for (const [lang, block] of Object.entries(messages)) {
  for (const [key, value] of Object.entries(block)) {
    if (typeof value !== 'string' || !value.trim()) fail(`empty i18n string ${lang}.${String(key)}`);
  }
}
if (!/Intent executor/.test(messages.en.disclaimer) || !/not executed/.test(messages.en.disclaimer)) {
  fail('en disclaimer must describe the Intent executor and that the Cypher was not executed');
}
if (!/Intent エグゼキュータ/.test(messages.ja.disclaimer) || !/実行されていません/.test(messages.ja.disclaimer)) {
  fail('ja disclaimer must describe the Intent executor and that the Cypher was not executed');
}
if (/graph is not executed/i.test(messages.en.disclaimer) || /グラフは実行されません/.test(messages.ja.disclaimer)) {
  fail('old disclaimer wording still present');
}
for (const key of ['noMatches', 'verified', 'compiledBadge', 'notExecutedNote', 'mbomNote', 'errorHeading']) {
  if (!messages.en[key] || !messages.ja[key]) fail(`missing ja/en message ${key}`);
}
if (!/^No matches/i.test(messages.en.noMatches) || !messages.ja.noMatches.startsWith('一致なし')) {
  fail('noMatches copy must exist in ja and en');
}

section('WASM package smoke');
const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve('@edgesentry/ontographia-wasm/package.json'));
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
if (pkg.version !== '0.1.9') fail(`expected @edgesentry/ontographia-wasm 0.1.9, got ${pkg.version}`);
const wasmPath = join(pkgDir, 'ontographia_wasm.wasm');
if (!existsSync(wasmPath)) fail(`WASM missing from package at ${wasmPath}`);
const wasmBytes = readFileSync(wasmPath);
const wasmSha256 = sha256(wasmBytes);

section('Relate WASM package');
const relatePkgDir = dirname(require.resolve('@relate/relate-wasm'));
const relatePkg = JSON.parse(readFileSync(join(relatePkgDir, 'package.json'), 'utf8'));
if (relatePkg.version !== '1.0.1') fail(`expected @relate/relate-wasm 1.0.1, got ${relatePkg.version}`);
const relateWasmPath = join(relatePkgDir, 'relate_bg.wasm');
if (!existsSync(relateWasmPath)) fail(`Relate WASM missing from package at ${relateWasmPath}`);
const relateWasmBytes = readFileSync(relateWasmPath);
const relateWasmSha256 = sha256(relateWasmBytes);

const binding = await import('@edgesentry/ontographia-wasm');
const og = await binding.loadOntographia(wasmBytes);
const { assertAbiVersion } = await loadTsModule('src/lib/abi.ts');
assertAbiVersion(og.abiVersion);
for (const abi of [0, 2, '1', null]) {
  let rejected = false;
  try {
    assertAbiVersion(abi);
  } catch {
    rejected = true;
  }
  if (!rejected) fail(`ABI guard accepted invalid version ${String(abi)}`);
}

const ontologyText = readFileSync(join(dataDir, 'plm.native.yaml'), 'utf8');
const compiled = new Map();
for (const file of intentFiles) {
  const result = og.buildCypher(ontologyText, intents.get(file), {
    dialect: 'cypher25',
    ontologyPathHint: 'plm.native.yaml',
  });
  if (!result.query || typeof result.query !== 'string') fail(`WASM smoke: empty query for ${file}`);
  if (!result.params || typeof result.params !== 'object') fail(`WASM smoke: bad params for ${file}`);
  compiled.set(file, result);
}
let malformedRejected = false;
try {
  og.buildCypher(ontologyText, { not: 'an-intent' }, {
    dialect: 'cypher25',
    ontologyPathHint: 'plm.native.yaml',
  });
} catch {
  malformedRejected = true;
}
if (!malformedRejected) fail('WASM smoke: malformed Intent should reject');

section('Intent executor gold tests');
const executor = await loadTsModule('src/lib/executor.ts');
const hierarchy = executor.parseOntology(ontologyText);
for (const className of ['Part', 'Assembly', 'Revision', 'Substance']) {
  if (!(hierarchy.parents.get(className) ?? []).includes('Item')) {
    fail(`COM inheritance missing: ${className} must extend Item`);
  }
  if (!executor.classMatches([className], 'Item', hierarchy)) {
    fail(`COM inheritance match failed: ${className} should match Item`);
  }
}
const runIntent = (file, mutate) => {
  const intent = structuredClone(intents.get(file));
  if (mutate) mutate(intent);
  return executor.executeIntent(fixture, intent, ontologyText);
};

const gold = [
  {
    file: '01_affected_products.json',
    path: ['DEMO-BRKT-01', 'DEMO-FAN-100', 'DEMO-FAN-200', 'DEMO-FAN-300'],
    rows: 3,
  },
  {
    file: '02_affected_bop.json',
    path: ['OP-BRKT-MOUNT', 'WC-LINE-A'],
    rows: 1,
  },
  {
    file: '03_affected_customers.json',
    path: [
      'DEMO-BRKT-01',
      'DEMO-FAN-100',
      'DEMO-FAN-200',
      'DEMO-FAN-300',
      'CUST-EU-01',
      'CUST-NA-01',
      'CUST-APAC-01',
    ],
    rows: 3,
  },
  {
    file: '04_alternatives.json',
    path: ['DEMO-BRKT-01', 'DEMO-BRKT-02'],
    rows: 1,
  },
  {
    file: '05_residual_risk.json',
    path: [
      'DEMO-ECO-FAN-01',
      'DEMO-BRKT-01',
      'DEMO-FAN-100',
      'DEMO-FAN-200',
      'DEMO-FAN-300',
    ],
    rows: 4,
  },
];
const goldResults = new Map();
for (const expected of gold) {
  const result = runIntent(expected.file);
  const actualPath = [...result.pathNodeIds].sort();
  const expectedPath = [...expected.path].sort();
  if (JSON.stringify(actualPath) !== JSON.stringify(expectedPath)) {
    fail(
      `${expected.file} path mismatch\n  expected: ${expectedPath.join(', ')}\n  actual:   ${actualPath.join(', ')}`,
    );
  }
  if (result.rows.length !== expected.rows) {
    fail(`${expected.file} expected ${expected.rows} rows, got ${result.rows.length}`);
  }
  goldResults.set(expected.file, result);
}

const products = goldResults.get('01_affected_products.json');
const productNumbers = products.rows.map((row) => row.part_number).sort();
if (JSON.stringify(productNumbers) !== JSON.stringify(['DEMO-FAN-100', 'DEMO-FAN-200', 'DEMO-FAN-300'])) {
  fail(`affected_products rows mismatch: ${productNumbers.join(', ')}`);
}
if (!products.rows.every((row) => typeof row.name === 'string' && row.name.trim())) {
  fail('affected_products rows must include non-empty names');
}
if (products.pathNodeIds.includes('REV-BRKT-01-A')) fail('affected_products must not walk HAS_REVISION');

const bop = goldResults.get('02_affected_bop.json');
if (bop.rows[0].operation_name !== 'OP-BRKT-MOUNT' || bop.rows[0].work_center_name !== 'Assembly line A') {
  fail('affected_bop row mismatch');
}
if (bop.pathNodeIds.includes('DEMO-BRKT-01')) fail('affected_bop must not auto-extend to the bracket');

const customers = goldResults.get('03_affected_customers.json');
const customerNames = customers.rows.map((row) => row.customer_name).sort();
if (
  JSON.stringify(customerNames) !==
  JSON.stringify(['Fictional APAC partner', 'Fictional EU distributor', 'Fictional NA retailer'])
) {
  fail(`affected_customers rows mismatch: ${customerNames.join(', ')}`);
}
if (
  JSON.stringify(customers.rows.map((row) => row.part_number).sort()) !==
  JSON.stringify(['DEMO-FAN-100', 'DEMO-FAN-200', 'DEMO-FAN-300'])
) {
  fail('affected_customers must join all three assemblies');
}

const alternatives = goldResults.get('04_alternatives.json');
if (alternatives.rows[0].alternate_part_number !== 'DEMO-BRKT-02') {
  fail('alternatives row mismatch');
}

const risk = goldResults.get('05_residual_risk.json');
const riskItems = risk.rows.map((row) => row.affected_item).sort();
if (
  JSON.stringify(riskItems) !==
  JSON.stringify(['DEMO-BRKT-01', 'DEMO-FAN-100', 'DEMO-FAN-200', 'DEMO-FAN-300'])
) {
  fail(`residual_risk rows mismatch: ${riskItems.join(', ')}`);
}
if (!risk.rows.every((row) => row.eco_id === 'DEMO-ECO-FAN-01' && row.eco_status === 'open')) {
  fail('residual_risk must only return open DEMO-ECO-FAN-01');
}
if (risk.pathNodeIds.includes('DEMO-ECO-FAN-02') || risk.pathNodeIds.includes('DEMO-BRKT-02')) {
  fail('residual_risk must exclude the closed ECO and the alternate bracket');
}
if (risk.pathNodeIds.includes('OP-BRKT-MOUNT')) {
  fail('residual_risk must not walk reverse CONSUMES edges');
}

const empty = runIntent('01_affected_products.json', (intent) => {
  intent.filter[0].value = 'DEMO-DOES-NOT-EXIST';
});
if (empty.rows.length !== 0 || empty.pathNodeIds.length !== 0) {
  fail('empty-result filter must succeed with zero rows and zero highlighted nodes');
}
if (empty.stats.returned !== 0) fail('empty-result stats.returned must be 0');

let executorMalformedRejected = true;
for (const bad of [{}, { start: { class: 'Part', alias: 'p' } }, { start: { class: 'Part', alias: 'p' }, return: [] }]) {
  let rejected = false;
  try {
    executor.executeIntent(fixture, bad, ontologyText);
  } catch (error) {
    rejected = error?.code === 'invalid_intent';
  }
  if (!rejected) {
    executorMalformedRejected = false;
    fail(`malformed Intent should throw invalid_intent: ${JSON.stringify(bad)}`);
  }
}

let unsupportedOpRejected = false;
try {
  runIntent('01_affected_products.json', (intent) => {
    intent.filter[0].op = 'ne';
  });
} catch (error) {
  unsupportedOpRejected = error?.code === 'unsupported_op';
}
if (!unsupportedOpRejected) fail('non-eq filter op must be rejected as unsupported_op');

const limited = runIntent('03_affected_customers.json', (intent) => {
  intent.limit = 1;
});
if (limited.rows.length !== 1 || limited.pathNodeIds.length !== 3) {
  fail(`limit=1 should return 1 row over a 3-node path, got ${limited.rows.length} rows / ${limited.pathNodeIds.length} nodes`);
}

section('Intent schema checker');
const schema = await loadTsModule('src/lib/intent-schema.ts');
const goldForSchema = [...intents.values()].map((intent) => structuredClone(intent));
for (const [index, intent] of goldForSchema.entries()) {
  const result = schema.validateIntent(intent);
  if (!result.ok) {
    fail(`gold Intent ${index + 1} must pass the schema: ${result.errors.join('; ')}`);
  }
  if (!schema.canonicalIntent(result.value)) fail(`canonicalIntent failed for gold Intent ${index + 1}`);
}
const baseIntent = () => structuredClone(intents.get('01_affected_products.json'));
const schemaRejects = [
  ['a raw Cypher string', 'MATCH (n) RETURN n'],
  ['an array root', []],
  [
    'an extra top-level key',
    (() => {
      const intent = baseIntent();
      intent.cypher = 'MATCH (n) RETURN n';
      return intent;
    })(),
  ],
  [
    'an unknown nested key',
    (() => {
      const intent = baseIntent();
      intent.traverse[0].unexpected = true;
      return intent;
    })(),
  ],
  [
    'a missing required key',
    (() => {
      const intent = baseIntent();
      delete intent.return;
      return intent;
    })(),
  ],
  [
    'Cypher text in a filter value',
    (() => {
      const intent = baseIntent();
      intent.filter[0].value = 'MATCH (n) RETURN n';
      return intent;
    })(),
  ],
  [
    'an invalid direction',
    (() => {
      const intent = baseIntent();
      intent.traverse[0].direction = 'sideways';
      return intent;
    })(),
  ],
  [
    'an unknown return key',
    (() => {
      const intent = baseIntent();
      intent.return[0].cypher = 'MATCH (n) RETURN n';
      return intent;
    })(),
  ],
  [
    'a non-eq filter op',
    (() => {
      const intent = baseIntent();
      intent.filter[0].op = 'ne';
      return intent;
    })(),
  ],
  [
    'a duplicate traverse alias',
    (() => {
      const intent = baseIntent();
      intent.traverse[0].to.alias = intent.start.alias;
      return intent;
    })(),
  ],
  [
    'a filter alias that is not declared',
    (() => {
      const intent = baseIntent();
      intent.filter[0].alias = 'ghost';
      return intent;
    })(),
  ],
  [
    'a return alias that is not declared',
    (() => {
      const intent = baseIntent();
      intent.return[0].alias = 'ghost';
      return intent;
    })(),
  ],
  [
    'a duplicate return as_name',
    (() => {
      const intent = baseIntent();
      intent.return[1].as_name = intent.return[0].as_name;
      return intent;
    })(),
  ],
  [
    'an overlong filter value',
    (() => {
      const intent = baseIntent();
      intent.filter[0].value = 'x'.repeat(161);
      return intent;
    })(),
  ],
  [
    'undefined limit and optional',
    (() => {
      const intent = baseIntent();
      intent.limit = undefined;
      intent.optional = undefined;
      return intent;
    })(),
  ],
];
for (const [label, value] of schemaRejects) {
  const result = schema.validateIntent(value);
  if (result.ok) fail(`Intent schema accepted ${label}`);
  if (!Array.isArray(result.errors) || result.errors.length === 0) {
    fail(`Intent schema rejection for ${label} must include at least one error`);
  }
}
const parsedGold = schema.parseIntentJson(JSON.stringify(intents.get('01_affected_products.json')));
if (!parsedGold.ok) fail(`parseIntentJson rejected valid JSON: ${parsedGold.error}`);
for (const [label, raw] of [
  ['an empty string', ''],
  ['a markdown fence', '```json\n{"start":{}}\n```'],
  ['a Cypher string', 'MATCH (n) RETURN n'],
]) {
  if (schema.parseIntentJson(raw).ok) fail(`parseIntentJson accepted ${label}`);
}

section('free-text prompt set');
const { intentPromptSet } = await loadTsModule('src/data/intentPromptSet.ts');
if (!Array.isArray(intentPromptSet) || intentPromptSet.length === 0) {
  fail('intentPromptSet must be a non-empty array');
}
const goldIntentFiles = new Set(intentFiles);
const promptsByFile = new Map();
for (const [index, prompt] of intentPromptSet.entries()) {
  if (!prompt || typeof prompt.text !== 'string' || prompt.text.trim().length === 0) {
    fail(`prompt ${index} must have non-empty text`);
  }
  if (prompt.lang !== 'ja' && prompt.lang !== 'en') fail(`prompt ${index} has invalid lang ${String(prompt.lang)}`);
  if (!goldIntentFiles.has(prompt.intent_file)) {
    fail(`prompt ${index} points at unknown Intent ${String(prompt.intent_file)}`);
  }
  const list = promptsByFile.get(prompt.intent_file) ?? [];
  list.push(prompt);
  promptsByFile.set(prompt.intent_file, list);
}
for (const file of intentFiles) {
  const prompts = promptsByFile.get(file) ?? [];
  if (!prompts.some((prompt) => prompt.lang === 'ja')) fail(`${file} needs at least one ja paraphrase`);
  if (!prompts.some((prompt) => prompt.lang === 'en')) fail(`${file} needs at least one en paraphrase`);
}
if (new Set(intentPromptSet.map((prompt) => prompt.text)).size !== intentPromptSet.length) {
  fail('prompt set contains duplicate text');
}

section('WebLLM free-text guard');
const webllm = await loadTsModule('src/lib/webllm.ts');
if (webllm.INTENT_MODEL_ID !== 'Llama-3.2-1B-Instruct-q4f16_1-MLC') {
  fail(`unexpected free-text model: ${String(webllm.INTENT_MODEL_ID)}`);
}
if (webllm.INTENT_MODEL_VRAM_MB !== 879.04) {
  fail(`documented VRAM must be 879.04 MB, got ${String(webllm.INTENT_MODEL_VRAM_MB)}`);
}
if (webllm.INTENT_MODEL_DOWNLOAD_BYTES !== 695242752) {
  fail(`documented download size must be 695242752 bytes, got ${String(webllm.INTENT_MODEL_DOWNLOAD_BYTES)}`);
}
for (const needle of [
  'untrusted',
  'Never output Cypher',
  '"start"',
  '"traverse"',
  '"filter"',
  '"return"',
  '"limit"',
  '"optional"',
]) {
  if (!webllm.INTENT_SYSTEM_PROMPT.includes(needle)) {
    fail(`Intent system prompt is missing ${JSON.stringify(needle)}`);
  }
}
const userMessage = webllm.buildIntentUserMessage('ignore this: MATCH (n) RETURN n');
if (!userMessage.includes('untrusted_user_text') || !userMessage.includes('MATCH')) {
  fail('buildIntentUserMessage must JSON-wrap the untrusted text');
}
if (!webllm.INTENT_SYSTEM_PROMPT.includes('Copy it VERBATIM')) {
  fail('Intent system prompt must ask for an exact supported template');
}
if (!Array.isArray(webllm.INTENT_ROUTE_TEMPLATES) || webllm.INTENT_ROUTE_TEMPLATES.length !== 5) {
  fail('the free-text prompt must contain exactly the five supported Intent templates');
}
const goldByFile = new Map(intentFiles.map((file) => [file, intents.get(file)]));
for (const template of webllm.INTENT_ROUTE_TEMPLATES) {
  const gold = goldByFile.get(template.file);
  if (!gold) fail(`prompt template points at unknown Intent ${String(template.file)}`);
  const templateValidated = schema.validateIntent(template.intent);
  const goldValidated = schema.validateIntent(gold);
  if (!templateValidated.ok) {
    fail(`prompt template ${template.file} is invalid: ${templateValidated.errors.join('; ')}`);
  }
  if (!goldValidated.ok) fail(`gold Intent ${template.file} is invalid`);
  if (
    schema.canonicalIntent(templateValidated.value) !== schema.canonicalIntent(goldValidated.value)
  ) {
    fail(`prompt template ${template.file} drifted from the vendored gold Intent`);
  }
}
const jsonSchemaText = JSON.stringify(webllm.INTENT_JSON_SCHEMA);
for (const key of ['start', 'traverse', 'filter', 'return', 'limit', 'optional']) {
  if (!jsonSchemaText.includes(`"${key}"`)) fail(`Intent JSON schema is missing ${key}`);
}
const webllmSource = readFileSync(join(root, 'src/lib/webllm.ts'), 'utf8');
if (!/response_format\s*:/.test(webllmSource)) {
  fail('generate() must use WebLLM JSON-constrained decoding (response_format)');
}
if (/^\s*import[^;]*['"]@mlc-ai\/web-llm['"]/m.test(webllmSource)) {
  fail('@mlc-ai/web-llm must not be statically imported');
}
if (!/await import\(['"]\.\/webllm-package['"]\)/.test(webllmSource)) {
  fail('webllm-package must be imported dynamically');
}
if (/^\s*import[^;]*['"]\.\/webllm-package['"]/m.test(webllmSource)) {
  fail('webllm-package must not be statically imported');
}
const packageSource = readFileSync(join(root, 'src/lib/webllm-package.ts'), 'utf8');
if (!packageSource.includes('ontographia-webllm-package-v1')) {
  fail('webllm-package must expose the build tag used by the smoke test');
}

const { prebuiltAppConfig } = await import('@mlc-ai/web-llm');
const modelRecord = prebuiltAppConfig.model_list.find(
  (record) => record.model_id === webllm.INTENT_MODEL_ID,
);
if (!modelRecord) fail(`WebLLM prebuiltAppConfig is missing ${webllm.INTENT_MODEL_ID}`);
if (modelRecord.vram_required_MB !== webllm.INTENT_MODEL_VRAM_MB) {
  fail(`prebuiltAppConfig VRAM ${modelRecord.vram_required_MB} != UI VRAM ${webllm.INTENT_MODEL_VRAM_MB}`);
}
const modelHost = new URL(modelRecord.model).hostname;
const modelLibHost = new URL(modelRecord.model_lib).hostname;
if (modelHost !== 'huggingface.co') fail(`unexpected model host ${modelHost}`);
if (modelLibHost !== 'raw.githubusercontent.com') fail(`unexpected model_lib host ${modelLibHost}`);

section('FarmBot artifacts');
const farmbotSeedGuard = await import('../src/farmbot/seed-digest.mjs');
const committedSeedPath = join(root, 'farmbot/dist/farmbot.seed.json');
const committedSeedBytes = readFileSync(committedSeedPath);
const farmbotSeedHex = sha256(committedSeedBytes);
if (farmbotSeedHex !== farmbotSeedGuard.SEED_SHA256_HEX) {
  fail(
    `the digest guard in src/farmbot/seed-digest.mjs must be the committed seed SHA-256: ${farmbotSeedHex} vs ${farmbotSeedGuard.SEED_SHA256_HEX}`,
  );
}
const committedSeedSidecar = readFileSync(`${committedSeedPath}.sha256`, 'utf8').trim();
if (committedSeedSidecar !== farmbotSeedGuard.SEED_DIGEST) {
  fail(`committed seed sidecar is stale: ${committedSeedSidecar}`);
}
if (!committedSeedSidecar.endsWith(`sha256:${farmbotSeedHex}`)) {
  fail('committed seed sidecar does not describe the committed seed bytes');
}

const farmbotI18n = await loadTsModule('src/farmbot/i18n.ts');
const farmbotEnKeys = Object.keys(farmbotI18n.messages.en);
const farmbotJaKeys = Object.keys(farmbotI18n.messages.ja);
if (farmbotEnKeys.join('|') !== farmbotJaKeys.join('|')) {
  fail('FarmBot ja/en i18n key sets or order differ');
}
if (farmbotEnKeys.length === 0) fail('FarmBot i18n has no messages');
for (const [lang, block] of Object.entries(farmbotI18n.messages)) {
  for (const [key, value] of Object.entries(block)) {
    if (typeof value !== 'string' || !value.trim()) fail(`empty FarmBot i18n string ${lang}.${key}`);
  }
}
for (const key of ['q1Label', 'q2Label', 'q3Label', 'q4Label', 'q5Label', 'distinctNote', 'quantityNote']) {
  if (!farmbotI18n.messages.en[key] || !farmbotI18n.messages.ja[key]) {
    fail(`missing FarmBot ja/en message ${key}`);
  }
}

section('production build');
sh('npx', ['vite', 'build']);
if (!existsSync(join(root, 'dist/index.html'))) fail('dist/index.html missing after build');
if (!existsSync(join(root, 'dist/farmbot/index.html'))) fail('dist/farmbot/index.html missing after build');

const distAssets = join(root, 'dist/assets');
const distWasmFiles = existsSync(distAssets)
  ? readdirSync(distAssets)
      .filter((file) => file.endsWith('.wasm'))
      .sort()
  : [];
const wasmShaByFile = new Map(
  distWasmFiles.map((file) => [file, sha256(readFileSync(join(distAssets, file)))]),
);
const ontographiaDistFiles = distWasmFiles.filter(
  (file) => wasmShaByFile.get(file) === wasmSha256,
);
const relateDistFiles = distWasmFiles.filter((file) => wasmShaByFile.get(file) === relateWasmSha256);
if (ontographiaDistFiles.length !== 1) {
  fail(`expected exactly 1 built Ontographia .wasm asset, got ${ontographiaDistFiles.length}`);
}
if (relateDistFiles.length !== 1) {
  fail(`expected exactly 1 built Relate .wasm asset, got ${relateDistFiles.length}`);
}
for (const file of distWasmFiles) {
  const digest = wasmShaByFile.get(file);
  if (digest !== wasmSha256 && digest !== relateWasmSha256) {
    fail(`unexpected .wasm asset in dist/assets: ${file} (${digest})`);
  }
}
const distWasmAsset = ontographiaDistFiles[0];
const relateDistAsset = relateDistFiles[0];
const distWasmBytes = readFileSync(join(distAssets, distWasmAsset));
const distWasmSha256 = wasmShaByFile.get(distWasmAsset);
if (distWasmBytes.length !== wasmBytes.length) {
  fail(`package vs dist WASM byte size differs: ${wasmBytes.length} vs ${distWasmBytes.length}`);
}
if (distWasmSha256 !== wasmSha256) {
  fail(`package vs dist WASM SHA-256 differs: ${wasmSha256} vs ${distWasmSha256}`);
}
const relateDistBytes = readFileSync(join(distAssets, relateDistAsset));
if (relateDistBytes.length !== relateWasmBytes.length) {
  fail(
    `package vs dist Relate WASM byte size differs: ${relateWasmBytes.length} vs ${relateDistBytes.length}`,
  );
}

const distJsFiles = readdirSync(distAssets).filter((file) => file.endsWith('.js')).sort();
const distCssFiles = readdirSync(distAssets).filter((file) => file.endsWith('.css')).sort();
const indexHtml = readFileSync(join(root, 'dist/index.html'), 'utf8');
const mainJsMatch = indexHtml.match(/assets\/(index-[0-9A-Za-z_-]+\.js)/);
if (!mainJsMatch) fail('cannot find the main JS chunk in dist/index.html');
const mainJs = mainJsMatch[1];
const lazyChunk = distJsFiles.find(
  (file) =>
    file !== mainJs &&
    readFileSync(join(distAssets, file), 'utf8').includes('ontographia-webllm-package-v1'),
);
if (!lazyChunk) fail('no lazy WebLLM chunk found in dist');
if (readFileSync(join(distAssets, mainJs), 'utf8').includes('ontographia-webllm-package-v1')) {
  fail('the WebLLM package tag leaked into the main chunk; the model must be lazy');
}
const gzipInfo = (file) => {
  const bytes = readFileSync(join(distAssets, file));
  return { file, bytes: bytes.length, gzip: gzipSync(bytes).length };
};
const bundle = {
  main: gzipInfo(mainJs),
  js: distJsFiles.map(gzipInfo).sort((left, right) => right.bytes - left.bytes),
  css: distCssFiles.map(gzipInfo),
  wasm: gzipInfo(distWasmAsset),
  relateWasm: gzipInfo(relateDistAsset),
  lazyWebllmChunk: lazyChunk,
};

section('FarmBot entry');
const farmbotHtml = readFileSync(join(root, 'dist/farmbot/index.html'), 'utf8');
const htmlChunkRefs = (html) =>
  [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map((match) => basename(match[1]));
const farmbotFirstPaintChunks = htmlChunkRefs(farmbotHtml);
if (farmbotFirstPaintChunks.length === 0) {
  fail('dist/farmbot/index.html references no JS chunk');
}
// The entry's own chunks and preloads must not carry the Relate glue or its
// WASM URL; the engine may only arrive through the dynamic import on a Run.
const RELATE_MARKERS = ['relate_bg', 'relatedb_execute'];
for (const chunk of farmbotFirstPaintChunks) {
  const text = readFileSync(join(distAssets, chunk), 'utf8');
  for (const marker of RELATE_MARKERS) {
    if (text.includes(marker)) {
      fail(`dist/farmbot/index.html references ${chunk}, which contains ${marker}; Relate must load lazily`);
    }
  }
}
const relateLazyChunk = distJsFiles.find((file) =>
  readFileSync(join(distAssets, file), 'utf8').includes('relate_bg'),
);
if (!relateLazyChunk) fail('no lazy Relate chunk found in dist');
if (farmbotFirstPaintChunks.includes(relateLazyChunk)) {
  fail('the lazy Relate chunk is referenced by dist/farmbot/index.html; it must load only on demand');
}

const servedSeedPath = join(root, 'dist/farmbot/farmbot.seed.json');
if (!existsSync(servedSeedPath)) fail('dist/farmbot/farmbot.seed.json missing after build');
const servedSeedBytes = readFileSync(servedSeedPath);
if (!servedSeedBytes.equals(committedSeedBytes)) {
  fail('the served FarmBot seed is not byte-identical to farmbot/dist/farmbot.seed.json');
}
if (sha256(servedSeedBytes) !== farmbotSeedHex) {
  fail(`served FarmBot seed SHA-256 differs from the committed digest: ${sha256(servedSeedBytes)}`);
}

section('headers');
const publicHeaders = readFileSync(join(root, 'public/_headers'), 'utf8');
const distHeadersPath = join(root, 'dist/_headers');
if (!existsSync(distHeadersPath)) fail('dist/_headers missing after build');
if (readFileSync(distHeadersPath, 'utf8') !== publicHeaders) fail('dist/_headers differs from public/_headers');
const headerBlocks = publicHeaders
  .split(/\n\s*\n/)
  .map((block) => block.trim())
  .filter(Boolean);
const blockFor = (pattern) => headerBlocks.find((block) => block.split('\n')[0].trim() === pattern);
const globalBlock = blockFor('/*');
if (!globalBlock) fail('_headers missing /* CSP block');
if (!/wasm-unsafe-eval/.test(globalBlock)) fail('_headers CSP missing wasm-unsafe-eval');
if (!/default-src 'none'/.test(globalBlock)) fail('_headers CSP must default to none');
if (!/connect-src 'self'/.test(globalBlock)) fail('_headers CSP must allow same-origin connect-src');

const cspLine = globalBlock
  .split('\n')
  .map((line) => line.trim())
  .find((line) => /^Content-Security-Policy:/i.test(line));
if (!cspLine) fail('_headers /* block is missing Content-Security-Policy');
const csp = cspLine.replace(/^Content-Security-Policy:\s*/i, '');
const directives = new Map();
for (const part of csp.split(';')) {
  const tokens = part.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) continue;
  directives.set(tokens[0], tokens.slice(1));
}
const expectDirective = (name, expected) => {
  const actual = directives.get(name);
  if (!actual) fail(`CSP is missing ${name}`);
  if (
    actual.length !== expected.length ||
    actual.some((token, index) => token !== expected[index])
  ) {
    fail(`CSP ${name} must be exactly "${expected.join(' ')}", got "${actual.join(' ')}"`);
  }
};
expectDirective('default-src', ["'none'"]);
expectDirective('script-src', ["'self'", "'wasm-unsafe-eval'"]);
expectDirective('connect-src', [
  "'self'",
  `https://${modelHost}`,
  'https://us.aws.cdn.hf.co',
  `https://${modelLibHost}`,
]);
expectDirective('worker-src', ["'self'", 'blob:']);
expectDirective('style-src', ["'self'"]);
expectDirective('img-src', ["'self'"]);
expectDirective('font-src', ["'self'"]);
expectDirective('object-src', ["'none'"]);
expectDirective('base-uri', ["'none'"]);
expectDirective('frame-ancestors', ["'none'"]);
expectDirective('form-action', ["'none'"]);
if (csp.includes('*')) fail('CSP must not contain wildcards');
if ((directives.get('script-src') ?? []).some((token) => token.startsWith('http'))) {
  fail('script-src must not load a CDN; bundle the npm package');
}
const wasmBlock = blockFor('/assets/*.wasm');
if (!wasmBlock) fail('_headers missing /assets/*.wasm rule');
if (!/^\s*Content-Type:\s*application\/wasm\s*$/im.test(wasmBlock)) {
  fail('_headers /assets/*.wasm rule must set Content-Type: application/wasm');
}
const assetsBlock = blockFor('/assets/*');
if (!assetsBlock) fail('_headers missing /assets/* rule');
if (!/^\s*Cache-Control:.*immutable/im.test(assetsBlock)) {
  fail('_headers /assets/* rule must set an immutable Cache-Control');
}
if (!/max-age=31536000/.test(assetsBlock)) fail('_headers immutable Cache-Control should use max-age=31536000');

console.log(
  JSON.stringify(
    {
      ok: true,
      node: process.version,
      package: `${pkg.name}@${pkg.version}`,
      abiVersion: og.abiVersion,
      intents: intentFiles.length,
      chips: chipList.length,
      graph: {
        nodes: fixture.nodes.length,
        edges: fixture.edges.length,
        lanes: [...new Set(fixture.nodes.map((node) => node.properties.lane))],
        mbomNodes: fixture.nodes.filter((node) => node.properties.lane === 'mbom').length,
      },
      i18n: { enKeys: enKeys.length, jaKeys: jaKeys.length },
      gold: Object.fromEntries(
        [...goldResults].map(([file, result]) => [
          file,
          {
            rows: result.rows.length,
            pathNodes: [...result.pathNodeIds].sort(),
            pathEdges: result.pathEdgeKeys.length,
            cypher: compiled.get(file).query.split('\n')[0],
          },
        ]),
      ),
      emptyResult: { rows: empty.rows.length, pathNodes: empty.pathNodeIds.length },
      malformed: { wasmRejected: malformedRejected, executorRejected: executorMalformedRejected },
      wasm: {
        packageBytes: wasmBytes.length,
        packageSha256: wasmSha256,
        distAsset: distWasmAsset,
        distBytes: distWasmBytes.length,
        distSha256: distWasmSha256,
        match: true,
        relate: {
          package: `${relatePkg.name}@${relatePkg.version}`,
          packageBytes: relateWasmBytes.length,
          packageSha256: relateWasmSha256,
          distAsset: relateDistAsset,
          distBytes: relateDistBytes.length,
          match: true,
        },
      },
      farmbot: {
        html: 'dist/farmbot/index.html',
        firstPaintChunks: farmbotFirstPaintChunks,
        lazyRelateChunk: relateLazyChunk,
        i18n: { enKeys: farmbotEnKeys.length, jaKeys: farmbotJaKeys.length },
        seed: {
          servedPath: 'dist/farmbot/farmbot.seed.json',
          bytes: servedSeedBytes.length,
          sha256: farmbotSeedHex,
          byteIdentical: true,
        },
      },
      headers: {
        publicRules: headerBlocks.length,
        distCopied: true,
        wasmMime: 'application/wasm',
        scriptSrc: directives.get('script-src'),
        connectSrc: directives.get('connect-src'),
        workerSrc: directives.get('worker-src'),
      },
      bundle,
      freeText: {
        model: webllm.INTENT_MODEL_ID,
        vramMB: webllm.INTENT_MODEL_VRAM_MB,
        documentedDownloadBytes: webllm.INTENT_MODEL_DOWNLOAD_BYTES,
        templates: webllm.INTENT_ROUTE_TEMPLATES.length,
        jsonConstrained: true,
        schema: {
          goldPassed: goldForSchema.length,
          rejected: schemaRejects.map(([label]) => label),
        },
        promptSet: {
          prompts: intentPromptSet.length,
          perIntent: Object.fromEntries(
            [...promptsByFile].map(([file, prompts]) => [
              file,
              {
                ja: prompts.filter((prompt) => prompt.lang === 'ja').length,
                en: prompts.filter((prompt) => prompt.lang === 'en').length,
              },
            ]),
          ),
        },
        lazyChunk,
        prebuiltModelHost: modelHost,
        prebuiltModelLibHost: modelLibHost,
      },
    },
    null,
    2,
  ),
);
console.log('verify OK');
