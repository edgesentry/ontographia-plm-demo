#!/usr/bin/env node
// Build a deterministic graph seed from the FarmBot DuckDB extract and the
// FarmBot ontology, driven by a recipe in farmbot/recipes/.
//
// Node ids are stable and derived only from extract keys:
//   part:<name>
//   partvariant:<part_name>@<variant_index>
//   category:<slug>
//   productvariant:<code>
//   chapter:<path>
//   preassembly:<path>
//   container:<path>                     Kit and Carton page containers
//   bag:pack:<page>@<table>/<row>/<child>  Bag for a packing_item pack row
//   bag:accessory:<page>                   Bag for an Accessory bag BOM section
//   usage:assembly:<page>@<ordinal>        Ordinal within the sorted page rows
//   usage:preassembly:<page>@<line_number>
//   usage:packing:<page>@<table>/<row>/<child>
//   comparison:<packing_page>#<part_name>#<version>
//   unmatched:<display_name>
//
// The seed is canonical: object keys are sorted, nodes are sorted by id, and
// edges are sorted by type, source id and target id. Every label, property and
// relationship type is checked against the ontology before anything is
// written.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import { parse } from 'yaml';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FARMBOT_DIR = resolve(SCRIPT_DIR, '..');
const ROOT = resolve(FARMBOT_DIR, '..');

export const GRAPH_FORMAT = 'farmbot-graph-v1';
export const DEFAULT_EXTRACT = resolve(FARMBOT_DIR, 'dist/farmbot.duckdb');
export const DEFAULT_ONTOLOGY = resolve(FARMBOT_DIR, 'ontology/farmbot.native.yaml');
export const RECIPE_DIR = resolve(FARMBOT_DIR, 'recipes');
export const DEFAULT_OUT = resolve(FARMBOT_DIR, 'dist');

const TABLES = [
  'part',
  'part_variant',
  'bom_category',
  'assembly_page',
  'assembly_reference',
  'preassembly_page',
  'preassembly_reference',
  'packing_page',
  'packing_item',
  'quantity_comparison',
  'quantity_difference',
  'unmatched_name',
];

const PRODUCT_VARIANTS = [
  { code: 'standard', label: 'Genesis' },
  { code: 'xl', label: 'Genesis XL' },
];

// The part-scoped recipe keeps these node classes and traverses them in a
// fixed direction: a part reaches its category, variants, usages and
// comparisons; a usage reaches its owning structure and product variant; a
// structure reaches all of its usage lines; a comparison reaches its part,
// container and product variant. A different Part is never admitted, and the
// traversal never runs backwards from a container into another part's
// comparisons.
const PART_SCOPE_LABELS = new Set([
  'Part',
  'PartVariant',
  'BomCategory',
  'ProductVariant',
  'Usage',
  'Structure',
  'QuantityComparison',
]);

const PART_STEPS = {
  Part: {
    out: null,
    in: ['USES_ITEM', 'COMPARES_PART'],
  },
  Usage: {
    out: ['USES_ITEM', 'APPLIES_TO'],
    in: ['HAS_USAGE'],
  },
  Structure: {
    out: ['HAS_USAGE'],
    in: [],
  },
  QuantityComparison: {
    out: ['COMPARES_PART', 'COMPARED_IN', 'FOR_VARIANT'],
    in: [],
  },
};

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizedValue(value) {
  return typeof value === 'bigint' ? Number(value) : value;
}

function rowKey(row) {
  const entries = Object.keys(row)
    .sort(compareStrings)
    .map((key) => [key, normalizedValue(row[key])]);
  return JSON.stringify(entries);
}

function sortRows(rows) {
  return rows
    .map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, normalizedValue(value)]),
      ),
    )
    .sort((left, right) => compareStrings(rowKey(left), rowKey(right)));
}

// Absent values are omitted so the seed stays compact and stable across
// extract rebuilds; false and zero are real values and are kept.
function compact(properties) {
  const out = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === null || value === undefined) continue;
    out[key] = normalizedValue(value);
  }
  return out;
}

