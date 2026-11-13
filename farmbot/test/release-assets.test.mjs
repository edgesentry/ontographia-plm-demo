// Tests for the persistent Relate directory store and the release assets.
//
// The store is built from the committed seed with `@relate/relate` and the
// JSON snapshot codec, read back through Cypher, and compared with the
// committed digest manifest. The last tests run the two release scripts on a
// temporary directory, then tamper with the output to prove the verifier
// fails.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import {
  COMMITTED_SEED,
  COMMITTED_SEED_SIDECAR,
  MANIFEST_NAME,
  STORE_ARCHIVE_NAME,
  STORE_DIR_NAME,
  buildStore,
  canonicalJson,
  compareStrings,
  loadCommittedSeed,
  logicalDump,
  readManifest,
} from '../scripts/relate-store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const RELEASE_ASSETS = resolve(ROOT, 'farmbot/scripts/release-assets.mjs');
const VERIFY_ASSETS = resolve(ROOT, 'farmbot/scripts/verify-release-assets.mjs');
const TRACKED_DUCKDB_SIDECAR = resolve(ROOT, 'farmbot/dist/farmbot.duckdb.sha256');

const tempDirs = [];

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

let sharedStore = null;
let sharedAssets = null;

/** Build one store for the read-only assertions and reuse it. */
function sharedStoreDir() {
  if (!sharedStore) {
    sharedStore = join(tempDir('farmbot-store-'), STORE_DIR_NAME);
    buildStore(sharedStore);
  }
  return sharedStore;
}

/** Build the release assets once; the negative tests copy this directory. */
function sharedAssetsDir() {
  if (!sharedAssets) {
    sharedAssets = join(tempDir('farmbot-assets-'), 'release-assets');
    const build = runScript(RELEASE_ASSETS, ['--out', sharedAssets]);
    assert.equal(build.status, 0, `release:assets failed:\n${build.stdout}\n${build.stderr}`);
  }
  return sharedAssets;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function parseDump(dump) {
  const lines = dump.text.split('\n');
  assert.equal(lines.at(-1), '', 'the dump ends with a newline');
  assert.equal(lines[0], 'farmbot-relate-store-v1');
  const nodes = [];
  const relationships = [];
  for (const line of lines.slice(1, -1)) {
    const entry = JSON.parse(line);
    if (entry.kind === 'node') nodes.push(entry);
    else if (entry.kind === 'relationship') relationships.push(entry);
    else throw new Error(`unknown dump line kind ${entry.kind}`);
  }
  return { nodes, relationships };
}

function runScript(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env },
  });
}

/** Rewrite one `sha256sum` line after a file was replaced. */
function rewriteSumLine(dir, name) {
  const path = join(dir, 'SHA256SUMS');
  const text = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) =>
      line.endsWith(`  ${name}`) ? `${sha256File(join(dir, name))}  ${name}` : line,
    )
    .join('\n');
  writeFileSync(path, text);
}

test('the store builds with the JSON snapshot codec', () => {
  const dir = sharedStoreDir();
  const graphJson = join(dir, 'graph.json');
  assert.ok(existsSync(graphJson), 'graph.json must exist after the build');
  const engineManifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(engineManifest.codec, 'json');
  const graph = JSON.parse(readFileSync(graphJson, 'utf8'));
  assert.ok(Array.isArray(graph.nodes) && graph.nodes.length > 0);
  assert.ok(Array.isArray(graph.relationships) && graph.relationships.length > 0);
});

