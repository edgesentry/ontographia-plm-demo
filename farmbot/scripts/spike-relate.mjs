#!/usr/bin/env node
// Spike (Issue #27, epic #26): can the FarmBot preset-question Intents that
// Ontographia compiles to Cypher 25 actually run on @relate/relate-wasm?
//
// This script is a throwaway measurement harness, not production generation
// code:
//   1. read the DuckDB extract built by farmbot/scripts/extract.mjs (read-only),
//   2. build a seed graph that follows farmbot/ontology/farmbot.native.yaml,
//      including ancestor labels on concrete nodes for the abstract classes,
//   3. load it into an in-memory RelateDb with UNWIND $rows,
//   4. compile the five preset-question Intents with Ontographia 0.1.9 and run
//      each through db.execute(query, JSON.stringify(params)),
//   5. print one machine-readable JSON result (optionally also written to
//      --out <path>).
//
// Nothing here is wired into CI. The extract is a build output; pass
// --extract <dir>/farmbot.duckdb to read a copy made with `extract.mjs --out`.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DuckDBInstance } from '@duckdb/node-api';
import { loadOntographia } from '@edgesentry/ontographia-wasm';
import initRelate, { RelateDb } from '@relate/relate-wasm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const ONTOLOGY_PATH = resolve(ROOT, 'farmbot/ontology/farmbot.native.yaml');
const DEFAULT_EXTRACT = resolve(ROOT, 'farmbot/dist/farmbot.duckdb');

function packageDir(specifier) {
  return dirname(fileURLToPath(import.meta.resolve(specifier)));
}

function packageVersion(directory) {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version;
}

const ONTOGRAPHIA_DIR = packageDir('@edgesentry/ontographia-wasm');
const RELATE_DIR = packageDir('@relate/relate-wasm');

// Values come from the extract; they are asserted against the extract before
// use so the document never quotes a parameter that the data does not contain.
const PART_IN_ASSEMBLY = 'M5 x 10mm Screw';
const PART_IN_STRUCTURES = 'M5 Flange Locknut';
const CATEGORY_SLUG = 'fasteners-and-hardware';
const UNMATCHED_STATUS = 'unmatched';

// ---------------------------------------------------------------------------
// Extract reading

function toJs(value) {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(toJs);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = toJs(entry);
    return out;
  }
  return value;
}

async function readExtract(path) {
  const instance = await DuckDBInstance.create(path, { access_mode: 'READ_ONLY' });
  try {
    const connection = await instance.connect();
    try {
      const read = async (sql) => toJs((await connection.runAndReadAll(sql)).getRowObjectsJS());
      return {
        part: await read('SELECT * FROM part ORDER BY name'),
        partVariant: await read(
          'SELECT * FROM part_variant ORDER BY part_name, variant_index',
        ),
        bomCategory: await read('SELECT * FROM bom_category ORDER BY slug'),
        assemblyPage: await read('SELECT * FROM assembly_page ORDER BY path'),
        assemblyReference: await read(
          'SELECT * FROM assembly_reference ORDER BY page_path, line_number, display_name',
        ),
        preassemblyPage: await read('SELECT * FROM preassembly_page ORDER BY path'),
        preassemblyReference: await read(
          'SELECT * FROM preassembly_reference ORDER BY page_path, line_number, display_name',
        ),
        packingPage: await read('SELECT * FROM packing_page ORDER BY path'),
        packingItem: await read(
          'SELECT * FROM packing_item ORDER BY page_path, table_index, row_index, child_index',
        ),
        quantityComparison: await read(
          'SELECT * FROM quantity_comparison ORDER BY packing_page, part_name, version',
        ),
        quantityDifference: await read(
          'SELECT * FROM quantity_difference ORDER BY packing_page, part_name, version',
        ),
        unmatchedName: await read('SELECT * FROM unmatched_name ORDER BY display_name'),
      };
    } finally {
      connection.closeSync();
    }
  } finally {
    instance.closeSync();
  }
}

// ---------------------------------------------------------------------------
// Seed construction
//
// Each node carries every ancestor label of its class, so a query can start on
// an abstract class (`Item`, `Structure`, `ManufacturingContainer`,
// `Correspondence`) and still match the concrete nodes.

