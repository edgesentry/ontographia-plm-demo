#!/usr/bin/env node
// Build a persistent Relate directory store from the committed FarmBot seed,
// and compute its logical digest.
//
// The browser loads the seed into `:memory:` Relate WASM. This script writes
// the same graph to a directory on disk with the Node client
// (`@relate/relate`), so a reviewer can open `graph.json` and query the store
// read-only without a browser. The store is a build output; only the logical
// digest is committed, in `farmbot/dist/farmbot.release.json`.
//
// The store directory is never byte-hashed: its files are not guaranteed to be
// byte-identical across runs or platforms. `logicalDump` reads the
// graph back through Cypher and hashes a canonical line format instead.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { buildSeedStatements } from '../../src/farmbot/seed-load.mjs';
import { parseRelationshipEndpoints } from '../../src/farmbot/ontology-relationships.mjs';
import { SEED_SHA256_HEX } from '../../src/farmbot/seed-digest.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const FARMBOT_DIR = resolve(SCRIPT_DIR, '..');

export const STORE_FORMAT = 'farmbot-relate-store-v2';
export const STORE_DIR_NAME = 'farmbot.relate-store';
export const STORE_ARCHIVE_NAME = 'farmbot-relate-store.tar.gz';
export const MANIFEST_NAME = 'farmbot.release.json';
export const MANIFEST_FORMAT = 'farmbot-release-manifest-v1';
export const DEFAULT_STORE_DIR = resolve(FARMBOT_DIR, 'dist', STORE_DIR_NAME);
export const COMMITTED_SEED = resolve(FARMBOT_DIR, 'dist/farmbot.seed.json');
export const COMMITTED_SEED_SIDECAR = `${COMMITTED_SEED}.sha256`;
export const COMMITTED_ONTOLOGY = resolve(FARMBOT_DIR, 'ontology/farmbot.native.yaml');
export const COMMITTED_MANIFEST = resolve(FARMBOT_DIR, 'dist', MANIFEST_NAME);

/** The snapshot codec the store build selects. The default writes Parquet shards. */
export const SNAPSHOT_FORMAT_ENV = 'RELATE_SNAPSHOT_FORMAT';
export const SNAPSHOT_FORMAT = 'json';

let client = null;

/**
 * Load the native Node client lazily. `@relate/relate` is CommonJS and binds a
 * native library through koffi, so it must never reach browser code.
 *
 * @returns {{ Database: import('@relate/relate').Database }}
 */
export function loadClient() {
  if (client) return client;
  const require = createRequire(import.meta.url);
  const module = require('@relate/relate');
  client = { Database: module.Database };
  return client;
}

/** Codepoint string comparison; locale-independent and stable across hosts. */
export function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Canonical JSON for one dump line. Object keys are sorted at every level, so
 * the same graph always serializes to the same bytes.
 *
 * Supported values are `null`, booleans, finite numbers, strings, arrays and
 * plain objects. Anything else throws: silently lossy encodings would make the
 * digest meaningless. In particular a bare `bigint` throws, because without an
 * engine type it cannot be told apart from other numeric shapes; property
 * values are encoded by `typedPropertyJson`, which carries the type.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`unsupported number value ${String(value)} in the store dump`);
      }
      return JSON.stringify(value);
    case 'bigint':
      throw new Error(
        'unsupported bigint value in the store dump: a bare bigint has no engine type',
      );
    case 'object':
      break;
    default:
      throw new Error(`unsupported ${typeof value} value in the store dump`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(
      `unsupported object value in the store dump: ${value.constructor?.name ?? 'unknown'}`,
    );
  }
  const keys = Object.keys(value).sort(compareStrings);
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

const NOT_NULL_SUFFIX = ' NOT NULL';

