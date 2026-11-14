#!/usr/bin/env node
// Build farmbot/dist/farmbot.findings.json from the committed seed.
//
//   node farmbot/scripts/agent-farmbot.mjs
//   node farmbot/scripts/agent-farmbot.mjs --extract <farmbot.duckdb> --out <dir>
//   node farmbot/scripts/agent-farmbot.mjs --write-compiled-gold
//
// The script supplies what the browser will supply later: the ontology text,
// the check Intent JSON, a Relate session loaded from the committed seed, and
// the part page paths read from the DuckDB extract. The rule evaluation itself
// lives in src/farmbot/agent/ and has no Node-only import.
//
// The extract is only needed for part page paths. In CI, a test builds a
// private extract and passes its path; the committed graph, the checks and the
// findings document never depend on the extract's location.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DuckDBInstance } from '@duckdb/node-api';
import { loadOntographia } from '@edgesentry/ontographia-wasm';
import initRelate, { RelateDb } from '@relate/relate-wasm';

import { canonicalJson } from '../../src/farmbot/agent/canonical.mjs';
import {
  CHECKS,
  INTENT_FILES,
} from '../../src/farmbot/agent/checks.mjs';
import { compileCheck } from '../../src/farmbot/agent/compile.mjs';
import { collectFindings } from '../../src/farmbot/agent/index.mjs';
import { parseRelationshipEndpoints } from '../../src/farmbot/ontology-relationships.mjs';
import { buildSeedStatements, loadSeed } from '../../src/farmbot/seed-load.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CHECKS_DIR = join(ROOT, 'farmbot/checks');
const ONTOLOGY_PATH = join(ROOT, 'farmbot/ontology/farmbot.native.yaml');
const SEED_PATH = join(ROOT, 'farmbot/dist/farmbot.seed.json');
const SEED_DIGEST_PATH = `${SEED_PATH}.sha256`;
const DEFAULT_EXTRACT = join(ROOT, 'farmbot/dist/farmbot.duckdb');
const DEFAULT_OUT = join(ROOT, 'farmbot/dist');
const FINDINGS_NAME = 'farmbot.findings.json';
const FINDINGS_FORMAT = 'farmbot-findings-v1';
const GOLD_PATH = join(CHECKS_DIR, 'compiled.gold.json');
const ONTOGRAPHIA_WASM = join(
  ROOT,
  'node_modules/@edgesentry/ontographia-wasm/ontographia_wasm.wasm',
);
const RELATE_WASM = join(ROOT, 'node_modules/@relate/relate-wasm/relate_bg.wasm');

/**
 * @param {string[]} argv
 * @returns {Map<string, string | true>}
 */
function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`unexpected argument ${argument}`);
    const name = argument.slice(2);
    if (name === 'write-compiled-gold') {
      options.set(name, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`--${name} needs a value`);
    }
    options.set(name, value);
    index += 1;
  }
  return options;
}

/** @param {string} directory */
function readChecks(directory) {
  /** @type {Record<string, object>} */
  const checks = {};
  for (const file of INTENT_FILES) {
    checks[file] = JSON.parse(readFileSync(join(directory, file), 'utf8'));
  }
  return checks;
}

/**
 * @param {import('@edgesentry/ontographia-wasm').OntographiaWasm} engine
 * @param {string} ontologyText
 * @param {Record<string, object>} checks
 */
function writeCompiledGold(engine, ontologyText, checks) {
  const intents = INTENT_FILES.map((file) => {
    const compiled = compileCheck(engine, ontologyText, checks[file]);
    return { file, params: compiled.params, query: compiled.query };
  });
  writeFileSync(
    GOLD_PATH,
    canonicalJson({ format: 'farmbot-check-compiled-v1', intents }),
  );
  console.log(`wrote ${GOLD_PATH}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const ontologyText = readFileSync(ONTOLOGY_PATH, 'utf8');
  const checks = readChecks(CHECKS_DIR);
  const engine = await loadOntographia(readFileSync(ONTOGRAPHIA_WASM));

  if (options.get('write-compiled-gold') === true) {
    writeCompiledGold(engine, ontologyText, checks);
    return;
  }

  const seedPath = String(options.get('seed') ?? SEED_PATH);
  const seedBytes = readFileSync(seedPath);
  const seed = JSON.parse(seedBytes.toString('utf8'));
  const digestPath = `${seedPath}.sha256`;
  const seedDigest = readFileSync(
    existsSync(digestPath) ? digestPath : SEED_DIGEST_PATH,
    'utf8',
  ).trim();

  const extractPath = String(options.get('extract') ?? DEFAULT_EXTRACT);
  if (!existsSync(extractPath)) {
    throw new Error(
      `missing extract ${extractPath}; build it with ` +
        '`node farmbot/scripts/extract.mjs` or pass --extract',
    );
  }
  const extract = await DuckDBInstance.create(extractPath, { access_mode: 'READ_ONLY' });
  const connection = await extract.connect();
  const sources = new Map();
  try {
    const reader = await connection.runAndReadAll('SELECT name, path FROM part');
    for (const row of reader.getRowObjectsJS()) {
      if (typeof row.path === 'string' && row.path.length > 0) {
        sources.set(`part:${row.name}`, row.path);
      }
    }
  } finally {
    connection.closeSync();
    extract.closeSync();
  }

  await initRelate({ module_or_path: readFileSync(RELATE_WASM) });
  const db = new RelateDb();
  loadSeed(db, buildSeedStatements(seed, parseRelationshipEndpoints(ontologyText)));

  const seedNodeIds = new Set(seed.nodes.map((node) => node.id));
  const findings = collectFindings({
    engine,
    ontology: ontologyText,
    checks,
    seed: { bytes: seedBytes.length, digest: seedDigest },
    sources,
    execute(query, params) {
      const envelope = JSON.parse(db.execute(query, JSON.stringify(params)));
      if (envelope.error) throw new Error(envelope.error);
      return envelope.rows ?? [];
    },
  });
  for (const finding of findings.findings) {
    for (const evidence of finding.evidence) {
      if (!seedNodeIds.has(evidence.nodeId)) {
        throw new Error(
          `finding ${finding.id} cites ${evidence.nodeId}, which is not a seed node`,
        );
      }
    }
  }

  const outDir = String(options.get('out') ?? DEFAULT_OUT);
  mkdirSync(outDir, { recursive: true });
  const text = canonicalJson(findings);
  const outPath = join(outDir, FINDINGS_NAME);
  writeFileSync(outPath, text);
  const digest = createHash('sha256').update(text).digest('hex');
  writeFileSync(`${outPath}.sha256`, `${FINDINGS_FORMAT} sha256:${digest}\n`);

  for (const rule of CHECKS) {
    const summary = findings.rules.find((entry) => entry.id === rule.id);
    const levels = Object.entries(summary.severityCounts)
      .map(([level, count]) => `${level} ${count}`)
      .join(', ');
    console.log(`${rule.id}: ${summary.findingCount} findings (${levels})`);
  }
  console.log(`seed ${findings.seed.digest}`);
  console.log(`wrote ${outPath}`);
  console.log(`${FINDINGS_FORMAT} sha256:${digest}`);
}

await main();