function splitList(value) {
  if (!value) return [];
  return value
    .split(', ')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Ontology

export function loadOntology(ontologyPath) {
  const document = parse(readFileSync(ontologyPath, 'utf8'));
  const classNames = new Set();
  const superClasses = new Map();

  for (const entry of document.classes ?? []) {
    if (typeof entry.name !== 'string' || entry.name.length === 0) {
      throw new Error('ontology class without a name');
    }
    if (classNames.has(entry.name)) {
      throw new Error(`duplicate ontology class ${entry.name}`);
    }
    classNames.add(entry.name);
    superClasses.set(
      entry.name,
      (entry.super_classes ?? []).map((parent) => {
        if (typeof parent !== 'string') {
          throw new Error(`ontology class ${entry.name} has a non-string superclass`);
        }
        return parent;
      }),
    );
  }

  const relationships = new Map();
  for (const entry of document.relationships ?? []) {
    if (typeof entry.name !== 'string' || entry.name.length === 0) {
      throw new Error('ontology relationship without a name');
    }
    if (relationships.has(entry.name)) {
      throw new Error(`duplicate ontology relationship ${entry.name}`);
    }
    if (!classNames.has(entry.from_class)) {
      throw new Error(
        `ontology relationship ${entry.name} names undeclared class ${entry.from_class}`,
      );
    }
    if (!classNames.has(entry.to_class)) {
      throw new Error(
        `ontology relationship ${entry.name} names undeclared class ${entry.to_class}`,
      );
    }
    relationships.set(entry.name, {
      from: entry.from_class,
      to: entry.to_class,
    });
  }

  for (const [name, parents] of superClasses) {
    for (const parent of parents) {
      if (!classNames.has(parent)) {
        throw new Error(`ontology class ${name} extends undeclared class ${parent}`);
      }
    }
  }

  const properties = new Map();
  for (const entry of document.properties ?? []) {
    if (!classNames.has(entry.owner_class)) {
      throw new Error(
        `ontology property ${entry.name} is owned by undeclared class ${entry.owner_class}`,
      );
    }
    if (!properties.has(entry.owner_class)) properties.set(entry.owner_class, new Set());
    const names = properties.get(entry.owner_class);
    if (names.has(entry.name)) {
      throw new Error(`duplicate ontology property ${entry.owner_class}.${entry.name}`);
    }
    names.add(entry.name);
  }

  const labelCache = new Map();
  function labelsFor(className) {
    if (labelCache.has(className)) return labelCache.get(className);
    if (!classNames.has(className)) {
      throw new Error(`cannot label a node with undeclared class ${className}`);
    }
    const labels = [];
    const seen = new Set();
    const walk = (name) => {
      if (seen.has(name)) return;
      seen.add(name);
      labels.push(name);
      for (const parent of superClasses.get(name) ?? []) walk(parent);
    };
    walk(className);
    labelCache.set(className, labels);
    return labels;
  }

  function ancestorsOf(className) {
    return labelsFor(className);
  }

  return { classNames, superClasses, relationships, properties, labelsFor, ancestorsOf };
}

// ---------------------------------------------------------------------------
// Validation

function nodeLabelList(node, index) {
  if (!Array.isArray(node.labels) || node.labels.length === 0) {
    throw new Error(`node ${index} has no labels`);
  }
  return node.labels;
}

export function validateSeed(seed, ontology) {
  if (seed === null || typeof seed !== 'object') {
    throw new Error('seed must be an object');
  }
  if (!Array.isArray(seed.nodes) || !Array.isArray(seed.edges)) {
    throw new Error('seed must have nodes and edges arrays');
  }

  const nodes = new Map();
  for (const [index, node] of seed.nodes.entries()) {
    if (node === null || typeof node !== 'object') {
      throw new Error(`node ${index} is not an object`);
    }
    if (typeof node.id !== 'string' || node.id.length === 0) {
      throw new Error(`node ${index} has no id`);
    }
    if (nodes.has(node.id)) throw new Error(`duplicate node id ${node.id}`);

    const labels = nodeLabelList(node, index);
    for (const label of labels) {
      if (!ontology.classNames.has(label)) {
        throw new Error(`node ${node.id} has undeclared label ${label}`);
      }
    }

    const expected = new Set(ontology.ancestorsOf(labels[0]));
    for (const label of labels) {
      if (!expected.has(label)) {
        throw new Error(`node ${node.id} has label ${label} outside its class hierarchy`);
      }
    }
    for (const label of expected) {
      if (!labels.includes(label)) {
        throw new Error(`node ${node.id} is missing ancestor label ${label}`);
      }
    }

    const properties = node.properties ?? {};
    if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
      throw new Error(`node ${node.id} properties must be an object`);
    }
    for (const name of Object.keys(properties)) {
      const declared = labels.some((label) => ontology.properties.get(label)?.has(name));
      if (!declared) {
        throw new Error(`node ${node.id} has undeclared property ${name}`);
      }
    }

    nodes.set(node.id, node);
  }

  const edges = new Set();
  for (const [index, edge] of seed.edges.entries()) {
    if (edge === null || typeof edge !== 'object') {
      throw new Error(`edge ${index} is not an object`);
    }
    if (typeof edge.type !== 'string' || edge.type.length === 0) {
      throw new Error(`edge ${index} has no type`);
    }
    const declaration = ontology.relationships.get(edge.type);
    if (!declaration) {
      throw new Error(`undeclared relationship type ${edge.type}`);
    }
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from) throw new Error(`edge ${edge.type} starts at unknown node ${edge.from}`);
    if (!to) throw new Error(`edge ${edge.type} ends at unknown node ${edge.to}`);
    if (!from.labels.includes(declaration.from)) {
      throw new Error(
        `edge ${edge.type} starts at ${edge.from}, which is not a ${declaration.from}`,
      );
    }
    if (!to.labels.includes(declaration.to)) {
      throw new Error(
        `edge ${edge.type} ends at ${edge.to}, which is not a ${declaration.to}`,
      );
    }
    const key = `${edge.type}\u0000${edge.from}\u0000${edge.to}`;
    if (edges.has(key)) {
      throw new Error(`duplicate edge ${edge.type} ${edge.from} -> ${edge.to}`);
    }
    edges.add(key);
  }

  return seed;
}