/** A short, bigint-safe description of a JS value for error messages. */
function describeValue(value) {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * The engine type string without its trailing `NOT NULL`, e.g. `LIST<INTEGER>`.
 *
 * `valueType()` reports values such as `INTEGER NOT NULL`,
 * `LIST<FLOAT NOT NULL> NOT NULL` or `MAP`.
 *
 * @param {string} type
 * @returns {string}
 */
export function baseEngineType(type) {
  if (typeof type !== 'string' || type.length === 0) {
    throw new Error('a store property has no engine type');
  }
  return type.endsWith(NOT_NULL_SUFFIX) ? type.slice(0, -NOT_NULL_SUFFIX.length) : type;
}

/**
 * Encode one property value as canonical JSON for its reported engine type.
 *
 * INTEGER values are decimal strings, so a safe-integer JS number and a bigint
 * of the same value encode the same, while a map that happens to contain an
 * `"$int64"` key is still typed as `MAP`. FLOAT values are JSON numbers, which
 * cannot distinguish `-0.0` from `0.0`.
 *
 * @param {string} type The engine type, as `valueType()` reported it.
 * @param {unknown} value
 * @returns {string}
 */
export function encodeTypedValue(type, value) {
  const base = baseEngineType(type);
  const mismatch = (expected) =>
    new Error(
      `store value ${describeValue(value)} does not match its engine type ` +
        `${JSON.stringify(type)} (expected ${expected})`,
    );

  if (base === 'INTEGER') {
    if (typeof value === 'bigint') return JSON.stringify(value.toString());
    if (typeof value === 'number' && Number.isInteger(value)) {
      return JSON.stringify(BigInt(value).toString());
    }
    throw mismatch('an integer');
  }
  if (base === 'FLOAT') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw mismatch('a finite number');
    }
    return JSON.stringify(value);
  }
  if (base === 'BOOLEAN') {
    if (typeof value !== 'boolean') throw mismatch('a boolean');
    return value ? 'true' : 'false';
  }
  if (base === 'STRING') {
    if (typeof value !== 'string') throw mismatch('a string');
    return JSON.stringify(value);
  }
  const list = /^LIST<(.+)>$/.exec(base);
  if (list) {
    if (!Array.isArray(value)) throw mismatch('a list');
    return `[${value.map((entry) => encodeTypedValue(list[1], entry)).join(',')}]`;
  }
  if (base === 'MAP' || base.startsWith('MAP<')) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw mismatch('a map');
    }
    return canonicalJson(value);
  }
  throw new Error(`unsupported property type ${JSON.stringify(type)} in the store dump`);
}

/**
 * One typed property: `{"type": <valueType string>, "value": <canonical value>}`.
 *
 * @param {string} type
 * @param {unknown} value
 * @returns {string}
 */
export function typedPropertyJson(type, value) {
  return `{"type":${canonicalJson(type)},"value":${encodeTypedValue(type, value)}}`;
}

/**
 * Canonical JSON object of typed properties, keys sorted by code point.
 *
 * @param {Record<string, unknown>} properties
 * @param {Array<[string, string]>} types Pairs from `[k IN keys(n) | [k, valueType(n[k])]]`.
 * @param {string} where Used in error messages, e.g. `node "a"`.
 * @returns {string}
 */
function typedPropertiesJson(properties, types, where) {
  const typeByKey = new Map();
  for (const entry of types ?? []) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') {
      throw new Error(`${where} returned a malformed engine type entry`);
    }
    typeByKey.set(entry[0], entry[1]);
  }
  const keys = Object.keys(properties).sort(compareStrings);
  return `{${keys
    .map((key) => {
      if (!typeByKey.has(key)) {
        throw new Error(`${where} property ${JSON.stringify(key)} has no reported engine type`);
      }
      return `${JSON.stringify(key)}:${typedPropertyJson(typeByKey.get(key), properties[key])}`;
    })
    .join(',')}}`;
}

/**
 * Read the committed seed and refuse to continue when its bytes do not match
 * the digest the browser and the tests use.
 *
 * @param {string} [seedPath] Test hook; defaults to the committed seed.
 * @returns {{ bytes: Buffer, seed: { nodes: object[], edges: object[] }, sha256: string }}
 */
export function loadCommittedSeed(seedPath = COMMITTED_SEED) {
  const source = resolve(seedPath);
  const bytes = readFileSync(source);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== SEED_SHA256_HEX) {
    throw new Error(
      `committed seed digest mismatch: ${source} hashes to ${sha256}, ` +
        `but src/farmbot/seed-digest.mjs expects ${SEED_SHA256_HEX}. Refusing to build the store.`,
    );
  }
  return { bytes, seed: JSON.parse(bytes.toString('utf8')), sha256 };
}

/**
 * The statements the browser runs, reused unchanged.
 *
 * @param {{ nodes: object[], edges: object[] }} seed
 * @returns {ReturnType<typeof buildSeedStatements>}
 */
export function seedStatements(seed) {
  const ontologyText = readFileSync(COMMITTED_ONTOLOGY, 'utf8');
  return buildSeedStatements(seed, parseRelationshipEndpoints(ontologyText));
}

/**
 * Build the store at `dir`. The committed seed digest is checked before the
 * output directory is touched, so a bad seed leaves an existing store intact.
 * After that the directory is deleted and recreated, so a failed load never
 * leaves a half-written store behind.
 *
 * `RELATE_SNAPSHOT_FORMAT=json` selects the JSON snapshot codec. The default
 * codec writes Parquet shards, which are not readable as one file, so the
 * build asserts the JSON layout after the checkpoint.
 *
 * There is no close method in the Node client, so call this in a process that
 * exits before the directory is archived or moved, or accept that the writer
 * handle lives until the process ends. `buildStoreInChild` does the former.
 *
 * @param {string} dir
 * @param {{ seedPath?: string }} [options] `seedPath` exists for tests: point
 *   the build at another seed file. The digest guard still applies.
 * @returns {{ dir: string, statements: number, graphJsonBytes: number }}
 */