test('the logical dump matches a dump derived from the committed seed', () => {
  const dump = logicalDump(sharedStoreDir());
  const { seed } = loadCommittedSeed();
  const parsed = parseDump(dump);

  assert.equal(dump.nodes, 604);
  assert.equal(dump.relationships, 1022);
  assert.equal(parsed.nodes.length, seed.nodes.length);
  assert.equal(parsed.relationships.length, seed.edges.length);

  const expectedNodes = seed.nodes
    .map((node) => ({
      id: node.id,
      labels: [...node.labels].sort(compareStrings),
      properties: { id: node.id, ...node.properties },
    }))
    .sort((left, right) => compareStrings(left.id, right.id));
  const actualNodes = parsed.nodes.map((node) => ({
    id: node.properties.id,
    labels: node.labels,
    properties: node.properties,
  }));
  for (const [index, expected] of expectedNodes.entries()) {
    assert.deepEqual(actualNodes[index], expected, `node ${expected.id}`);
  }

  const expectedRelationships = seed.edges
    .map((edge) => ({ type: edge.type, from: edge.from, to: edge.to, properties: {} }))
    .sort(
      (left, right) =>
        compareStrings(left.type, right.type) ||
        compareStrings(left.from, right.from) ||
        compareStrings(left.to, right.to),
    );
  const actualRelationships = parsed.relationships.map((row) => ({
    type: row.type,
    from: row.from,
    to: row.to,
    properties: row.properties,
  }));
  for (const [index, expected] of expectedRelationships.entries()) {
    assert.deepEqual(actualRelationships[index], expected, `relationship ${index}`);
  }

  const labelCount = Object.values(dump.labels).reduce((sum, count) => sum + count, 0);
  assert.ok(labelCount > dump.nodes, 'nodes carry their ancestor labels too');
  assert.equal(
    Object.values(dump.relationshipTypes).reduce((sum, count) => sum + count, 0),
    1022,
  );
});

test('the store logical digest and counts equal the committed manifest', () => {
  const manifest = readManifest();
  const dump = logicalDump(sharedStoreDir());
  assert.equal(manifest.relateStore.digestFormat, 'farmbot-relate-store-v1');
  assert.equal(manifest.relateStore.sha256, dump.sha256);
  assert.equal(manifest.relateStore.nodes, dump.nodes);
  assert.equal(manifest.relateStore.relationships, dump.relationships);
  assert.equal(manifest.relateStore.clientVersion, '1.0.1');
  assert.equal(manifest.relateStore.snapshotCodec, 'json');
});

test('rebuilding the store gives the same logical digest', () => {
  const first = logicalDump(sharedStoreDir());
  const secondDir = join(tempDir('farmbot-store-rebuild-'), STORE_DIR_NAME);
  buildStore(secondDir);
  const second = logicalDump(secondDir);
  assert.equal(second.sha256, first.sha256);
  assert.equal(second.nodes, first.nodes);
  assert.equal(second.relationships, first.relationships);
});

test('the manifest digests equal the committed sidecars', () => {
  const manifest = readManifest();
  const seedSidecar = readFileSync(COMMITTED_SEED_SIDECAR, 'utf8').trim();
  assert.equal(manifest.seed.digest, seedSidecar);
  assert.equal(manifest.seed.file, 'farmbot.seed.json');
  assert.equal(
    manifest.seed.digest,
    `farmbot-graph-v1 sha256:${sha256File(COMMITTED_SEED)}`,
  );

  const duckdbSidecar = readFileSync(TRACKED_DUCKDB_SIDECAR, 'utf8').trim();
  assert.equal(manifest.duckdb.digestFormat, 'farmbot-canonical-v1');
  assert.equal(manifest.duckdb.sha256, duckdbSidecar);
  assert.equal(manifest.genesis.pin, '44e0fa24d4a538dfa1255a4e89308ccabf3abaeb');

  assert.equal(canonicalJson({ b: 1, a: [true, null] }), '{"a":[true,null],"b":1}');
  assert.throws(() => canonicalJson(undefined), /unsupported undefined/);
});

test('the screen store digest constants equal the committed manifest', async () => {
  const screen = await import('../../src/farmbot/store-digest.mjs');
  const manifest = readManifest();
  assert.equal(
    screen.STORE_DIGEST,
    `${manifest.relateStore.digestFormat} sha256:${manifest.relateStore.sha256}`,
  );
  assert.equal(screen.STORE_SHA256_HEX, manifest.relateStore.sha256);
  assert.equal(screen.STORE_NODES, manifest.relateStore.nodes);
  assert.equal(screen.STORE_RELATIONSHIPS, manifest.relateStore.relationships);
});