// ---------------------------------------------------------------------------
// Extract tables

export async function readExtract(extractPath) {
  if (!existsSync(extractPath)) {
    throw new Error(`extract not found: ${extractPath}`);
  }
  const instance = await DuckDBInstance.create(extractPath, {
    access_mode: 'READ_ONLY',
  });
  try {
    const connection = await instance.connect();
    try {
      const tables = {};
      for (const table of TABLES) {
        const reader = await connection.runAndReadAll(`SELECT * FROM ${table}`);
        tables[table] = sortRows(reader.getRowObjectsJS());
      }
      return tables;
    } finally {
      connection.closeSync();
    }
  } finally {
    instance.closeSync();
  }
}

// ---------------------------------------------------------------------------
// Full graph

function packingPageClass(path) {
  if (path.endsWith('/main-carton.md')) return 'Carton';
  if (path.endsWith('/pallet-stacking.md')) return null;
  return 'Kit';
}

export function buildFullGraph(tables, ontology) {
  const nodes = [];
  const edges = [];
  const nodeIds = new Set();
  const edgeKeys = new Set();

  const addNode = (className, id, properties) => {
    if (nodeIds.has(id)) throw new Error(`duplicate node id ${id}`);
    nodeIds.add(id);
    nodes.push({
      id,
      labels: ontology.labelsFor(className),
      properties: compact(properties),
    });
  };

  const addEdge = (type, from, to) => {
    const key = `${type}\u0000${from}\u0000${to}`;
    if (edgeKeys.has(key)) return;
    if (!nodeIds.has(from)) throw new Error(`edge ${type} starts at unknown node ${from}`);
    if (!nodeIds.has(to)) throw new Error(`edge ${type} ends at unknown node ${to}`);
    edgeKeys.add(key);
    edges.push({ type, from, to });
  };

  // Parts, categories and variants.
  const partId = new Map();
  for (const part of tables.part) {
    const id = `part:${part.name}`;
    partId.set(part.name, id);
    addNode('Part', id, {
      name: part.name,
      slug: part.slug,
      category_slug: part.category_slug,
      quantity_standard: part.quantity_standard,
      quantity_xl: part.quantity_xl,
      has_variants: part.has_variants,
      market_price: part.market_price,
    });
  }

  const categoryId = new Map();
  for (const category of tables.bom_category) {
    const id = `category:${category.slug}`;
    categoryId.set(category.slug, id);
    addNode('BomCategory', id, {
      slug: category.slug,
      title: category.title,
      path: category.path,
      part_count: category.part_count,
    });
  }

  for (const variant of tables.part_variant) {
    const id = `partvariant:${variant.part_name}@${variant.variant_index}`;
    addNode('PartVariant', id, {
      part_name: variant.part_name,
      variant_index: variant.variant_index,
      label: variant.label,
      length: variant.length,
      internal_part_name: variant.internal_part_name,
      quantity_standard: variant.quantity_standard,
      quantity_xl: variant.quantity_xl,
    });
    const part = partId.get(variant.part_name);
    if (!part) {
      throw new Error(`part variant names unknown part ${variant.part_name}`);
    }
    addEdge('HAS_PART_VARIANT', part, id);
  }

  const productVariantId = new Map();
  for (const variant of PRODUCT_VARIANTS) {
    const id = `productvariant:${variant.code}`;
    productVariantId.set(variant.code, id);
    addNode('ProductVariant', id, variant);
  }

  // Structures: assembly chapters, pre-assemblies, kits and the carton.
  const structureId = new Map();
  for (const page of tables.assembly_page) {
    const id = `chapter:${page.path}`;
    structureId.set(page.path, id);
    addNode('AssemblyChapter', id, {
      path: page.path,
      title: page.title,
      chapter: page.chapter,
      reference_count: page.reference_count,
    });
  }

  for (const page of tables.preassembly_page) {
    const id = `preassembly:${page.path}`;
    structureId.set(page.path, id);
    addNode('PreAssembly', id, {
      path: page.path,
      title: page.title,
      machine_readable: page.machine_readable,
      machine_readable_reason: page.machine_readable_reason,
      pdf_count: page.pdf_count,
    });
  }

  if (tables.packing_page.length === 0) {
    throw new Error('packing_page is empty; no containers can be built');
  }
  const preassemblyTitle = new Map(
    tables.preassembly_page.map((page) => [page.path, page.title]),
  );
  for (const page of tables.packing_page) {
    const className = packingPageClass(page.path);
    if (!className) continue;
    const id = `container:${page.path}`;
    structureId.set(page.path, id);
    addNode(className, id, { path: page.path, title: page.title });
  }

  // Bags: one per pack row and one per Accessory bag BOM section.
  const accessoryBagId = new Map();
  for (const item of tables.packing_item) {
    if (item.item_kind !== 'pack') continue;
    const id = `bag:pack:${item.page_path}@${item.table_index}/${item.row_index}/${item.child_index}`;
    addNode('Bag', id, {
      path: item.page_path,
      title: item.page_title,
    });
  }
  for (const reference of tables.preassembly_reference) {
    if (reference.section !== 'Accessory bag BOM') continue;
    if (accessoryBagId.has(reference.page_path)) continue;
    const id = `bag:accessory:${reference.page_path}`;
    accessoryBagId.set(reference.page_path, id);
    addNode('Bag', id, {
      path: reference.page_path,
      title: preassemblyTitle.get(reference.page_path),
    });
  }

  // Every reference row is a Usage node. A pack row is both a Usage line and
  // the source of a Bag node; the trait is recorded on the Bag, not repeated
  // on the usage line.
  const addUsage = (id, ownerId, properties, resolvedPart, version) => {
    addNode('Usage', id, properties);
    if (!ownerId) throw new Error(`usage ${id} has no owning structure`);
    addEdge('HAS_USAGE', ownerId, id);
    if (resolvedPart) {
      const part = partId.get(resolvedPart);
      if (!part) throw new Error(`usage ${id} resolves to unknown part ${resolvedPart}`);
      addEdge('USES_ITEM', id, part);
    }
    if (version) {
      const variant = productVariantId.get(version);
      if (!variant) throw new Error(`usage ${id} names unknown version ${version}`);
      addEdge('APPLIES_TO', id, variant);
    }
  };

  const assemblyOrdinals = new Map();
  for (const reference of tables.assembly_reference) {
    const ordinal = assemblyOrdinals.get(reference.page_path) ?? 0;
    assemblyOrdinals.set(reference.page_path, ordinal + 1);
    addUsage(
      `usage:assembly:${reference.page_path}@${ordinal}`,
      structureId.get(reference.page_path),
      {
        display_name: reference.display_name,
        match_method: reference.match_method,
        line_number: reference.line_number,
      },
      reference.resolved_part,
      null,
    );
  }

  for (const reference of tables.preassembly_reference) {
    const owner =
      reference.section === 'Accessory bag BOM'
        ? accessoryBagId.get(reference.page_path)
        : structureId.get(reference.page_path);
    addUsage(
      `usage:preassembly:${reference.page_path}@${reference.line_number}`,
      owner,
      {
        display_name: reference.display_name,
        match_method: reference.match_method,
        line_number: reference.line_number,
        section: reference.section,
        source_kind: reference.source_kind,
        quantity: reference.quantity,
        quantity_text: reference.quantity_text,
      },
      reference.resolved_part,
      null,
    );
  }

  for (const item of tables.packing_item) {
    const standardApplies = item.quantity_standard !== null;
    const xlApplies = item.quantity_xl !== null;
    const single = standardApplies !== xlApplies;
    const version = single ? (standardApplies ? 'standard' : 'xl') : null;
    addUsage(
      `usage:packing:${item.page_path}@${item.table_index}/${item.row_index}/${item.child_index}`,
      structureId.get(item.page_path),
      {
        display_name: item.display_name,
        match_method: item.match_method,
        section: item.section,
        sub_packing: item.sub_packing,
        quantity: single
          ? standardApplies
            ? item.quantity_standard
            : item.quantity_xl
          : null,
        unit: single
          ? standardApplies
            ? item.quantity_standard_unit
            : item.quantity_xl_unit
          : null,
      },
      item.resolved_part,
      version,
    );
  }

  // Comparisons: one node per comparison row. Difference rows keep the same
  // node and add the subclass label plus the signed difference.
  const differenceByKey = new Map(
    tables.quantity_difference.map((row) => [
      `${row.packing_page}\u0000${row.part_name}\u0000${row.version}`,
      row,
    ]),
  );
  const matchedDifferences = new Set();
  for (const comparison of tables.quantity_comparison) {
    const key = `${comparison.packing_page}\u0000${comparison.part_name}\u0000${comparison.version}`;
    const difference = differenceByKey.get(key);
    if (difference) matchedDifferences.add(key);
    const id = `comparison:${comparison.packing_page}#${comparison.part_name}#${comparison.version}`;
    addNode(difference ? 'QuantityDifference' : 'QuantityComparison', id, {
      packing_quantity: comparison.packing_quantity,
      part_quantity: comparison.part_quantity,
      difference: comparison.difference,
      status: comparison.status,
      note: comparison.note,
      sections: comparison.sections,
      packing_minus_part: difference ? difference.packing_minus_part : null,
    });

    const part = partId.get(comparison.part_name);
    if (!part) {
      throw new Error(`comparison ${id} names unknown part ${comparison.part_name}`);
    }
    addEdge('COMPARES_PART', id, part);

    const container = structureId.get(comparison.packing_page);
    if (!container) {
      throw new Error(`comparison ${id} names unknown packing page`);
    }
    addEdge('COMPARED_IN', id, container);

    const variant = productVariantId.get(comparison.version);
    if (!variant) {
      throw new Error(`comparison ${id} names unknown version ${comparison.version}`);
    }
    addEdge('FOR_VARIANT', id, variant);
  }

  for (const key of differenceByKey.keys()) {
    if (!matchedDifferences.has(key)) {
      const label = key.split('\u0000').join(' / ');
      throw new Error(`quantity difference row has no comparison row: ${label}`);
    }
  }

  for (const unmatched of tables.unmatched_name) {
    const id = `unmatched:${unmatched.display_name}`;
    addNode('UnmatchedName', id, {
      display_name: unmatched.display_name,
      normalized_name: unmatched.normalized_name,
      singular_name: unmatched.singular_name,
      reference_count: unmatched.reference_count,
      source_kinds: unmatched.source_kinds,
      status: unmatched.status,
    });
    for (const page of splitList(unmatched.source_pages)) {
      const structure = structureId.get(page);
      if (!structure) {
        throw new Error(`unmatched ${id} names unknown page ${page}`);
      }
      addEdge('SEEN_IN', id, structure);
    }
    for (const candidate of splitList(unmatched.candidates)) {
      const part = partId.get(candidate);
      if (!part) {
        throw new Error(`unmatched ${id} names unknown candidate part ${candidate}`);
      }
      addEdge('CANDIDATE', id, part);
    }
  }

  for (const part of tables.part) {
    const category = categoryId.get(part.category_slug);
    if (!category) {
      throw new Error(`part ${part.name} names unknown category ${part.category_slug}`);
    }
    addEdge('IN_CATEGORY', partId.get(part.name), category);
  }

  return sortGraph({ nodes, edges });
}