export function buildStore(dir, options = {}) {
  const target = resolve(dir);
  const { seed } = loadCommittedSeed(options.seedPath ?? COMMITTED_SEED);

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  const statements = seedStatements(seed);

  process.env[SNAPSHOT_FORMAT_ENV] = SNAPSHOT_FORMAT;
  const { Database } = loadClient();
  const database = Database.open(target);
  const connection = database.connect();
  for (const statement of statements) {
    connection.query(statement.query, statement.params);
  }
  database.checkpoint();

  const graphJson = join(target, 'graph.json');
  if (!existsSync(graphJson)) {
    throw new Error(
      `the store at ${target} has no graph.json after the checkpoint; ` +
        `${SNAPSHOT_FORMAT_ENV}=${SNAPSHOT_FORMAT} did not select the JSON snapshot codec`,
    );
  }
  const engineManifest = join(target, 'manifest.json');
  if (!existsSync(engineManifest)) {
    throw new Error(`the store at ${target} has no manifest.json after the checkpoint`);
  }
  const codec = JSON.parse(readFileSync(engineManifest, 'utf8')).codec;
  if (codec !== SNAPSHOT_FORMAT) {
    throw new Error(
      `the store at ${target} uses snapshot codec ${JSON.stringify(codec)}, ` +
        `expected ${JSON.stringify(SNAPSHOT_FORMAT)}`,
    );
  }

  return {
    dir: target,
    statements: statements.length,
    graphJsonBytes: statSync(graphJson).size,
  };
}

/**
 * Build the store in a child Node process, so the writer handle is gone before
 * the caller archives or reads the directory.
 *
 * @param {string} dir
 * @returns {{ dir: string, statements: number, graphJsonBytes: number }}
 */
export function buildStoreInChild(dir) {
  const target = resolve(dir);
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), '--build-only', '--out', target],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
      env: { ...process.env, [SNAPSHOT_FORMAT_ENV]: SNAPSHOT_FORMAT },
    },
  );
  if (result.status !== 0) {
    throw new Error(`store build failed in a child process (exit ${result.status ?? 'signal'})`);
  }
  const statements = Number.parseInt(String(result.stdout).trim(), 10);
  if (!Number.isInteger(statements) || statements <= 0) {
    throw new Error(`store build child did not report its statement count: ${result.stdout}`);
  }
  return {
    dir: target,
    statements,
    graphJsonBytes: statSync(join(target, 'graph.json')).size,
  };
}

/**
 * Read the whole graph back through Cypher and serialize it canonically.
 *
 * Every property is typed: the value is encoded together with the engine type
 * that `valueType()` reports for it, so an INTEGER and a FLOAT, or a bigint and
 * a map that serializes the same way, cannot collide.
 *
 * Nodes are ordered by their `id` property; relationships by type, then the
 * endpoint `id` properties, then the canonical properties. Engine-internal
 * numeric ids and element ids are never used.
 *
 * @param {string} dir
 * @returns {{
 *   format: string,
 *   text: string,
 *   sha256: string,
 *   digest: string,
 *   nodes: number,
 *   relationships: number,
 *   labels: Record<string, number>,
 *   relationshipTypes: Record<string, number>,
 * }}
 */
