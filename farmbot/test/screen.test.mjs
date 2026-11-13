// Tests for the modules the /farmbot/ screen runs.
//
// These exercise the shared code paths rather than the DOM: the seed digest
// guard, the post-compile DISTINCT step, the ontology endpoint parser, the seed
// loader, and the five preset questions compiled and executed exactly as the
// screen does.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadOntographia } from '@edgesentry/ontographia-wasm';
import initRelate, { RelateDb } from '@relate/relate-wasm';
import { loadOntology } from '../scripts/graph.mjs';
import { QUESTIONS } from '../../src/farmbot/questions.mjs';
import { planQuestion } from '../../src/farmbot/plan.mjs';
import { insertDistinctReturn } from '../../src/farmbot/distinct-return.mjs';
import {
  checkSeedDigest,
  formatSeedDigest,
  parseSeedDigestLine,
  SEED_DIGEST,
  SEED_SHA256_HEX,
} from '../../src/farmbot/seed-digest.mjs';
import { buildSeedStatements, groupBy, loadSeed } from '../../src/farmbot/seed-load.mjs';
import { parseRelationshipEndpoints } from '../../src/farmbot/ontology-relationships.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const ONTOLOGY_PATH = resolve(ROOT, 'farmbot/ontology/farmbot.native.yaml');
const INTENTS_DIR = resolve(ROOT, 'farmbot/intents');
const COMMITTED_SEED = resolve(ROOT, 'farmbot/dist/farmbot.seed.json');
const COMMITTED_SEED_DIGEST = `${COMMITTED_SEED}.sha256`;
const COMMITTED_ALLOWED_VALUES = resolve(ROOT, 'farmbot/dist/farmbot.allowed-values.json');
const ONTOGRAPHIA_WASM = resolve(
  ROOT,
  'node_modules/@edgesentry/ontographia-wasm/ontographia_wasm.wasm',
);
const RELATE_WASM = resolve(ROOT, 'node_modules/@relate/relate-wasm/relate_bg.wasm');

const seedBytes = readFileSync(COMMITTED_SEED);
const seed = JSON.parse(seedBytes.toString('utf8'));
const allowedValues = JSON.parse(readFileSync(COMMITTED_ALLOWED_VALUES, 'utf8'));
const ontologyText = readFileSync(ONTOLOGY_PATH, 'utf8');
const intentByFile = new Map(
  QUESTIONS.map((question) => [
    question.intentFile,
    JSON.parse(readFileSync(join(INTENTS_DIR, question.intentFile), 'utf8')),
  ]),
);

const engine = await loadOntographia(readFileSync(ONTOGRAPHIA_WASM));
await initRelate({ module_or_path: readFileSync(RELATE_WASM) });
const db = new RelateDb();

const relationships = parseRelationshipEndpoints(ontologyText);
const statements = buildSeedStatements(seed, relationships);
loadSeed(db, statements);

function runWire(query, params) {
  return JSON.parse(db.execute(query, params === null ? null : JSON.stringify(params)));
}

test('the digest guard accepts the committed seed and rejects a changed byte', async () => {
  assert.equal(
    readFileSync(COMMITTED_SEED_DIGEST, 'utf8'),
    `${SEED_DIGEST}\n`,
    'the committed sidecar must match the digest hard-coded for the page',
  );
  assert.deepEqual(parseSeedDigestLine(`${SEED_DIGEST}\n`), {
    format: 'farmbot-graph-v1',
    hex: SEED_SHA256_HEX,
  });
  assert.equal(parseSeedDigestLine('sha256:not-a-digest'), null);

  const accepted = await checkSeedDigest(seedBytes);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.hex, SEED_SHA256_HEX);
  assert.equal(formatSeedDigest(accepted.hex), SEED_DIGEST);

  const tampered = Buffer.from(seedBytes);
  // Change one byte in the middle of the JSON, not its length.
  tampered[Math.floor(tampered.length / 2)] ^= 0x01;
  const rejected = await checkSeedDigest(tampered);
  assert.equal(rejected.ok, false);
  assert.notEqual(rejected.hex, SEED_SHA256_HEX);
});

