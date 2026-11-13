import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DuckDBInstance } from '@duckdb/node-api';
import { parse } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const ONTOLOGY_PATH = resolve(ROOT, 'farmbot/ontology/farmbot.native.yaml');
const DOC_PATH = resolve(ROOT, 'farmbot/docs/ontology.md');
const DB_PATH = resolve(ROOT, 'farmbot/dist/farmbot.duckdb');
const EXTRACT = resolve(ROOT, 'farmbot/scripts/extract.mjs');
const WASM_PATH = resolve(
  ROOT,
  'node_modules/@edgesentry/ontographia-wasm/ontographia_wasm.wasm',
);

const NAMESPACE = 'http://example.org/farmbot-demo#';
const TOP_LEVEL_KEYS = ['classes', 'namespaces', 'properties', 'relationships'];
const CLASS_KEYS = ['name', 'super_classes', 'description'];
const RELATIONSHIP_KEYS = ['name', 'from_class', 'to_class', 'direction'];
const PROPERTY_KEYS = ['name', 'owner_class', 'datatype', 'required', 'unique'];
const DATATYPES = new Set(['string', 'integer', 'float', 'boolean', 'date', 'datetime', 'iri']);
const REQUIRED_CLASSES = [
  'Part',
  'AssemblyChapter',
  'PreAssembly',
  'Kit',
  'Bag',
  'Carton',
  'ProductVariant',
  'Usage',
  'QuantityComparison',
  'QuantityDifference',
  'UnmatchedName',
];

// Class -> the extract tables its properties are allowed to come from.
const SOURCE_TABLES = {
  Part: ['part'],
  PartVariant: ['part_variant'],
  BomCategory: ['bom_category'],
  Structure: ['assembly_page', 'preassembly_page', 'packing_page'],
  AssemblyChapter: ['assembly_page'],
  PreAssembly: ['preassembly_page'],
  Kit: ['packing_page'],
  Carton: ['packing_page'],
  Bag: ['packing_item', 'preassembly_reference'],
  Usage: ['assembly_reference', 'preassembly_reference', 'packing_item'],
  QuantityComparison: ['quantity_comparison'],
  QuantityDifference: ['quantity_difference'],
  UnmatchedName: ['unmatched_name'],
};

// Ontology-level names documented in farmbot/docs/ontology.md as derived
// rather than read from one column.
const DERIVED_PROPERTIES = new Set([
  'ProductVariant.code',
  'ProductVariant.label',
  'Usage.quantity',
  'Usage.unit',
]);

// Strings that would mean the FarmBot ontology or its document leaked into
// the unrelated product-structure demo.
const FORBIDDEN_STRINGS = ['plm.native', 'vendor/', 'deskfan', 'desk-fan', 'src/'];

const ontologyText = readFileSync(ONTOLOGY_PATH, 'utf8');
const ontology = parse(ontologyText);

function classNames() {
  return new Set(ontology.classes.map((entry) => entry.name));
}

function keysOf(value) {
  return Object.keys(value).sort();
}