function sortGraph(graph) {
  const nodes = [...graph.nodes].sort((left, right) =>
    compareStrings(left.id, right.id),
  );
  const edges = [...graph.edges].sort((left, right) => {
    return (
      compareStrings(left.type, right.type) ||
      compareStrings(left.from, right.from) ||
      compareStrings(left.to, right.to)
    );
  });
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Part-scoped graph

export function scopeGraphToPart(graph, partName) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const seed = graph.nodes.find(
    (node) => node.labels.includes('Part') && node.properties.name === partName,
  );
  if (!seed) throw new Error(`part ${partName} is not in the extract`);

  const outgoing = new Map();
  const incoming = new Map();
  for (const edge of graph.edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge);
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    incoming.get(edge.to).push(edge);
  }

  const inScope = (node) => {
    if (node === seed) return true;
    if (node.labels.includes('Part')) return false;
    return node.labels.some((label) => PART_SCOPE_LABELS.has(label));
  };

  const stepsFor = (node) => {
    if (node.labels.includes('Part')) return PART_STEPS.Part;
    if (node.labels.includes('Usage')) return PART_STEPS.Usage;
    if (node.labels.includes('Structure')) return PART_STEPS.Structure;
    if (node.labels.includes('QuantityComparison')) {
      return PART_STEPS.QuantityComparison;
    }
    return { out: [], in: [] };
  };

  const included = new Set([seed.id]);
  const queue = [seed.id];
  while (queue.length > 0) {
    const currentId = queue.shift();
    const current = nodes.get(currentId);
    const steps = stepsFor(current);
    const candidates = [];
    for (const edge of outgoing.get(currentId) ?? []) {
      if (steps.out === null || steps.out.includes(edge.type)) candidates.push(edge.to);
    }
    for (const edge of incoming.get(currentId) ?? []) {
      if (steps.in.includes(edge.type)) candidates.push(edge.from);
    }
    for (const id of candidates) {
      if (included.has(id)) continue;
      const node = nodes.get(id);
      if (!node || !inScope(node)) continue;
      included.add(id);
      queue.push(id);
    }
  }

  const scopedNodes = graph.nodes.filter((node) => included.has(node.id));
  const scopedEdges = graph.edges.filter(
    (edge) => included.has(edge.from) && included.has(edge.to),
  );
  return sortGraph({ nodes: scopedNodes, edges: scopedEdges });
}