const LABELS = {
  Part: ['Part', 'Item'],
  PartVariant: ['PartVariant'],
  BomCategory: ['BomCategory'],
  ProductVariant: ['ProductVariant'],
  AssemblyChapter: ['AssemblyChapter', 'Structure'],
  PreAssembly: ['PreAssembly', 'ManufacturingContainer', 'Item', 'Structure'],
  Kit: ['Kit', 'ManufacturingContainer', 'Item', 'Structure'],
  Bag: ['Bag', 'ManufacturingContainer', 'Item', 'Structure'],
  Carton: ['Carton', 'ManufacturingContainer', 'Item', 'Structure'],
  Usage: ['Usage'],
  QuantityComparison: ['QuantityComparison', 'Correspondence'],
  QuantityDifference: ['QuantityDifference', 'QuantityComparison', 'Correspondence'],
  UnmatchedName: ['UnmatchedName', 'Correspondence'],
};

const PRODUCT_VARIANTS = [
  { code: 'standard', label: 'Genesis' },
  { code: 'xl', label: 'Genesis XL' },
];

// Packing pages that carry a packing list become Kit; the main carton page is
// Carton; pallet-stacking.md has no references and is not modelled
// (farmbot/docs/ontology.md, modelling rule 4).
function packingPageClass(path) {
  if (path.endsWith('/main-carton.md')) return 'Carton';
  if (path.endsWith('/pallet-stacking.md')) return null;
  return 'Kit';
}