test('the ontology declares a unique, fully referenced class and relationship graph', () => {
  assert.deepEqual(keysOf(ontology), TOP_LEVEL_KEYS);
  assert.deepEqual(Object.keys(ontology.namespaces), ['fb']);
  assert.equal(ontology.namespaces.fb, NAMESPACE);

  const classes = new Set();
  for (const entry of ontology.classes) {
    assert.equal(typeof entry.name, 'string');
    assert.ok(entry.name.length > 0, 'class name must not be empty');
    assert.deepEqual(keysOf(entry).filter((key) => !CLASS_KEYS.includes(key)), []);
    assert.ok(!classes.has(entry.name), `duplicate class ${entry.name}`);
    classes.add(entry.name);
    if (entry.description !== undefined) {
      assert.equal(typeof entry.description, 'string');
      assert.ok(entry.description.trim().length > 0, `empty description on ${entry.name}`);
    }
  }

  for (const entry of ontology.classes) {
    for (const parent of entry.super_classes ?? []) {
      assert.ok(classes.has(parent), `${entry.name} extends undeclared class ${parent}`);
    }
  }

  const relationships = new Set();
  for (const entry of ontology.relationships) {
    assert.deepEqual(keysOf(entry), [...RELATIONSHIP_KEYS].sort());
    assert.ok(classes.has(entry.from_class), `${entry.name} from undeclared class ${entry.from_class}`);
    assert.ok(classes.has(entry.to_class), `${entry.name} to undeclared class ${entry.to_class}`);
    assert.equal(entry.direction, 'out', `${entry.name} must be direction out`);
    assert.ok(!relationships.has(entry.name), `duplicate relationship ${entry.name}`);
    relationships.add(entry.name);
  }

  const propertyPairs = new Set();
  for (const entry of ontology.properties) {
    assert.deepEqual(
      keysOf(entry).filter((key) => !PROPERTY_KEYS.includes(key)),
      [],
      `${entry.name} has an unknown property key`,
    );
    assert.equal(typeof entry.name, 'string');
    assert.ok(classes.has(entry.owner_class), `${entry.name} owned by undeclared class`);
    assert.ok(DATATYPES.has(entry.datatype), `${entry.owner_class}.${entry.name} datatype ${entry.datatype}`);
    for (const flag of ['required', 'unique']) {
      if (entry[flag] !== undefined) assert.equal(typeof entry[flag], 'boolean');
    }
    const pair = `${entry.owner_class}.${entry.name}`;
    assert.ok(!propertyPairs.has(pair), `duplicate property ${pair}`);
    propertyPairs.add(pair);
  }

  for (const name of REQUIRED_CLASSES) {
    assert.ok(classes.has(name), `missing required class ${name}`);
  }

  const quantityDifference = ontology.classes.find((entry) => entry.name === 'QuantityDifference');
  assert.deepEqual(quantityDifference.super_classes, ['QuantityComparison']);
});

test('the ontology and its document stay independent of the other demo', () => {
  const doc = readFileSync(DOC_PATH, 'utf8');
  for (const forbidden of FORBIDDEN_STRINGS) {
    for (const [label, text] of [
      ['ontology', ontologyText],
      ['document', doc],
    ]) {
      assert.ok(
        !text.includes(forbidden),
        `${label} must not contain ${forbidden}`,
      );
    }
  }
});

async function readRowsFrom(dbPath, sql) {
  const instance = await DuckDBInstance.create(dbPath, { access_mode: 'READ_ONLY' });
  try {
    const connection = await instance.connect();
    try {
      return await (await connection.runAndReadAll(sql)).getRowObjectsJS();
    } finally {
      connection.closeSync();
    }
  } finally {
    instance.closeSync();
  }
}

