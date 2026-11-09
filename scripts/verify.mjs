import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const fail = (m) => {
  console.error('verify FAILED:', m);
  process.exit(1);
};
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });

sh('npx', ['tsc', '--noEmit']);

const data = join(root, 'vendor/ontographia/data');
for (const f of ['plm.native.yaml', 'chips.json', 'fixtures/deskfan_eol.graph.json']) {
  if (!existsSync(join(data, f))) fail(`missing data file ${f}`);
}
const intents = readdirSync(join(data, 'intents')).filter((f) => f.endsWith('.json'));
if (intents.length !== 5) fail(`expected 5 intents, got ${intents.length}`);
for (const f of intents) JSON.parse(readFileSync(join(data, 'intents', f), 'utf8'));
const chips = JSON.parse(readFileSync(join(data, 'chips.json'), 'utf8'));
const chipList = Array.isArray(chips) ? chips : chips.chips;
if (!Array.isArray(chipList) || chipList.length !== 5) fail('chips.json must list 5 chips');
for (const c of chipList) {
  for (const k of ['label_ja', 'label_en', 'description_ja', 'description_en']) {
    if (!c[k] || !String(c[k]).trim()) fail(`chip ${c.chip_id || '?'} missing ${k}`);
  }
}
for (const f of ['chips.json', 'fixtures/deskfan_eol.graph.json']) {
  if (/pfas/i.test(readFileSync(join(data, f), 'utf8'))) fail(`PFAS content in ${f}`);
}

const i18nSrc = readFileSync(join(root, 'src/i18n.ts'), 'utf8');
const block = (lang) => {
  const m = i18nSrc.match(new RegExp(`\\n  ${lang}: \\{([\\s\\S]*?)\\n  \\},`));
  if (!m) fail(`i18n block ${lang} not found`);
  return [...m[1].matchAll(/^\s{4}(\w+):\s*(?:\n\s*)?'([^']*)'/gm)].map((x) => [x[1], x[2]]);
};
const en = block('en');
const ja = block('ja');
if (en.map((x) => x[0]).join() !== ja.map((x) => x[0]).join()) fail('ja/en i18n keys differ');
if ([...en, ...ja].some(([, v]) => !v.trim())) fail('empty i18n string');

const wasmPath = join(root, 'public/assets/ontographia/ontographia_wasm.wasm');
if (!existsSync(wasmPath)) fail('WASM missing; run `npm run prepare:wasm` first');
const binding = await import(pathToFileURL(join(root, 'vendor/ontographia/binding/ontographia-wasm.js')).href);
const og = await binding.loadOntographia(readFileSync(wasmPath));
if (og.abiVersion !== 1) fail(`abiVersion ${og.abiVersion} !== 1`);
const ontology = readFileSync(join(data, 'plm.native.yaml'));
for (const f of intents) {
  const intent = JSON.parse(readFileSync(join(data, 'intents', f), 'utf8'));
  const res = og.buildCypher(ontology, intent, { dialect: 'cypher25', ontologyPathHint: 'plm.native.yaml' });
  if (!res.query || typeof res.query !== 'string') fail(`smoke: empty query for ${f}`);
  if (!res.params || typeof res.params !== 'object') fail(`smoke: bad params for ${f}`);
}
try {
  og.buildCypher(ontology, { not: 'an-intent' }, { dialect: 'cypher25', ontologyPathHint: 'plm.native.yaml' });
  fail('smoke: malformed intent should reject');
} catch {
  // expected
}

const headers = readFileSync(join(root, 'public/_headers'), 'utf8');
if (!headers.includes("wasm-unsafe-eval")) fail('_headers missing wasm-unsafe-eval');
if (!headers.includes("Content-Security-Policy")) fail('_headers missing CSP');

sh('npx', ['vite', 'build']);
if (!existsSync(join(root, 'dist/index.html'))) fail('dist/index.html missing after build');
console.log('verify OK');
