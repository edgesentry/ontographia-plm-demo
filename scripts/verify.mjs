import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

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

// Engine comes from the published npm package; no git pin, cargo, or prepare step.
const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve('@edgesentry/ontographia-wasm/package.json'));
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
if (pkg.version !== '0.1.9') fail(`expected @edgesentry/ontographia-wasm 0.1.9, got ${pkg.version}`);
const wasmPath = join(pkgDir, 'ontographia_wasm.wasm');
if (!existsSync(wasmPath)) fail(`WASM missing from package at ${wasmPath}`);
const wasmBytes = readFileSync(wasmPath);
const binding = await import('@edgesentry/ontographia-wasm');
const og = await binding.loadOntographia(wasmBytes);
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
const distAssets = join(root, 'dist/assets');
const distWasm = existsSync(distAssets)
  ? readdirSync(distAssets).filter((f) => f.endsWith('.wasm'))
  : [];
if (distWasm.length !== 1) fail(`expected 1 built .wasm asset, got ${distWasm.length}`);

console.log(
  JSON.stringify(
    {
      ok: true,
      package: `${pkg.name}@${pkg.version}`,
      abiVersion: og.abiVersion,
      intents: intents.length,
      wasm: {
        sourceBytes: wasmBytes.length,
        sourceSha256: createHash('sha256').update(wasmBytes).digest('hex'),
        distAsset: distWasm[0],
        distBytes: readFileSync(join(distAssets, distWasm[0])).length,
      },
    },
    null,
    2,
  ),
);
console.log('verify OK');