async function buildPrivateExtract(sql) {
  // The other FarmBot test file rebuilds the shared extract in its own
  // process, and the test runner executes files in parallel. When the shared
  // file is not available yet, build the same extract into a private
  // directory instead of fighting over one DuckDB file lock.
  const directory = mkdtempSync(join(tmpdir(), 'farmbot-ontology-'));
  try {
    const built = spawnSync(process.execPath, [EXTRACT, '--out', directory], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(built.status, 0, `extract failed:\n${built.stderr}\n${built.stdout}`);
    return await readRowsFrom(join(directory, 'farmbot.duckdb'), sql);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function queryRows(sql) {
  // Prefer the shared extract. Reads are retried because a parallel test file
  // may be rebuilding it, which briefly removes and locks the file.
  let lastError;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (!existsSync(DB_PATH)) {
      await delay(250);
      continue;
    }
    try {
      return await readRowsFrom(DB_PATH, sql);
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  return buildPrivateExtract(sql).catch((error) => {
    throw lastError ?? error;
  });
}

test('every modelled property is a real extract column', async () => {
  const rows = await queryRows(
    'SELECT table_name, column_name FROM information_schema.columns ORDER BY table_name, column_name',
  );
  const columnsByTable = new Map();
  for (const row of rows) {
    if (!columnsByTable.has(row.table_name)) columnsByTable.set(row.table_name, new Set());
    columnsByTable.get(row.table_name).add(row.column_name);
  }

  const classes = classNames();
  for (const entry of ontology.properties) {
    const pair = `${entry.owner_class}.${entry.name}`;
    if (DERIVED_PROPERTIES.has(pair)) continue;
    const tables = SOURCE_TABLES[entry.owner_class];
    assert.ok(
      tables,
      `${pair} is owned by ${entry.owner_class}, which has no declared source table`,
    );
    const found = tables.filter((table) => {
      const columns = columnsByTable.get(table);
      assert.ok(columns, `source table ${table} is missing from the extract`);
      return columns.has(entry.name);
    });
    assert.ok(
      found.length > 0,
      `${pair} is not a column of any of ${tables.join(', ')}`,
    );
  }

  for (const pair of DERIVED_PROPERTIES) {
    const [owner] = pair.split('.');
    assert.ok(classes.has(owner), `derived property ${pair} names an undeclared class`);
  }
});

const intents = {
  kitUsage: {
    start: { class: 'Kit', alias: 'k' },
    traverse: [
      { relationship: 'HAS_USAGE', direction: 'out', to: { class: 'Usage', alias: 'u' } },
      { relationship: 'USES_ITEM', direction: 'out', to: { class: 'Part', alias: 'p' } },
    ],
    filter: [{ alias: 'p', property: 'name', op: 'eq', value: 'M5 x 10mm Screw' }],
    return: [
      { alias: 'k', property: 'path', as_name: 'kit' },
      { alias: 'u', property: 'quantity', as_name: 'quantity' },
    ],
    limit: 20,
  },
  quantityDifference: {
    start: { class: 'QuantityDifference', alias: 'd' },
    traverse: [
      { relationship: 'COMPARES_PART', direction: 'out', to: { class: 'Part', alias: 'p' } },
    ],
    return: [
      { alias: 'p', property: 'name', as_name: 'part' },
      { alias: 'd', property: 'packing_minus_part', as_name: 'difference' },
    ],
    limit: 20,
  },
};

const enginePromise = (await import('@edgesentry/ontographia-wasm')).loadOntographia(
  readFileSync(WASM_PATH),
);

function build(intent) {
  return enginePromise.then((og) =>
    og.buildCypher(ontologyText, intent, { ontologyPathHint: 'farmbot.native.yaml' }),
  );
}

test('a kit-to-part intent compiles to parameter-bound Cypher', async () => {
  const { query, params } = await build(intents.kitUsage);
  assert.ok(
    query.includes('MATCH (k:Kit)-[:HAS_USAGE]->(u:Usage)-[:USES_ITEM]->(p:Part)'),
    query,
  );
  assert.match(query, /k\.path AS kit/);
  assert.match(query, /u\.quantity AS quantity/);
  assert.match(query, /LIMIT 20/);

  const bound = Object.entries(params).filter(([, value]) => value === 'M5 x 10mm Screw');
  assert.equal(bound.length, 1, JSON.stringify(params));
  assert.ok(query.includes(`$${bound[0][0]}`), query);
});

test('a quantity-difference intent compiles to Cypher', async () => {
  const { query } = await build(intents.quantityDifference);
  assert.ok(
    query.includes('MATCH (d:QuantityDifference)-[:COMPARES_PART]->(p:Part)'),
    query,
  );
  assert.match(query, /p\.name AS part/);
  assert.match(query, /d\.packing_minus_part AS difference/);
});

test('a filter on an unknown property is rejected', async () => {
  const intent = {
    start: { class: 'Part', alias: 'p' },
    filter: [{ alias: 'p', property: 'not_a_column', op: 'eq', value: 'x' }],
    return: [{ alias: 'p', property: 'name', as_name: 'name' }],
    limit: 1,
  };
  await assert.rejects(build(intent), /unknown property/i);
});