// ---------------------------------------------------------------------------
// Recipes

function resolveRecipePath(nameOrPath) {
  if (existsSync(nameOrPath)) return resolve(nameOrPath);
  if (/^[A-Za-z0-9._-]+$/.test(nameOrPath)) {
    const candidate = join(RECIPE_DIR, `${nameOrPath}.yaml`);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`recipe not found: ${nameOrPath}`);
}

export function loadRecipe(nameOrPath) {
  const path = resolveRecipePath(nameOrPath);
  const recipe = parse(readFileSync(path, 'utf8'));
  if (recipe === null || typeof recipe !== 'object' || Array.isArray(recipe)) {
    throw new Error(`recipe ${path} must be a mapping`);
  }
  const allowed = new Set(['name', 'output', 'scope', 'part']);
  for (const key of Object.keys(recipe)) {
    if (!allowed.has(key)) throw new Error(`recipe ${path} has unknown key ${key}`);
  }
  if (typeof recipe.name !== 'string' || recipe.name.length === 0) {
    throw new Error(`recipe ${path} needs a name`);
  }
  if (typeof recipe.output !== 'string' || !/^[A-Za-z0-9._-]+$/.test(recipe.output)) {
    throw new Error(`recipe ${path} needs a plain output file name`);
  }
  if (recipe.scope !== 'full' && recipe.scope !== 'part') {
    throw new Error(`recipe ${path} scope must be full or part`);
  }
  if (recipe.scope === 'part') {
    if (typeof recipe.part !== 'string' || recipe.part.length === 0) {
      throw new Error(`recipe ${path} needs a part`);
    }
  } else if (recipe.part !== undefined) {
    throw new Error(`recipe ${path} has a part but scope full`);
  }
  return recipe;
}