export function logicalDump(dir) {
  const target = resolve(dir);
  const { Database } = loadClient();
  const database = Database.open(target, { readOnly: true });
  const connection = database.connect();

  const nodeRows = connection.query(
    'MATCH (n) RETURN labels(n) AS labels, properties(n) AS properties, ' +
      '[k IN keys(n) | [k, valueType(n[k])]] AS types',
  ).rows;
  const relationshipRows = connection.query(
    'MATCH (a)-[r]->(b) RETURN type(r) AS type, a.id AS from, b.id AS to, ' +
      'properties(r) AS properties, ' +
      '[k IN keys(r) | [k, valueType(r[k])]] AS types',
  ).rows;

  const labels = {};
  const nodes = nodeRows.map((row) => {
    const properties = row.properties ?? {};
    const id = properties.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('a store node has no string id property; the dump needs it for ordering');
    }
    const sortedLabels = [...(row.labels ?? [])].sort(compareStrings);
    for (const label of sortedLabels) labels[label] = (labels[label] ?? 0) + 1;
    const nodesProperties = typedPropertiesJson(
      properties,
      row.types,
      `node ${JSON.stringify(id)}`,
    );
    return {
      id,
      line:
        `{"kind":"node","labels":${canonicalJson(sortedLabels)},` +
        `"properties":${nodesProperties}}`,
    };
  });
  nodes.sort((left, right) => compareStrings(left.id, right.id));

  const relationshipTypes = {};
  const relationships = relationshipRows.map((row) => {
    if (typeof row.type !== 'string' || row.type.length === 0) {
      throw new Error('a store relationship has no type');
    }
    if (typeof row.from !== 'string' || typeof row.to !== 'string') {
      throw new Error(
        `relationship ${row.type} does not join two nodes with string id properties`,
      );
    }
    relationshipTypes[row.type] = (relationshipTypes[row.type] ?? 0) + 1;
    const relationshipProperties = typedPropertiesJson(
      row.properties ?? {},
      row.types,
      `relationship ${JSON.stringify(row.type)}`,
    );
    return {
      type: row.type,
      from: row.from,
      to: row.to,
      line:
        `{"from":${canonicalJson(row.from)},"kind":"relationship",` +
        `"properties":${relationshipProperties},"to":${canonicalJson(row.to)},` +
        `"type":${canonicalJson(row.type)}}`,
    };
  });
  relationships.sort(
    (left, right) =>
      compareStrings(left.type, right.type) ||
      compareStrings(left.from, right.from) ||
      compareStrings(left.to, right.to) ||
      compareStrings(left.line, right.line),
  );

  const lines = [
    STORE_FORMAT,
    ...nodes.map((node) => node.line),
    ...relationships.map((row) => row.line),
  ];
  const text = `${lines.join('\n')}\n`;
  const sha256 = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

  return {
    format: STORE_FORMAT,
    text,
    sha256,
    digest: `${STORE_FORMAT} sha256:${sha256}`,
    nodes: nodes.length,
    relationships: relationships.length,
    labels,
    relationshipTypes,
  };
}

/**
 * The committed release manifest, parsed.
 *
 * @returns {any}
 */
export function readManifest() {
  const manifest = JSON.parse(readFileSync(COMMITTED_MANIFEST, 'utf8'));
  if (manifest.format !== MANIFEST_FORMAT) {
    throw new Error(
      `${COMMITTED_MANIFEST} has format ${JSON.stringify(manifest.format)}, ` +
        `expected ${JSON.stringify(MANIFEST_FORMAT)}`,
    );
  }
  return manifest;
}

/**
 * Write the committed manifest with stable key order and a trailing newline.
 *
 * @param {any} manifest
 */
export function writeManifest(manifest) {
  writeFileSync(COMMITTED_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * Replace the store section of a manifest with a fresh dump. The seed and
 * DuckDB sections keep their committed values.
 *
 * @param {any} manifest
 * @param {ReturnType<typeof logicalDump>} dump
 * @returns {any}
 */
export function manifestWithDump(manifest, dump) {
  return {
    ...manifest,
    relateStore: {
      ...manifest.relateStore,
      digestFormat: dump.format,
      sha256: dump.sha256,
      nodes: dump.nodes,
      relationships: dump.relationships,
    },
  };
}

function parseArguments(argv) {
  const options = { out: DEFAULT_STORE_DIR, writeManifest: false, buildOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--write-manifest') {
      options.writeManifest = true;
    } else if (argument === '--build-only') {
      options.buildOnly = true;
    } else if (argument === '--out') {
      const value = argv[index + 1];
      if (!value) throw new Error('--out requires a path');
      options.out = resolve(value);
      index += 1;
    } else if (argument.startsWith('--out=')) {
      options.out = resolve(argument.slice('--out='.length));
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));

  if (options.buildOnly) {
    const built = buildStore(options.out);
    process.stdout.write(`${built.statements}\n`);
    return;
  }

  const built = buildStoreInChild(options.out);
  const dump = logicalDump(options.out);
  const manifest = readManifest();

  if (options.writeManifest) {
    writeManifest(manifestWithDump(manifest, dump));
    process.stdout.write(`manifest updated: ${COMMITTED_MANIFEST}\n`);
  } else {
    const expected = manifest.relateStore;
    if (dump.sha256 !== expected.sha256) {
      throw new Error(
        `store digest mismatch: built ${dump.digest}, ` +
          `committed ${expected.digestFormat}:${expected.sha256}`,
      );
    }
    if (dump.nodes !== expected.nodes || dump.relationships !== expected.relationships) {
      throw new Error(
        `store counts mismatch: built ${dump.nodes} nodes / ${dump.relationships} relationships, ` +
          `committed ${expected.nodes} nodes / ${expected.relationships} relationships`,
      );
    }
  }

  process.stdout.write(`store: ${options.out} (${built.graphJsonBytes} bytes of graph.json)\n`);
  process.stdout.write(`${dump.digest}\n`);
  process.stdout.write(`nodes: ${dump.nodes}\n`);
  process.stdout.write(`relationships: ${dump.relationships}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`relate-store.mjs: ${error.message}\n`);
    process.exitCode = 1;
  }
}