test('the shared DISTINCT step rewrites only the single RETURN clause', () => {
  const compiled =
    'CYPHER 25\nMATCH (chapter:AssemblyChapter)-[:HAS_USAGE]->(usage:Usage)\n' +
    'FILTER usage.quantity = $param_0\n' +
    'RETURN chapter.chapter AS chapter, chapter.path AS chapter_path\nLIMIT 100';
  const executed = insertDistinctReturn(compiled);
  assert.equal(executed.includes('RETURN DISTINCT '), true);
  assert.equal(executed.replace('RETURN DISTINCT ', 'RETURN '), compiled);
  assert.equal(executed.includes('$param_0'), true);

  assert.throws(() => insertDistinctReturn('MATCH (n) RETURN n'), /exactly one RETURN clause/);
  assert.throws(
    () => insertDistinctReturn('MATCH (n)\nRETURN n\nRETURN n'),
    /exactly one RETURN clause/,
  );
});

test('the ontology range parser agrees with the full YAML parse', () => {
  const parsed = loadOntology(ONTOLOGY_PATH).relationships;
  assert.equal(relationships.size, parsed.size);
  for (const [name, declaration] of parsed) {
    assert.deepEqual(relationships.get(name), declaration, `relationship ${name}`);
  }
});

test('the shared seed loader fills in-memory Relate with the committed graph', () => {
  const nodeStatements = statements.filter((statement) => statement.kind === 'nodes');
  const edgeStatements = statements.filter((statement) => statement.kind === 'edges');
  assert.equal(nodeStatements.length, groupBy(seed.nodes, (node) => node.labels.join(':')).length);
  assert.equal(edgeStatements.length, new Set(seed.edges.map((edge) => edge.type)).size);

  const nodes = runWire('MATCH (n) RETURN count(n) AS nodes', null);
  assert.equal(nodes.error, null);
  assert.equal(nodes.rows[0].nodes, 604);
  const edges = runWire('MATCH ()-[r]->() RETURN count(r) AS edges', null);
  assert.equal(edges.error, null);
  assert.equal(edges.rows[0].edges, 1022);
});

test('every question defaults to its committed filter value inside its selector domain', () => {
  assert.deepEqual(
    QUESTIONS.map((question) => question.id),
    ['q1', 'q2', 'q3', 'q4', 'q5'],
  );
  const expectedDomains = {
    q1: null,
    q2: 'part_names_in_assembly_chapters',
    q3: 'part_names_in_all_three_structure_kinds',
    q4: 'category_slugs_in_kits',
    q5: null,
  };
  for (const question of QUESTIONS) {
    assert.equal(question.selector, expectedDomains[question.id], `${question.id} selector`);
    assert.equal(question.distinct, question.id === 'q2' || question.id === 'q3');
    const intent = intentByFile.get(question.intentFile);
    assert.ok(intent, `${question.id} has no committed Intent`);
    if (question.selector === null) {
      if (question.id === 'q1') {
        assert.equal(intent.filter, undefined);
      } else {
        assert.deepEqual(intent.filter, [
          { alias: 'name', property: 'status', op: 'eq', value: 'unmatched' },
        ]);
        assert.equal(allowedValues.unmatched_statuses.includes(intent.filter[0].value), true);
      }
      continue;
    }
    const domain = allowedValues[question.selector];
    assert.ok(Array.isArray(domain) && domain.length > 0, `${question.selector} domain`);
    assert.equal(domain.includes(intent.filter[0].value), true, `${question.id} default value`);
  }
});

test('the five preset questions return the oracle row counts through the screen path', () => {
  const expected = { q1: 12, q2: 2, q3: 7, q4: 24, q5: 17 };
  for (const question of QUESTIONS) {
    const intent = intentByFile.get(question.intentFile);
    const plan = planQuestion(engine, ontologyText, intent, question.distinct);
    assert.equal(
      plan.executed.includes('DISTINCT'),
      question.distinct,
      `${question.id}: DISTINCT only where the post-compile step applies`,
    );
    if (!question.distinct) assert.equal(plan.executed, plan.compiled);
    const result = runWire(plan.executed, plan.params);
    assert.equal(result.error, null, `${question.id}: ${result.error}`);
    assert.ok(
      result.rows.length < intent.limit,
      `${question.id} reached its Intent limit ${intent.limit}`,
    );
    assert.equal(result.rows.length, expected[question.id], `${question.id} rows`);
  }
});