// ---------------------------------------------------------------------------
// Canonical serialization

function canonicalJson(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => indent(canonicalJson(item), 2));
    return `[\n${items.join(',\n')}\n]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort(compareStrings);
    if (keys.length === 0) return '{}';
    const items = keys.map(
      (key) => indent(`${JSON.stringify(key)}: ${canonicalJson(value[key])}`, 2),
    );
    return `{\n${items.join(',\n')}\n}`;
  }
  return JSON.stringify(value);
}

function indent(text, spaces) {
  const prefix = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

export function serializeSeed(seed) {
  return Buffer.from(`${canonicalJson(seed)}\n`, 'utf8');
}

export function digestBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sidecarText(bytes) {
  return `${GRAPH_FORMAT} sha256:${digestBytes(bytes)}\n`;
}

// ---------------------------------------------------------------------------
// Runner

export async function generate({ extract, ontology, recipe, out }) {
  const loaded = loadRecipe(recipe);
  const parsedOntology = loadOntology(ontology);
  const tables = await readExtract(extract);
  const full = buildFullGraph(tables, parsedOntology);
  const seed =
    loaded.scope === 'part' ? scopeGraphToPart(full, loaded.part) : full;
  validateSeed(seed, parsedOntology);

  const bytes = serializeSeed(seed);
  const digest = `${GRAPH_FORMAT} sha256:${digestBytes(bytes)}`;
  await mkdir(out, { recursive: true });
  const seedPath = join(out, loaded.output);
  const digestPath = `${seedPath}.sha256`;
  await writeFile(seedPath, bytes);
  await writeFile(digestPath, sidecarText(bytes));
  return {
    seedPath,
    digestPath,
    digest,
    bytes: bytes.length,
    nodes: seed.nodes.length,
    edges: seed.edges.length,
  };
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const options = {
    extract: DEFAULT_EXTRACT,
    ontology: DEFAULT_ONTOLOGY,
    recipe: 'full',
    out: DEFAULT_OUT,
  };
  const keys = {
    '--extract': 'extract',
    '--ontology': 'ontology',
    '--recipe': 'recipe',
    '--out': 'out',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    const equals = argument.indexOf('=');
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    const key = keys[flag];
    if (!key) throw new Error(`unknown argument ${argument}`);
    if (equals === -1) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      options[key] = value;
      index += 1;
    } else {
      options[key] = argument.slice(equals + 1);
    }
  }
  return options;
}

function usage() {
  return [
    'Usage: graph.mjs [--extract <duckdb>] [--ontology <yaml>]',
    '                 [--recipe <name|path>] [--out <directory>]',
    '',
    `Defaults: extract ${DEFAULT_EXTRACT}`,
    `          ontology ${DEFAULT_ONTOLOGY}`,
    '          recipe full',
    `          out ${DEFAULT_OUT}`,
  ].join('\n');
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await generate({
    extract: resolve(parsed.extract),
    ontology: resolve(parsed.ontology),
    recipe: parsed.recipe,
    out: resolve(parsed.out),
  });
  process.stdout.write(
    `Graph seed written: ${result.seedPath} (${result.nodes} nodes, ${result.edges} edges)\n`,
  );
  process.stdout.write(`${result.digest}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`graph.mjs: ${error.message}\n`);
    process.exitCode = 1;
  });
}
