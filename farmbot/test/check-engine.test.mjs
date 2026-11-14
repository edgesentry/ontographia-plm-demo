import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { DuckDBInstance } from '@duckdb/node-api';
import { loadOntographia } from '@edgesentry/ontographia-wasm';
import initRelate, { RelateDb } from '@relate/relate-wasm';

import { canonicalize, canonicalJson } from '../../src/farmbot/agent/canonical.mjs';
import { CHECKS, INTENT_FILES } from '../../src/farmbot/agent/checks.mjs';
import { compileCheck } from '../../src/farmbot/agent/compile.mjs';
import { collectFindings } from '../../src/farmbot/agent/index.mjs';
import { parseRelationshipEndpoints } from '../../src/farmbot/ontology-relationships.mjs';
import { buildSeedStatements, loadSeed } from '../../src/farmbot/seed-load.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const EXTRACT_SCRIPT = resolve(ROOT, 'farmbot/scripts/extract.mjs');
const AGENT_SCRIPT = resolve(ROOT, 'farmbot/scripts/agent-farmbot.mjs');
const CHECKS_DIR = resolve(ROOT, 'farmbot/checks');
const ORACLE_DIR = resolve(ROOT, 'farmbot/oracle');
const ONTOLOGY_PATH = resolve(ROOT, 'farmbot/ontology/farmbot.native.yaml');
const SEED_PATH = resolve(ROOT, 'farmbot/dist/farmbot.seed.json');
const SEED_DIGEST_PATH = `${SEED_PATH}.sha256`;
const FINDINGS_PATH = resolve(ROOT, 'farmbot/dist/farmbot.findings.json');
const FINDINGS_DIGEST_PATH = `${FINDINGS_PATH}.sha256`;
const GOLD_PATH = resolve(CHECKS_DIR, 'compiled.gold.json');
const ONTOGRAPHIA_WASM = resolve(
  ROOT,
  'node_modules/@edgesentry/ontographia-wasm/ontographia_wasm.wasm',
);
const RELATE_WASM = resolve(ROOT, 'node_modules/@relate/relate-wasm/relate_bg.wasm');

const FINDINGS_FORMAT = 'farmbot-findings-v1';
const SEED_FORMAT = 'farmbot-graph-v1';

const temporaryDirectories = [];

function tempDir(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function runWire(db, query, params) {
  return JSON.parse(db.execute(query, params === null ? null : JSON.stringify(params)));
}

function toJs(value) {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(toJs);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJs(entry)]),
    );
  }
  return value;
}

function sortedText(values) {
  return values.map((value) => JSON.stringify(canonicalize(value))).sort();
}

function evidenceOf(finding, role) {
  return finding.evidence.filter((row) => row.role === role);
}

// Build the extract once in a private directory. Other test files rebuild or
// reopen the shared DuckDB file, and the runner runs files in parallel.
const PRIVATE_DIRECTORY = tempDir('farmbot-check-engine-');
const built = spawnSync(process.execPath, [EXTRACT_SCRIPT, '--out', PRIVATE_DIRECTORY], {
  cwd: ROOT,
  encoding: 'utf8',
});
assert.equal(
  built.status,
  0,
  `extract failed:\n${built.stderr}\n${built.stdout}`,
);
const extractPath = join(PRIVATE_DIRECTORY, 'farmbot.duckdb');

const ontologyText = readFileSync(ONTOLOGY_PATH, 'utf8');
const seedBytes = readFileSync(SEED_PATH);
const seed = JSON.parse(seedBytes.toString('utf8'));
const seedDigest = readFileSync(SEED_DIGEST_PATH, 'utf8').trim();
const checks = Object.fromEntries(
  INTENT_FILES.map((file) => [
    file,
    JSON.parse(readFileSync(join(CHECKS_DIR, file), 'utf8')),
  ]),
);

const engine = await loadOntographia(readFileSync(ONTOGRAPHIA_WASM));
await initRelate({ module_or_path: readFileSync(RELATE_WASM) });
const db = new RelateDb();
loadSeed(db, buildSeedStatements(seed, parseRelationshipEndpoints(ontologyText)));

const extractInstance = await DuckDBInstance.create(extractPath, {
  access_mode: 'READ_ONLY',
});
const extractConnection = await extractInstance.connect();

const sources = new Map();
for (const row of (await extractConnection.runAndReadAll('SELECT name, path FROM part'))
  .getRowObjectsJS()) {
  if (typeof row.path === 'string' && row.path.length > 0) {
    sources.set(`part:${row.name}`, row.path);
  }
}