// The split used by the extract when it joins `candidates` and `source_pages`.
function splitList(value) {
  if (!value) return [];
  return value
    .split(', ')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// Relate rejects an explicit null property; omit absent values instead.
function properties(entries) {
  const out = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

function addNode(nodes, className, id, props) {
  nodes.push({ labels: LABELS[className], properties: { id, ...properties(props) } });
}

function addEdge(edges, type, fromLabel, fromId, toLabel, toId) {
  edges.push({ type, from: { label: fromLabel, id: fromId }, to: { label: toLabel, id: toId } });
}

function buildSeed(extract) {
  const nodes = [];
  const edges = [];

  const partId = new Map();
  for (const part of extract.part) {
    const id = `part:${part.name}`;
    partId.set(part.name, id);
    addNode(nodes, 'Part', id, {
      name: part.name,
      slug: part.slug,
      category_slug: part.category_slug,
      quantity_standard: part.quantity_standard,
      quantity_xl: part.quantity_xl,
      has_variants: part.has_variants,
      market_price: part.market_price,
    });
  }

  for (const [index, variant] of extract.partVariant.entries()) {
    const id = `partvariant:${index}`;
    addNode(nodes, 'PartVariant', id, {
      part_name: variant.part_name,
      variant_index: variant.variant_index,
      label: variant.label,
      length: variant.length,
      internal_part_name: variant.internal_part_name,
      quantity_standard: variant.quantity_standard,
      quantity_xl: variant.quantity_xl,
    });
  }

  const categoryId = new Map();
  for (const category of extract.bomCategory) {
    const id = `category:${category.slug}`;
    categoryId.set(category.slug, id);
    addNode(nodes, 'BomCategory', id, {
      slug: category.slug,
      title: category.title,
      path: category.path,
      part_count: category.part_count,
    });
  }

  const productVariantId = new Map();
  for (const variant of PRODUCT_VARIANTS) {
    const id = `productvariant:${variant.code}`;
    productVariantId.set(variant.code, id);
    addNode(nodes, 'ProductVariant', id, variant);
  }

  const structureId = new Map();
  for (const page of extract.assemblyPage) {
    const id = `chapter:${page.path}`;
    structureId.set(page.path, id);
    addNode(nodes, 'AssemblyChapter', id, {
      path: page.path,
      title: page.title,
      chapter: page.chapter,
      reference_count: page.reference_count,
    });
  }

  for (const page of extract.preassemblyPage) {
    const id = `preassembly:${page.path}`;
    structureId.set(page.path, id);
    addNode(nodes, 'PreAssembly', id, {
      path: page.path,
      title: page.title,
      machine_readable: page.machine_readable,
      machine_readable_reason: page.machine_readable_reason,
      pdf_count: page.pdf_count,
    });
  }

  for (const page of extract.packingPage) {
    const className = packingPageClass(page.path);
    if (!className) continue;
    const id = `container:${page.path}`;
    structureId.set(page.path, id);
    addNode(nodes, className, id, { path: page.path, title: page.title });
  }

  // Bags: one per `pack` row in a packing list, plus one per `Accessory bag
  // BOM` section of a pre-assembly page (farmbot/docs/ontology.md, rule 5).
  // The pack-row bags have no usage lines: the extract records their
  // components as plain text, so they cannot be attached by key.
  const bagForAccessorySection = new Map();
  for (const [index, item] of extract.packingItem.entries()) {
    if (item.item_kind !== 'pack') continue;
    const id = `bag:pack:${index}`;
    addNode(nodes, 'Bag', id, {
      path: item.page_path,
      title: item.page_title,
      section: item.section,
      sub_packing: item.sub_packing,
    });
  }
  const preassemblyTitle = new Map(
    extract.preassemblyPage.map((page) => [page.path, page.title]),
  );
  for (const reference of extract.preassemblyReference) {
    if (reference.section !== 'Accessory bag BOM') continue;
    if (bagForAccessorySection.has(reference.page_path)) continue;
    const id = `bag:accessory:${reference.page_path}`;
    bagForAccessorySection.set(reference.page_path, id);
    addNode(nodes, 'Bag', id, {
      path: reference.page_path,
      title: preassemblyTitle.get(reference.page_path) ?? null,
      section: reference.section,
    });
  }

  // Usage lines. One node per reference row of the three reference tables.
  // A `pack` row is a bag, not a reference line, so it is not a Usage.
  const usages = [];
  for (const [index, reference] of extract.assemblyReference.entries()) {
    usages.push({
      id: `usage:assembly:${index}`,
      owner: structureId.get(reference.page_path),
      resolved_part: reference.resolved_part,
      props: {
        display_name: reference.display_name,
        match_method: reference.match_method,
        line_number: reference.line_number,
        section: null,
        source_kind: 'assembly',
        quantity: null,
        quantity_text: null,
        unit: null,
        sub_packing: null,
      },
    });
  }
  for (const [index, reference] of extract.preassemblyReference.entries()) {
    usages.push({
      id: `usage:preassembly:${index}`,
      owner:
        reference.section === 'Accessory bag BOM'
          ? bagForAccessorySection.get(reference.page_path)
          : structureId.get(reference.page_path),
      resolved_part: reference.resolved_part,
      props: {
        display_name: reference.display_name,
        match_method: reference.match_method,
        line_number: reference.line_number,
        section: reference.section,
        source_kind: reference.source_kind,
        quantity: reference.quantity,
        quantity_text: reference.quantity_text,
        unit: null,
        sub_packing: null,
      },
    });
  }
  for (const [index, item] of extract.packingItem.entries()) {
    if (item.item_kind === 'pack') continue;
    // Usage.quantity and Usage.unit are derived per applicable version, as in
    // farmbot/docs/ontology.md. A row that applies to both versions keeps
    // null here because the value is not one number.
    const standardApplies = item.quantity_standard !== null && item.quantity_standard > 0;
    const xlApplies = item.quantity_xl !== null && item.quantity_xl > 0;
    const single = standardApplies !== xlApplies;
    usages.push({
      id: `usage:packing:${index}`,
      owner: structureId.get(item.page_path),
      resolved_part: item.resolved_part,
      props: {
        display_name: item.display_name,
        match_method: item.match_method,
        line_number: item.row_index,
        section: item.section,
        source_kind: 'packing list',
        quantity: single
          ? standardApplies
            ? item.quantity_standard
            : item.quantity_xl
          : null,
        quantity_text: single
          ? standardApplies
            ? item.quantity_standard_text
            : item.quantity_xl_text
          : null,
        unit: single
          ? standardApplies
            ? item.quantity_standard_unit
            : item.quantity_xl_unit
          : null,
        sub_packing: item.sub_packing,
      },
      version: standardApplies !== xlApplies ? (standardApplies ? 'standard' : 'xl') : null,
    });
  }

  for (const usage of usages) {
    addNode(nodes, 'Usage', usage.id, usage.props);
    if (!usage.owner) {
      throw new Error(`usage ${usage.id} has no owning structure`);
    }
    addEdge(edges, 'HAS_USAGE', 'Structure', usage.owner, 'Usage', usage.id);
    if (usage.resolved_part) {
      const targetId = partId.get(usage.resolved_part);
      if (!targetId) throw new Error(`usage ${usage.id} resolves to unknown part ${usage.resolved_part}`);
      addEdge(edges, 'USES_ITEM', 'Usage', usage.id, 'Item', targetId);
    }
    if (usage.version) {
      addEdge(
        edges,
        'APPLIES_TO',
        'Usage',
        usage.id,
        'ProductVariant',
        productVariantId.get(usage.version),
      );
    }
  }

  // Quantity comparisons. The quantity_difference rows are the same nodes as
  // their comparison rows, with the extra QuantityDifference label and the
  // signed difference property (farmbot/docs/ontology.md).
  const differenceByKey = new Map(
    extract.quantityDifference.map((row) => [
      `${row.packing_page}\u0000${row.part_name}\u0000${row.version}`,
      row,
    ]),
  );
  for (const comparison of extract.quantityComparison) {
    const key = `${comparison.packing_page}\u0000${comparison.part_name}\u0000${comparison.version}`;
    const difference = differenceByKey.get(key);
    const id = `comparison:${comparison.packing_page}:${comparison.part_name}:${comparison.version}`;
    addNode(nodes, difference ? 'QuantityDifference' : 'QuantityComparison', id, {
      packing_quantity: comparison.packing_quantity,
      part_quantity: comparison.part_quantity,
      difference: comparison.difference,
      status: comparison.status,
      note: comparison.note,
      sections: comparison.sections,
      packing_minus_part: difference ? difference.packing_minus_part : null,
    });
    const part = partId.get(comparison.part_name);
    if (!part) throw new Error(`comparison ${id} names unknown part ${comparison.part_name}`);
    addEdge(
      edges,
      'COMPARES_PART',
      'QuantityComparison',
      id,
      'Part',
      part,
    );
    const container = structureId.get(comparison.packing_page);
    if (!container) throw new Error(`comparison ${id} names unknown packing page`);
    addEdge(
      edges,
      'COMPARED_IN',
      'QuantityComparison',
      id,
      'ManufacturingContainer',
      container,
    );
    addEdge(
      edges,
      'FOR_VARIANT',
      'QuantityComparison',
      id,
      'ProductVariant',
      productVariantId.get(comparison.version),
    );
  }

  for (const unmatched of extract.unmatchedName) {
    const id = `unmatched:${unmatched.display_name}`;
    addNode(nodes, 'UnmatchedName', id, {
      display_name: unmatched.display_name,
      normalized_name: unmatched.normalized_name,
      singular_name: unmatched.singular_name,
      reference_count: unmatched.reference_count,
      source_kinds: unmatched.source_kinds,
      status: unmatched.status,
    });
    for (const page of splitList(unmatched.source_pages)) {
      const structure = structureId.get(page);
      if (!structure) throw new Error(`unmatched ${id} names unknown page ${page}`);
      addEdge(edges, 'SEEN_IN', 'UnmatchedName', id, 'Structure', structure);
    }
    for (const candidate of splitList(unmatched.candidates)) {
      const part = partId.get(candidate);
      if (!part) continue;
      addEdge(edges, 'CANDIDATE', 'UnmatchedName', id, 'Part', part);
    }
  }

  // Remaining edges that do not come from a reference row.
  for (const part of extract.part) {
    const category = categoryId.get(part.category_slug);
    if (category) addEdge(edges, 'IN_CATEGORY', 'Part', partId.get(part.name), 'BomCategory', category);
  }
  for (const [index, variant] of extract.partVariant.entries()) {
    const part = partId.get(variant.part_name);
    if (!part) continue;
    addEdge(
      edges,
      'HAS_PART_VARIANT',
      'Part',
      part,
      'PartVariant',
      `partvariant:${index}`,
    );
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Seeding

function groupBy(entries, keyOf) {
  const groups = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return groups;
}

function runWire(db, query, params) {
  return JSON.parse(db.execute(query, params === null ? null : JSON.stringify(params)));
}

function seedDatabase(db, seed) {
  const started = Date.now();
  const nodeGroups = groupBy(seed.nodes, (node) => node.labels.join(':'));
  const nodeCounts = {};
  for (const [labelSet, nodes] of nodeGroups) {
    const labelText = labelSet
      .split(':')
      .map((label) => `:${label}`)
      .join('');
    const wire = runWire(db, `UNWIND $rows AS row CREATE (n${labelText}) SET n += row`, {
      rows: nodes.map((node) => node.properties),
    });
    if (wire.error) throw new Error(`seed nodes ${labelSet}: ${wire.error}`);
    nodeCounts[labelSet] = nodes.length;
  }

  const edgeGroups = groupBy(
    seed.edges,
    (edge) => `${edge.type}|${edge.from.label}|${edge.to.label}`,
  );
  const edgeCounts = {};
  for (const [key, edges] of edgeGroups) {
    const [type] = key.split('|');
    const fromLabel = edges[0].from.label;
    const toLabel = edges[0].to.label;
    const wire = runWire(
      db,
      `UNWIND $rows AS row ` +
        `MATCH (a:${fromLabel} {id: row.from}), (b:${toLabel} {id: row.to}) ` +
        `CREATE (a)-[:${type}]->(b)`,
      { rows: edges.map((edge) => ({ from: edge.from.id, to: edge.to.id })) },
    );
    if (wire.error) throw new Error(`seed edges ${key}: ${wire.error}`);
    edgeCounts[type] = (edgeCounts[type] ?? 0) + edges.length;
  }

  const total = runWire(db, 'MATCH (n) RETURN count(n) AS nodes', null);
  if (total.error) throw new Error(`seed verification: ${total.error}`);
  const totalEdges = runWire(db, 'MATCH ()-[r]->() RETURN count(r) AS edges', null);
  if (totalEdges.error) throw new Error(`seed verification: ${totalEdges.error}`);

  return {
    elapsedMs: Date.now() - started,
    nodes: {
      seeded: seed.nodes.length,
      inEngine: total.rows[0].nodes,
      byLabelSet: nodeCounts,
    },
    edges: {
      seeded: seed.edges.length,
      inEngine: totalEdges.rows[0].edges,
      byType: edgeCounts,
    },
  };
}

// ---------------------------------------------------------------------------
// Intents
//
// Every Intent starts on the relationship's `from_class` and traverses
// `direction: out`. `direction: in` is rejected when the previous node is not
// the relationship's `from_class` (edgesentry/ontographia#164); the workaround
// is to start on the other side and filter on the far alias.

const INTENTS = [
  {
    id: 'Q1',
    question: 'Which parts have a packing-count difference, and by how much?',
    intent: {
      start: { class: 'QuantityDifference', alias: 'd' },
      traverse: [
        {
          relationship: 'COMPARES_PART',
          direction: 'out',
          to: { class: 'Part', alias: 'p' },
        },
      ],
      return: [
        { alias: 'p', property: 'name', as_name: 'part' },
        { alias: 'd', property: 'packing_minus_part', as_name: 'packing_minus_part' },
      ],
      limit: 20,
    },
  },
  {
    id: 'Q2',
    question: 'Which assembly chapters use a given part?',
    intent: {
      start: { class: 'AssemblyChapter', alias: 'a' },
      traverse: [
        { relationship: 'HAS_USAGE', direction: 'out', to: { class: 'Usage', alias: 'u' } },
        { relationship: 'USES_ITEM', direction: 'out', to: { class: 'Part', alias: 'p' } },
      ],
      filter: [{ alias: 'p', property: 'name', op: 'eq', value: PART_IN_ASSEMBLY }],
      return: [
        { alias: 'a', property: 'chapter', as_name: 'chapter' },
        { alias: 'a', property: 'path', as_name: 'chapter_path' },
        { alias: 'p', property: 'name', as_name: 'part' },
      ],
      limit: 20,
    },
  },
  {
    id: 'Q3',
    question: 'Which structures (any kind) use a given part? Starts on abstract Structure.',
    intent: {
      start: { class: 'Structure', alias: 's' },
      traverse: [
        { relationship: 'HAS_USAGE', direction: 'out', to: { class: 'Usage', alias: 'u' } },
        { relationship: 'USES_ITEM', direction: 'out', to: { class: 'Part', alias: 'p' } },
      ],
      filter: [{ alias: 'p', property: 'name', op: 'eq', value: PART_IN_STRUCTURES }],
      return: [
        { alias: 's', property: 'path', as_name: 'structure' },
        { alias: 'p', property: 'name', as_name: 'part' },
      ],
      limit: 50,
    },
  },
  {
    id: 'Q4',
    question: 'Which kits contain parts from a given BOM category?',
    intent: {
      start: { class: 'Kit', alias: 'k' },
      traverse: [
        { relationship: 'HAS_USAGE', direction: 'out', to: { class: 'Usage', alias: 'u' } },
        { relationship: 'USES_ITEM', direction: 'out', to: { class: 'Part', alias: 'p' } },
        {
          relationship: 'IN_CATEGORY',
          direction: 'out',
          to: { class: 'BomCategory', alias: 'c' },
        },
      ],
      filter: [{ alias: 'c', property: 'slug', op: 'eq', value: CATEGORY_SLUG }],
      return: [
        { alias: 'k', property: 'path', as_name: 'kit' },
        { alias: 'c', property: 'slug', as_name: 'category' },
        { alias: 'p', property: 'name', as_name: 'part' },
      ],
      limit: 50,
    },
  },
  {
    id: 'Q5',
    question: 'Which pages reference an unmatched display name?',
    intent: {
      start: { class: 'UnmatchedName', alias: 'n' },
      traverse: [
        { relationship: 'SEEN_IN', direction: 'out', to: { class: 'Structure', alias: 's' } },
      ],
      filter: [{ alias: 'n', property: 'status', op: 'eq', value: UNMATCHED_STATUS }],
      return: [
        { alias: 'n', property: 'display_name', as_name: 'display_name' },
        { alias: 's', property: 'path', as_name: 'page' },
      ],
      limit: 50,
    },
  },
];

const PROBES = [
  {
    id: 'P1',
    question: 'Does a query that returns a whole node (not only properties) work?',
    intent: {
      start: { class: 'Part', alias: 'p' },
      return: [{ alias: 'p' }],
      limit: 3,
    },
  },
  {
    id: 'P2',
    question:
      'Is `direction: in` from the to_class side rejected at compile time? (#164 evidence)',
    intent: {
      start: { class: 'BomCategory', alias: 'c' },
      traverse: [
        { relationship: 'IN_CATEGORY', direction: 'in', to: { class: 'Part', alias: 'p' } },
      ],
      return: [{ alias: 'p', property: 'name', as_name: 'part' }],
      limit: 5,
    },
  },
  {
    id: 'P3',
    question:
      'Is a "category -> parts" question expressible as start-on-Part, traverse out, filter the far alias? (#164 workaround)',
    intent: {
      start: { class: 'Part', alias: 'p' },
      traverse: [
        { relationship: 'IN_CATEGORY', direction: 'out', to: { class: 'BomCategory', alias: 'c' } },
      ],
      filter: [{ alias: 'c', property: 'slug', op: 'eq', value: CATEGORY_SLUG }],
      return: [{ alias: 'p', property: 'name', as_name: 'part' }],
      limit: 5,
    },
  },
];

// ---------------------------------------------------------------------------
// Main

function parseArguments(argv) {
  const options = { extract: DEFAULT_EXTRACT, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === '--extract' || argument === '--out') {
      const value = argv[i + 1];
      if (!value) throw new Error(`${argument} requires a path`);
      if (argument === '--extract') options.extract = resolve(value);
      else options.out = resolve(value);
      i += 1;
    } else if (argument.startsWith('--extract=')) {
      options.extract = resolve(argument.slice('--extract='.length));
    } else if (argument.startsWith('--out=')) {
      options.out = resolve(argument.slice('--out='.length));
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function assertParamAvailable(rows, column, value, label) {
  if (!rows.some((row) => row[column] === value)) {
    throw new Error(`spike parameter ${label}=${JSON.stringify(value)} is not in the extract`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const ontologyText = readFileSync(ONTOLOGY_PATH, 'utf8');
  const extract = await readExtract(options.extract);

  // Every parameter used by Q2-Q5 must be a value the extract actually holds.
  assertParamAvailable(extract.assemblyReference, 'resolved_part', PART_IN_ASSEMBLY, 'Q2.part');
  assertParamAvailable(extract.preassemblyReference, 'resolved_part', PART_IN_STRUCTURES, 'Q3.part');
  assertParamAvailable(extract.packingItem, 'resolved_part', PART_IN_STRUCTURES, 'Q3.part');
  assertParamAvailable(extract.bomCategory, 'slug', CATEGORY_SLUG, 'Q4.category');
  assertParamAvailable(extract.unmatchedName, 'status', UNMATCHED_STATUS, 'Q5.status');

  const seed = buildSeed(extract);
  const seedJsonBytes = Buffer.byteLength(JSON.stringify(seed), 'utf8');

  const ontographia = await loadOntographia(
    readFileSync(join(ONTOGRAPHIA_DIR, 'ontographia_wasm.wasm')),
  );
  await initRelate({ module_or_path: readFileSync(join(RELATE_DIR, 'relate_bg.wasm')) });
  const db = new RelateDb();

  const seedResult = seedDatabase(db, seed);

  const labelCounts = {};
  for (const labels of new Set(seed.nodes.map((node) => node.labels.join(':')))) {
    for (const label of labels.split(':')) {
      if (labelCounts[label] !== undefined) continue;
      const wire = runWire(db, `MATCH (n:${label}) RETURN count(n) AS nodes`, null);
      if (wire.error) throw new Error(`label count ${label}: ${wire.error}`);
      labelCounts[label] = wire.rows[0].nodes;
    }
  }

  const runIntent = ({ id, question, intent }, position) => {
    const entry = { id, position, question, intent, cypher: null, params: null };
    try {
      const built = ontographia.buildCypher(ontologyText, intent, {
        ontologyPathHint: 'farmbot.native.yaml',
      });
      entry.cypher = built.query;
      entry.params = built.params;
    } catch (error) {
      entry.compiled = false;
      entry.accepted = false;
      entry.rowCount = null;
      entry.error = null;
      entry.compileError = error.message;
      return entry;
    }
    entry.compiled = true;
    try {
      const wire = runWire(db, entry.cypher, entry.params);
      entry.accepted = wire.error === null;
      entry.rowCount = wire.error === null ? wire.rows.length : null;
      entry.error = wire.error;
      entry.compileError = null;
      entry.rows = wire.error === null ? wire.rows : [];
      entry.elapsedMs = wire.elapsed_ms ?? null;
    } catch (error) {
      entry.accepted = false;
      entry.rowCount = null;
      entry.error = `threw: ${error.message}`;
      entry.compileError = null;
    }
    return entry;
  };

  const queries = INTENTS.map(runIntent);
  const probes = PROBES.map(runIntent);

  const result = {
    spike: 'farmbot-relate-wasm-compatibility',
    issue: 27,
    generatedBy: 'farmbot/scripts/spike-relate.mjs',
    versions: {
      node: process.version,
      ontographia: packageVersion(ONTOGRAPHIA_DIR),
      relate: packageVersion(RELATE_DIR),
    },
    extract: {
      path: options.extract,
      tables: Object.fromEntries(
        Object.entries(extract).map(([name, rows]) => [name, rows.length]),
      ),
    },
    parameters: {
      'Q2.part': PART_IN_ASSEMBLY,
      'Q3.part': PART_IN_STRUCTURES,
      'Q4.category': CATEGORY_SLUG,
      'Q5.status': UNMATCHED_STATUS,
    },
    seed: {
      jsonBytes: seedJsonBytes,
      ...seedResult,
      labels: labelCounts,
    },
    queries,
    probes,
  };

  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out) {
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, json, 'utf8');
    process.stderr.write(`spike result written to ${options.out}\n`);
  }
  process.stdout.write(json);
}

main().catch((error) => {
  process.stderr.write(`relate spike failed: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
