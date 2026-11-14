// Tests for the typed logical dump and the seed-digest ordering of the build.
//
// The dump carries the engine type of every property, so values that decode to
// the same JS value (INTEGER 1 and FLOAT 1.0, or a bigint and a map with an
// "$int64" key) still produce different digests.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  COMMITTED_SEED,
  SNAPSHOT_FORMAT,
  SNAPSHOT_FORMAT_ENV,
  buildStore,
  canonicalJson,
  loadClient,
  logicalDump,
  typedPropertyJson,
} from '../scripts/relate-store.mjs';

const tempDirs = [];

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Write one graph into a fresh store, leaving the writer open like the build does. */
function storeWith(cypher) {
  const dir = join(tempDir('farmbot-dump-store-'), 'store');
  mkdirSync(dir, { recursive: true });
  process.env[SNAPSHOT_FORMAT_ENV] = SNAPSHOT_FORMAT;
  const { Database } = loadClient();
  const database = Database.open(dir);
  database.connect().query(cypher);
  database.checkpoint();
  return dir;
}

test('canonicalJson refuses a bare bigint', () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null] }), '{"a":[true,null],"b":1}');
  assert.throws(() => canonicalJson(9007199254740993n), /unsupported bigint value/);
  assert.throws(() => canonicalJson(undefined), /unsupported undefined/);
});

test('typed property encoding keeps INTEGER and FLOAT apart', () => {
  const integer = typedPropertyJson('INTEGER NOT NULL', 1);
  const float = typedPropertyJson('FLOAT NOT NULL', 1.0);
  assert.equal(integer, '{"type":"INTEGER NOT NULL","value":"1"}');
  assert.equal(float, '{"type":"FLOAT NOT NULL","value":1}');
  assert.notEqual(integer, float);
});

test('typed property encoding keeps a bigint and a "$int64" map apart', () => {
  const bigint = typedPropertyJson('INTEGER NOT NULL', 9007199254740993n);
  const map = typedPropertyJson('MAP', { $int64: '9007199254740993' });
  assert.equal(bigint, '{"type":"INTEGER NOT NULL","value":"9007199254740993"}');
  assert.equal(map, '{"type":"MAP","value":{"$int64":"9007199254740993"}}');
  assert.notEqual(bigint, map);
});

test('a safe integer encodes the same as a number and as a bigint', () => {
  assert.equal(
    typedPropertyJson('INTEGER NOT NULL', 1),
    typedPropertyJson('INTEGER NOT NULL', 1n),
  );
});

test('typed property encoding covers lists and maps', () => {
  assert.equal(
    typedPropertyJson('LIST<INTEGER NOT NULL> NOT NULL', [1, 2n]),
    '{"type":"LIST<INTEGER NOT NULL> NOT NULL","value":["1","2"]}',
  );
  assert.equal(
    typedPropertyJson('MAP', { b: [true, null], a: 1 }),
    '{"type":"MAP","value":{"a":1,"b":[true,null]}}',
  );
});

test('a value that contradicts its type throws', () => {
  assert.throws(() => typedPropertyJson('INTEGER NOT NULL', 1.5), /does not match/);
  assert.throws(() => typedPropertyJson('INTEGER NOT NULL', '1'), /does not match/);
  assert.throws(() => typedPropertyJson('FLOAT NOT NULL', 'x'), /does not match/);
  assert.throws(() => typedPropertyJson('BOOLEAN NOT NULL', 1), /does not match/);
  assert.throws(() => typedPropertyJson('STRING NOT NULL', 1), /does not match/);
  assert.throws(
    () => typedPropertyJson('LIST<INTEGER NOT NULL> NOT NULL', [1.5]),
    /does not match/,
  );
  assert.throws(() => typedPropertyJson('MAP', []), /does not match/);
  assert.throws(() => typedPropertyJson('DATE NOT NULL', 'x'), /unsupported property type/);
});

test('two stores that differ only in INTEGER 1 vs FLOAT 1.0 have different digests', () => {
  const integer = logicalDump(storeWith('CREATE (n:Probe {id: "a", v: 1})'));
  const float = logicalDump(storeWith('CREATE (n:Probe {id: "a", v: 1.0})'));

  assert.ok(
    integer.text.includes('"v":{"type":"INTEGER NOT NULL","value":"1"}'),
    integer.text,
  );
  assert.ok(
    float.text.includes('"v":{"type":"FLOAT NOT NULL","value":1}'),
    float.text,
  );
  assert.notEqual(integer.sha256, float.sha256);
});

test('a bad seed leaves an existing output directory untouched', () => {
  const out = join(tempDir('farmbot-store-bad-seed-'), 'store');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'keep.txt'), 'keep me');

  const badSeed = join(tempDir('farmbot-seed-bad-'), 'farmbot.seed.json');
  writeFileSync(badSeed, Buffer.concat([readFileSync(COMMITTED_SEED), Buffer.from('\n')]));

  assert.throws(
    () => buildStore(out, { seedPath: badSeed }),
    /committed seed digest mismatch/,
  );
  assert.deepEqual(readdirSync(out), ['keep.txt']);
  assert.equal(readFileSync(join(out, 'keep.txt'), 'utf8'), 'keep me');
  assert.equal(existsSync(join(out, 'graph.json')), false);
});