after(() => {
  extractConnection.closeSync();
  extractInstance.closeSync();
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const findings = collectFindings({
  engine,
  ontology: ontologyText,
  checks,
  seed: { bytes: seedBytes.length, digest: seedDigest },
  sources,
  execute(query, params) {
    const envelope = runWire(db, query, params);
    if (envelope.error) throw new Error(envelope.error);
    return envelope.rows ?? [];
  },
});

const findingsByRule = (rule) => findings.findings.filter((finding) => finding.rule === rule);

async function oracleRows(file) {
  const reader = await extractConnection.runAndReadAll(
    readFileSync(join(ORACLE_DIR, file), 'utf8'),
  );
  return toJs(reader.getRowObjectsJS());
}

test('the check engine reproduces the measured rule counts', () => {
  assert.deepEqual(
    findings.rules.map((rule) => [rule.id, rule.findingCount]),
    [
      ['R1', 12],
      ['R2', 13],
      ['R3', 44],
      ['R4', 11],
      ['R5', 6],
    ],
  );
  const referenceLines = findingsByRule('R2').flatMap((finding) =>
    evidenceOf(finding, 'reference'),
  );
  assert.equal(referenceLines.length, 19);
  assert.equal(new Set(findingsByRule('R2').map((finding) => finding.subject.key)).size, 13);

  for (const rule of ['R3', 'R4']) {
    for (const finding of findingsByRule(rule)) {
      assert.equal(finding.severity, 'info', `${finding.id} must be info`);
      assert.ok(
        finding.causes.some((cause) => cause.rule === 'R5'),
        `${finding.id} must list R5 as a cause candidate`,
      );
    }
  }
});

test('every finding id is unique, URL-safe ASCII and sorted', () => {
  const ids = findings.findings.map((finding) => finding.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id, /^[A-Za-z0-9-]+$/, `${id} is not URL-safe ASCII`);
  }
  assert.deepEqual(ids, [...ids].sort());
});

test('every evidence row resolves to a committed seed node', () => {
  const nodeIds = new Set(seed.nodes.map((node) => node.id));
  for (const finding of findings.findings) {
    assert.ok(finding.evidence.length > 0, `${finding.id} has no evidence`);
    for (const row of finding.evidence) {
      assert.ok(nodeIds.has(row.nodeId), `${finding.id}: ${row.nodeId} is not in the seed`);
      assert.ok(
        row.sourceFile === null || typeof row.sourceFile === 'string',
        `${finding.id}: source file must be a string or null`,
      );
      assert.equal(
        typeof row.sourceFile,
        'string',
        `${finding.id}: the Node entry must supply a source file for every evidence row`,
      );
      assert.ok(
        row.line === null || Number.isInteger(row.line),
        `${finding.id}: line must be an integer or null`,
      );
    }
  }
});

test('R1 findings equal the SQL oracle', async () => {
  const oracle = await oracleRows('r1-packing-quantity.sql');
  const actual = findingsByRule('R1').map((finding) => {
    const difference = evidenceOf(finding, 'quantity-difference')[0];
    const part = evidenceOf(finding, 'part')[0];
    return {
      part: part.facts.name,
      packing_page: difference.sourceFile,
      packing_quantity: difference.facts.packingQuantity,
      packing_minus_part: difference.facts.quantityDifference,
      part_quantity: difference.facts.partQuantity,
      version: difference.facts.version,
    };
  });
  assert.deepEqual(
    sortedText(actual),
    sortedText(oracle),
    'R1 findings differ from r1-packing-quantity.sql',
  );
});

test('R2 findings equal the SQL oracle line for line', async () => {
  const oracle = (await oracleRows('r2-unresolved-references.sql')).map((row) => ({
    line: row.line,
    name: row.name,
    source_file: row.source_file,
  }));
  const actual = findingsByRule('R2').flatMap((finding) =>
    evidenceOf(finding, 'reference').map((row) => ({
      line: row.line,
      name: row.facts.displayName,
      source_file: row.sourceFile,
    })),
  );
  assert.deepEqual(
    sortedText(actual),
    sortedText(oracle),
    'R2 findings differ from r2-unresolved-references.sql',
  );
});

test('R3 findings equal the SQL oracle', async () => {
  const oracle = await oracleRows('r3-unreferenced-parts.sql');
  assert.deepEqual(
    findingsByRule('R3').map((finding) => finding.subject.key).sort(),
    oracle.map((row) => row.part).sort(),
    'R3 findings differ from r3-unreferenced-parts.sql',
  );
});

test('R4 findings equal the SQL oracle', async () => {
  const oracle = await oracleRows('r4-packed-unreferenced-parts.sql');
  assert.deepEqual(
    findingsByRule('R4').map((finding) => finding.subject.key).sort(),
    oracle.map((row) => row.part).sort(),
    'R4 findings differ from r4-packed-unreferenced-parts.sql',
  );
});

test('R5 findings equal the SQL oracle', async () => {
  const oracle = await oracleRows('r5-unreadable-preassemblies.sql');
  assert.deepEqual(
    findingsByRule('R5').map((finding) => finding.subject.key).sort(),
    oracle.map((row) => row.path).sort(),
    'R5 findings differ from r5-unreadable-preassemblies.sql',
  );
});

test('every check Intent compiles to the pinned Cypher and params', () => {
  const gold = JSON.parse(readFileSync(GOLD_PATH, 'utf8'));
  assert.equal(gold.format, 'farmbot-check-compiled-v1');
  assert.deepEqual(
    gold.intents.map((entry) => entry.file),
    INTENT_FILES,
    'gold intents must be sorted by file',
  );
  for (const [index, file] of INTENT_FILES.entries()) {
    const compiled = compileCheck(engine, ontologyText, checks[file]);
    const pinned = gold.intents[index];
    assert.equal(pinned.query, compiled.query, `${file}: Cypher drifted`);
    assert.deepEqual(pinned.params, compiled.params, `${file}: params drifted`);
    assert.equal(
      compiled.query.includes('DISTINCT'),
      false,
      `${file}: no post-compile rewrites are allowed`,
    );
    const filters = checks[file].filter ?? [];
    assert.equal(Object.keys(compiled.params).length, filters.length);
    for (const filter of filters) {
      assert.equal(
        compiled.query.includes(String(filter.value)),
        false,
        `${file}: filter value ${filter.value} leaked into Cypher text`,
      );
    }
  }
});

test('two agent runs are byte-identical and match the committed findings', () => {
  const first = tempDir('farmbot-findings-a-');
  const second = tempDir('farmbot-findings-b-');
  for (const out of [first, second]) {
    mkdirSync(out, { recursive: true });
    const run = spawnSync(
      process.execPath,
      [AGENT_SCRIPT, '--extract', extractPath, '--out', out],
      { cwd: ROOT, encoding: 'utf8' },
    );
    assert.equal(run.status, 0, `agent failed:\n${run.stderr}\n${run.stdout}`);
  }
  const firstBytes = readFileSync(join(first, 'farmbot.findings.json'));
  const secondBytes = readFileSync(join(second, 'farmbot.findings.json'));
  assert.ok(firstBytes.equals(secondBytes), 'two runs produced different bytes');
  const committed = readFileSync(FINDINGS_PATH);
  assert.ok(
    committed.equals(firstBytes),
    'the committed findings are stale; run `npm run agent:farmbot`',
  );

  const digest = createHash('sha256').update(committed).digest('hex');
  assert.equal(
    readFileSync(FINDINGS_DIGEST_PATH, 'utf8'),
    `${FINDINGS_FORMAT} sha256:${digest}\n`,
  );
  const document = JSON.parse(committed.toString('utf8'));
  assert.equal(document.format, FINDINGS_FORMAT);
  assert.equal(document.seed.digest, seedDigest);
  assert.equal(document.seed.bytes, seedBytes.length);
  assert.equal(document.seed.digest.startsWith(`${SEED_FORMAT} `), true);
  assert.equal(committed.toString('utf8'), canonicalJson(document));
});

test('the check Intent files are the only inputs to the recorded queries', () => {
  for (const rule of CHECKS) {
    for (const file of rule.intents) {
      const matching = findings.findings
        .filter((finding) => finding.rule === rule.id)
        .flatMap((finding) => finding.queries)
        .filter((query) => query.intent === `farmbot/checks/${file}`);
      assert.ok(matching.length > 0, `${rule.id} does not record ${file}`);
      const compiled = compileCheck(engine, ontologyText, checks[file]);
      for (const query of matching) {
        assert.equal(query.cypher, compiled.query);
        assert.deepEqual(query.params, compiled.params);
      }
    }
  }
});
