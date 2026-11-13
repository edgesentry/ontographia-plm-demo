import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { parse, stringify } from 'yaml';
import {
  buildFullGraph,
  digestBytes,
  loadOntology,
  readExtract,
  scopeGraphToPart,
  serializeSeed,
  sidecarText,
  validateSeed,
} from '../scripts/graph.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const EXTRACT = resolve(ROOT, 'farmbot/scripts/extract.mjs');
const GRAPH = resolve(ROOT, 'farmbot/scripts/graph.mjs');
const ONTOLOGY_PATH = resolve(ROOT, 'farmbot/ontology/farmbot.native.yaml');
const COMMITTED_SEED = resolve(ROOT, 'farmbot/dist/farmbot.seed.json');
const COMMITTED_DIGEST = `${COMMITTED_SEED}.sha256`;

const temporaryDirectories = [];

function tempDir(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Build the extract into a private directory. The extract test rebuilds the
// shared farmbot/dist/farmbot.duckdb read-write in another process, and the
// test runner runs files in parallel, so this file must not open that path.
const PRIVATE_DIRECTORY = tempDir('farmbot-graph-extract-');
const built = spawnSync(
  process.execPath,
  [EXTRACT, '--out', PRIVATE_DIRECTORY],
  { cwd: ROOT, encoding: 'utf8' },
);
assert.equal(
  built.status,
  0,
  `extract failed:\n${built.stderr}\n${built.stdout}`,
);
const EXTRACT_PATH = join(PRIVATE_DIRECTORY, 'farmbot.duckdb');

const ontology = loadOntology(ONTOLOGY_PATH);
const tables = await readExtract(EXTRACT_PATH);
const fullSeed = buildFullGraph(tables, ontology);
validateSeed(fullSeed, ontology);

function runGraph(args) {
  return spawnSync(process.execPath, [GRAPH, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

function countByPrimaryLabel(seed) {
  const counts = new Map();
  for (const node of seed.nodes) {
    const label = node.labels[0];
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return counts;
}

function nodeIds(seed) {
  return new Set(seed.nodes.map((node) => node.id));
}

function edgeKeys(seed) {
  return new Set(
    seed.edges.map((edge) => `${edge.type}\u0000${edge.from}\u0000${edge.to}`),
  );
}

test('two runs produce byte-identical seeds and digests', () => {
  const first = tempDir('farmbot-graph-a-');
  const second = tempDir('farmbot-graph-b-');
  const args = ['--extract', EXTRACT_PATH, '--recipe', 'full'];
  const one = runGraph([...args, '--out', first]);
  assert.equal(one.status, 0, one.stderr);
  const two = runGraph([...args, '--out', second]);
  assert.equal(two.status, 0, two.stderr);

  const seedOne = readFileSync(join(first, 'farmbot.seed.json'));
  const seedTwo = readFileSync(join(second, 'farmbot.seed.json'));
  assert.ok(seedOne.equals(seedTwo), 'seed bytes differ between runs');

  const digestOne = readFileSync(join(first, 'farmbot.seed.json.sha256'), 'utf8');
  const digestTwo = readFileSync(join(second, 'farmbot.seed.json.sha256'), 'utf8');
  assert.equal(digestOne, digestTwo);
  assert.match(digestOne, /^farmbot-graph-v1 sha256:[0-9a-f]{64}\n$/);
  assert.equal(digestOne, sidecarText(seedOne));
});

test('the full graph has the acceptance counts', () => {
  const counts = countByPrimaryLabel(fullSeed);
  assert.equal(counts.get('Part'), 149);
  assert.equal(counts.get('Usage'), 160 + 54 + 65);
  assert.equal(
    fullSeed.nodes.filter((node) => node.labels.includes('QuantityDifference')).length,
    12,
  );
  assert.equal(counts.get('UnmatchedName'), 13);
  assert.equal(counts.get('ProductVariant'), 2);
  assert.equal(counts.get('PartVariant'), 44);
  assert.equal(counts.get('BomCategory'), 8);
  assert.equal(counts.get('AssemblyChapter'), 9);
  assert.equal(counts.get('PreAssembly'), 12);
});

test('every label and relationship type is declared and every ancestor label is present', () => {
  validateSeed(fullSeed, ontology);

  for (const node of fullSeed.nodes) {
    for (const label of node.labels) {
      assert.ok(ontology.classNames.has(label), `undeclared label ${label}`);
    }
    assert.deepEqual(node.labels, ontology.labelsFor(node.labels[0]));
  }
  for (const edge of fullSeed.edges) {
    assert.ok(
      ontology.relationships.has(edge.type),
      `undeclared relationship type ${edge.type}`,
    );
  }

  const part = fullSeed.nodes.find((node) => node.labels[0] === 'Part');
  assert.deepEqual(part.labels, ['Part', 'Item']);

  const preAssembly = fullSeed.nodes.find((node) => node.labels[0] === 'PreAssembly');
  assert.deepEqual(preAssembly.labels, [
    'PreAssembly',
    'ManufacturingContainer',
    'Item',
    'Structure',
  ]);

  const difference = fullSeed.nodes.find(
    (node) => node.labels[0] === 'QuantityDifference',
  );
  assert.deepEqual(difference.labels, [
    'QuantityDifference',
    'QuantityComparison',
    'Correspondence',
  ]);
});

test('the committed seed and digest match a fresh rebuild', () => {
  assert.ok(existsSync(COMMITTED_SEED), `${COMMITTED_SEED} is missing`);
  assert.ok(existsSync(COMMITTED_DIGEST), `${COMMITTED_DIGEST} is missing`);

  const fresh = serializeSeed(fullSeed);
  const committed = readFileSync(COMMITTED_SEED);
  assert.ok(
    committed.equals(fresh),
    'committed seed differs from a fresh rebuild; regenerate it with graph.mjs',
  );

  const committedDigest = readFileSync(COMMITTED_DIGEST, 'utf8');
  assert.equal(committedDigest, sidecarText(fresh));
  assert.equal(committedDigest, sidecarText(committed));
  assert.match(committedDigest, /^farmbot-graph-v1 sha256:[0-9a-f]{64}\n$/);
  assert.equal(
    committedDigest,
    `farmbot-graph-v1 sha256:${digestBytes(committed)}\n`,
  );
});

test('an undeclared label, property or relationship type cannot be emitted', () => {
  const withLabel = structuredClone(fullSeed);
  withLabel.nodes[0].labels = [...withLabel.nodes[0].labels, 'NotDeclared'];
  assert.throws(
    () => validateSeed(withLabel, ontology),
    /undeclared label NotDeclared/,
  );

  const withProperty = structuredClone(fullSeed);
  withProperty.nodes[0].properties.not_a_property = 'x';
  assert.throws(
    () => validateSeed(withProperty, ontology),
    /undeclared property not_a_property/,
  );

  const withType = structuredClone(fullSeed);
  withType.edges[0].type = 'NOT_DECLARED';
  assert.throws(
    () => validateSeed(withType, ontology),
    /undeclared relationship type NOT_DECLARED/,
  );

  const missingAncestor = structuredClone(fullSeed);
  const part = missingAncestor.nodes.find((node) => node.labels[0] === 'Part');
  part.labels = ['Part'];
  assert.throws(
    () => validateSeed(missingAncestor, ontology),
    /missing ancestor label Item/,
  );
});

test('the generator fails when the ontology does not declare a relationship it needs', () => {
  const document = parse(readFileSync(ONTOLOGY_PATH, 'utf8'));
  document.relationships = document.relationships.filter(
    (entry) => entry.name !== 'CANDIDATE',
  );
  const directory = tempDir('farmbot-graph-ontology-');
  const ontologyPath = join(directory, 'farmbot.native.yaml');
  writeFileSync(ontologyPath, stringify(document));
  const out = join(directory, 'out');

  const result = runGraph([
    '--extract',
    EXTRACT_PATH,
    '--ontology',
    ontologyPath,
    '--recipe',
    'full',
    '--out',
    out,
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /undeclared relationship type CANDIDATE/);
  assert.equal(existsSync(join(out, 'farmbot.seed.json')), false);
});

test('the part recipe is a strict, reachable subset of the full graph', () => {
  const out = tempDir('farmbot-graph-part-');
  const result = runGraph([
    '--extract',
    EXTRACT_PATH,
    '--recipe',
    'part',
    '--out',
    out,
  ]);
  assert.equal(result.status, 0, result.stderr);

  const partSeed = JSON.parse(
    readFileSync(join(out, 'farmbot.part.seed.json'), 'utf8'),
  );
  validateSeed(partSeed, ontology);

  const parts = partSeed.nodes.filter((node) => node.labels.includes('Part'));
  assert.equal(parts.length, 1);
  assert.equal(parts[0].properties.name, 'Belt');

  const fullIds = nodeIds(fullSeed);
  const fullEdgeKeys = edgeKeys(fullSeed);
  for (const node of partSeed.nodes) {
    assert.ok(fullIds.has(node.id), `node ${node.id} is not in the full graph`);
  }
  for (const edge of partSeed.edges) {
    const key = `${edge.type}\u0000${edge.from}\u0000${edge.to}`;
    assert.ok(fullEdgeKeys.has(key), `edge ${key} is not in the full graph`);
  }
  assert.ok(partSeed.nodes.length < fullSeed.nodes.length);
  assert.ok(partSeed.edges.length < fullSeed.edges.length);

  const reachable = scopeGraphToPart(fullSeed, 'Belt');
  assert.deepEqual(
    partSeed.nodes.map((node) => node.id),
    reachable.nodes.map((node) => node.id),
  );
  assert.deepEqual(partSeed.edges, reachable.edges);
});
