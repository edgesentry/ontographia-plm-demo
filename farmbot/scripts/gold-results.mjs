// Regenerate the committed default-result gold for the five preset questions.
//
// The file is written from a real Relate run through the same `planQuestion`
// path the screen and farmbot/test/preset-questions.test.mjs use, seeded with
// the committed graph. Rows are canonicalised (sorted keys) and sorted by their
// JSON text, so comparisons are order-insensitive and the file is stable across
// runs.
//
// Usage (Node 22):
//   npx -y node@22 farmbot/scripts/gold-results.mjs
//
// Do not hand-edit farmbot/oracle/default-results.gold.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOntographia } from '@edgesentry/ontographia-wasm';
import initRelate, { RelateDb } from '@relate/relate-wasm';
import { QUESTIONS } from '../../src/farmbot/questions.mjs';
import { planQuestion } from '../../src/farmbot/plan.mjs';
import { buildSeedStatements, loadSeed } from '../../src/farmbot/seed-load.mjs';
import { parseRelationshipEndpoints } from '../../src/farmbot/ontology-relationships.mjs';
import { SEED_DIGEST } from '../../src/farmbot/seed-digest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const ONTOLOGY_PATH = join(ROOT, 'farmbot/ontology/farmbot.native.yaml');
const INTENTS_DIR = join(ROOT, 'farmbot/intents');
const SEED_PATH = join(ROOT, 'farmbot/dist/farmbot.seed.json');
const GOLD_PATH = join(ROOT, 'farmbot/oracle/default-results.gold.json');
const ONTOGRAPHIA_WASM = join(
  ROOT,
  'node_modules/@edgesentry/ontographia-wasm/ontographia_wasm.wasm',
);
const RELATE_WASM = join(ROOT, 'node_modules/@relate/relate-wasm/relate_bg.wasm');

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

/** Sort keys and rows so the committed file is order-insensitive. */
function canonicalRow(row) {
  return Object.fromEntries(
    Object.keys(row)
      .sort()
      .map((key) => [key, toJs(row[key])]),
  );
}

const ontologyText = readFileSync(ONTOLOGY_PATH, 'utf8');
const seedBytes = readFileSync(SEED_PATH);
const seed = JSON.parse(seedBytes.toString('utf8'));

const engine = await loadOntographia(readFileSync(ONTOGRAPHIA_WASM));
await initRelate({ module_or_path: readFileSync(RELATE_WASM) });
const db = new RelateDb();
loadSeed(db, buildSeedStatements(seed, parseRelationshipEndpoints(ontologyText)));

const questions = [];
for (const question of QUESTIONS) {
  const intent = JSON.parse(
    readFileSync(join(INTENTS_DIR, question.intentFile), 'utf8'),
  );
  const plan = planQuestion(engine, ontologyText, intent, question.distinct);
  const envelope = JSON.parse(
    db.execute(plan.executed, JSON.stringify(plan.params)),
  );
  if (envelope.error) {
    throw new Error(`${question.id}: ${envelope.error}`);
  }
  const rows = (envelope.rows ?? [])
    .map(canonicalRow)
    .sort((left, right) => {
      // Match the UTF-16 order `Array.prototype.sort()` uses on the JSON text in
      // the tests, so the committed file and the multiset agree byte for byte.
      const leftText = JSON.stringify(left);
      const rightText = JSON.stringify(right);
      return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
    });
  questions.push({
    id: question.id,
    intentFile: question.intentFile,
    columns: envelope.columns ?? intent.return.map((entry) => entry.as_name),
    rowCount: rows.length,
    rows,
  });
  console.log(`${question.id}: ${rows.length} rows`);
}

const gold = {
  format: 'farmbot-default-results-v1',
  seedDigest: SEED_DIGEST,
  seedBytes: seedBytes.length,
  questions,
};

writeFileSync(GOLD_PATH, `${JSON.stringify(gold, null, 2)}\n`);
console.log(`wrote ${GOLD_PATH}`);