test('release assets build and verify end to end', () => {
  const dir = sharedAssetsDir();

  for (const name of [MANIFEST_NAME, 'farmbot.duckdb', STORE_ARCHIVE_NAME, 'SHA256SUMS']) {
    assert.ok(existsSync(join(dir, name)), `${name} is missing from the output`);
  }
  const sums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.deepEqual(
    sums.map((line) => line.slice(66)),
    [STORE_ARCHIVE_NAME, 'farmbot.duckdb', MANIFEST_NAME],
  );
  for (const line of sums) {
    const [hex, name] = [line.slice(0, 64), line.slice(66)];
    assert.equal(hex, sha256File(join(dir, name)), `SHA256SUMS line for ${name}`);
  }

  const verify = runScript(VERIFY_ASSETS, [dir]);
  assert.equal(verify.status, 0, `release:verify failed:\n${verify.stdout}\n${verify.stderr}`);
  assert.match(verify.stdout, /store logical digest and counts match the manifest/);
  assert.match(verify.stdout, /release assets verified/);
});

test('the verifier fails on one flipped byte in the DuckDB file', () => {
  const source = sharedAssetsDir();
  const dir = join(tempDir('farmbot-assets-duckdb-'), 'release-assets');
  cpSync(source, dir, { recursive: true });
  const duckdb = join(dir, 'farmbot.duckdb');
  const bytes = readFileSync(duckdb);
  bytes[Math.floor(bytes.length / 2)] ^= 0x01;
  writeFileSync(duckdb, bytes);

  const verify = runScript(VERIFY_ASSETS, [dir]);
  assert.notEqual(verify.status, 0, 'the verifier must reject a changed DuckDB file');
  assert.match(verify.stdout, /FAIL SHA256SUMS entry farmbot\.duckdb matches the file bytes/);
});

test('the verifier fails on a SHA256SUMS-consistent archive with one changed property', () => {
  const source = sharedAssetsDir();
  const dir = join(tempDir('farmbot-assets-store-'), 'release-assets');
  cpSync(source, dir, { recursive: true });

  const work = tempDir('farmbot-assets-tamper-');
  const extract = spawnSync('tar', ['-xzf', join(dir, STORE_ARCHIVE_NAME), '-C', work], {
    encoding: 'utf8',
  });
  assert.equal(extract.status, 0, extract.stderr);
  const graphPath = join(work, STORE_DIR_NAME, 'graph.json');
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  const node = graph.nodes.find((entry) => typeof entry.properties?.title === 'string');
  assert.ok(node, 'the store has a node with a title property');
  node.properties.title = `${node.properties.title} (tampered)`;
  writeFileSync(graphPath, JSON.stringify(graph));

  const rearchive = spawnSync(
    'tar',
    ['-czf', join(dir, STORE_ARCHIVE_NAME), '-C', work, STORE_DIR_NAME],
    { encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } },
  );
  assert.equal(rearchive.status, 0, rearchive.stderr);
  rewriteSumLine(dir, STORE_ARCHIVE_NAME);

  const verify = runScript(VERIFY_ASSETS, [dir]);
  assert.notEqual(verify.status, 0, 'the verifier must reject a changed logical digest');
  assert.match(verify.stdout, /FAIL store logical digest and counts match the manifest/);
});

test('the verifier fails when an expected asset is missing', () => {
  const source = sharedAssetsDir();
  const dir = join(tempDir('farmbot-assets-missing-'), 'release-assets');
  cpSync(source, dir, { recursive: true });
  rmSync(join(dir, 'farmbot.duckdb'));

  const verify = runScript(VERIFY_ASSETS, [dir]);
  assert.notEqual(verify.status, 0, 'the verifier must reject a missing asset');
  assert.match(verify.stdout, /FAIL expected asset farmbot\.duckdb is present and listed/);
});
