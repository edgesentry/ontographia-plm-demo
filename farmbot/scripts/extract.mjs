#!/usr/bin/env node
// Build a reproducible DuckDB extract from the pinned FarmBot Genesis
// submodule. The script reads only from the submodule and writes only the
// DuckDB file and its SHA-256 sidecar under farmbot/dist/.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DuckDBInstance } from '@duckdb/node-api';

import { parseFrontmatter } from './lib/frontmatter.mjs';
import {
  extractTables,
  findWikilinks,
  stripMarkup,
} from './lib/markdown.mjs';
import {
  buildPartIndex,
  normalizeName,
  resolveName,
  resolveWithQualifier,
  singularizeName,
} from './lib/normalize.mjs';

export const EXPECTED_PIN = '44e0fa24d4a538dfa1255a4e89308ccabf3abaeb';
export const SOURCE_LABEL = 'v1.7';
export const SCHEMA_VERSION = '1';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FARMBOT_DIR = resolve(SCRIPT_DIR, '..');
const DEFAULT_SOURCE = resolve(FARMBOT_DIR, 'third_party/farmbot-genesis');
const DEFAULT_OUT_DIR = resolve(FARMBOT_DIR, 'dist');
const OUTPUT_NAME = 'farmbot.duckdb';

function toPosix(path) {
  return path.split(sep).join('/');
}

function listMarkdownFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '_images') continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(full);
      }
    }
  };
  walk(dir);
  return files;
}

function readPage(sourceDir, file) {
  const text = readFileSync(file, 'utf8');
  const { data, body } = parseFrontmatter(text);
  return {
    path: toPosix(relative(sourceDir, file)),
    title: typeof data.title === 'string' ? data.title : null,
    slug: typeof data.slug === 'string' ? data.slug : null,
    description: typeof data.description === 'string' ? data.description : null,
    data,
    body,
  };
}

function splitPipe(value) {
  if (value === null || value === undefined) return [];
  const parts = String(value)
    .split('|')
    .map((part) => part.trim());
  while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function parseLeadingInt(value) {
  if (value === null || value === undefined) return null;
  const match = /^\s*(\d+)/.exec(String(value));
  return match ? Number(match[1]) : null;
}

function sumQuantities(raw) {
  const values = splitPipe(raw)
    .map((value) => parseLeadingInt(value))
    .filter((value) => value !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function countWordsQuantity(text) {
  const words = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  const match = /^\s*(?:[-*]\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/i.exec(
    text,
  );
  if (!match) return null;
  const token = match[1].toLowerCase();
  if (/^\d+$/.test(token)) return Number(token);
  return words[token] ?? null;
}

function verifySource(sourceDir) {
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    throw new Error(
      `FarmBot Genesis submodule not found at ${sourceDir}. ` +
        'Run "git submodule update --init --recursive" from the repository root.',
    );
  }
  if (!existsSync(join(sourceDir, '.git'))) {
    throw new Error(
      `FarmBot Genesis path ${sourceDir} is not a git checkout, so the pin ${EXPECTED_PIN} cannot be verified.`,
    );
  }

  const result = spawnSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const detail = (result.stderr || '').trim();
    throw new Error(
      `Cannot read the FarmBot Genesis pin at ${sourceDir}` +
        (detail ? `: ${detail}` : '.') +
        ` Expected ${EXPECTED_PIN}.`,
    );
  }

  const actual = result.stdout.trim();
  if (actual !== EXPECTED_PIN) {
    throw new Error(
      `FarmBot Genesis pin mismatch at ${sourceDir}: expected ${EXPECTED_PIN}, found ${actual}.`,
    );
  }

  if (!existsSync(join(sourceDir, SOURCE_LABEL))) {
    throw new Error(
      `FarmBot Genesis checkout at ${sourceDir} does not contain ${SOURCE_LABEL}, although the pin matches.`,
    );
  }
}

function readCategories(sourceDir) {
  const bomDir = join(sourceDir, SOURCE_LABEL, 'bom');
  const categories = new Map();
  for (const entry of readdirSync(bomDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'bom.md') continue;
    const page = readPage(sourceDir, join(bomDir, entry.name));
    const key = entry.name.slice(0, -3);
    categories.set(key, { slug: key, title: page.title, path: page.path });
  }
  return categories;
}

function readParts(sourceDir, categories) {
  const bomDir = join(sourceDir, SOURCE_LABEL, 'bom');
  const parts = [];
  const categoryPages = new Set([...categories.values()].map((category) => category.path));

  for (const file of listMarkdownFiles(bomDir)) {
    const page = readPage(sourceDir, file);
    if (categoryPages.has(page.path)) continue;
    if (!page.data.quantity || typeof page.data.quantity !== 'object') continue;

    const categorySlug = page.path.split('/')[2] ?? null;
    const standardRaw = page.data.quantity.standard ?? null;
    const xlRaw = page.data.quantity.xl ?? null;
    const variantLabels = splitPipe(page.data.variants);
    const prices = splitPipe(page.data.price);
    const standardValues = splitPipe(standardRaw);
    const xlValues = splitPipe(xlRaw);
    const lengths = splitPipe(page.data.specs?.length);
    const internalNames = splitPipe(page.data['internal-specs']?.['internal-part-name']);

    const variants = variantLabels.map((label, index) => ({
      partName: page.title,
      variantIndex: index + 1,
      label,
      marketPrice: prices[index] ?? null,
      quantityStandard: parseLeadingInt(standardValues[index]),
      quantityXl: parseLeadingInt(xlValues[index]),
      length: lengths.length === variantLabels.length ? (lengths[index] ?? null) : null,
      internalPartName:
        internalNames.length === variantLabels.length ? (internalNames[index] ?? null) : null,
    }));

    parts.push({
      name: page.title,
      slug: page.slug,
      path: page.path,
      categorySlug,
      categoryTitle: categories.get(categorySlug)?.title ?? null,
      description: page.description,
      marketPrice: page.data.price ?? null,
      quantityStandardRaw: standardRaw,
      quantityXlRaw: xlRaw,
      quantityStandard: sumQuantities(standardRaw),
      quantityXl: sumQuantities(xlRaw),
      variantCount: variantLabels.length > 0 ? variantLabels.length : null,
      hasVariants: variantLabels.length > 0,
      variantsRaw: page.data.variants ?? null,
      internalPartNameRaw: page.data['internal-specs']?.['internal-part-name'] ?? null,
      variants,
    });
  }

  parts.sort((a, b) => a.name.localeCompare(b.name));
  return parts;
}

function readAssembly(sourceDir, index, parts) {
  const assemblyDir = join(sourceDir, SOURCE_LABEL, 'assembly');
  const pages = [];
  const references = [];

  for (const file of readdirSync(assemblyDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const page = readPage(sourceDir, join(assemblyDir, file.name));
    const chapter = file.name.slice(0, -3);
    const lines = page.body.split(/\r?\n/);
    let inFence = false;
    let pageReferences = 0;

    lines.forEach((line, lineIndex) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return;
      }
      if (inFence) return;
      for (const link of findWikilinks(line)) {
        const resolved = resolveName(link.name, index, parts);
        references.push({
          pagePath: page.path,
          pageTitle: page.title,
          chapter,
          lineNumber: lineIndex + 1,
          displayName: link.name,
          resolvedPart: resolved.partName,
          matchMethod: resolved.method,
          candidates: resolved.candidates,
        });
        pageReferences += 1;
      }
    });

    pages.push({
      path: page.path,
      title: page.title,
      chapter,
      referenceCount: pageReferences,
    });
  }

  return { pages, references };
}

function isComponentTable(table) {
  const first = (table.header[0] ?? '').toLowerCase().trim();
  if (first !== 'component' && first !== 'item') return false;
  if (/packaging/i.test(table.section ?? '')) return false;
  if (/box specifications/i.test(table.section ?? '')) return false;
  return true;
}

function readPreassembly(sourceDir, index, parts) {
  const root = join(sourceDir, SOURCE_LABEL, 'manufacturing', 'pre-assembly');
  const pages = [];
  const references = [];

  for (const file of listMarkdownFiles(root)) {
    const page = readPage(sourceDir, file);
    const tables = extractTables(page.body);
    const componentTables = tables.filter(isComponentTable);
    const pdfCount = (page.body.match(/\.pdf["']/g) ?? []).length;
    let referenceCount = 0;

    for (const table of componentTables) {
      const qtyColumn = table.header.findIndex((header) =>
        /^(qty|quantity)$/i.test(header.trim()),
      );
      for (const row of table.rows) {
        const component = stripMarkup(row.cells[0] ?? '');
        if (!component) continue;
        const quantityCell = qtyColumn >= 0 ? (row.cells[qtyColumn] ?? null) : null;
        const resolved = resolveName(component, index, parts);
        references.push({
          pagePath: page.path,
          pageTitle: page.title,
          section: table.section,
          sourceKind: 'table',
          lineNumber: row.lineNumber,
          displayName: component,
          quantityText: quantityCell,
          quantity: parseLeadingInt(quantityCell),
          resolvedPart: resolved.partName,
          matchMethod: resolved.method,
          candidates: resolved.candidates,
        });
        referenceCount += 1;
      }
    }

    // Markdown component lists outside tables (for example the V-wheel page).
    const lines = page.body.split(/\r?\n/);
    let section = null;
    let inFence = false;
    lines.forEach((line, lineIndex) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return;
      }
      if (inFence) return;
      const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (heading) {
        section = heading[2].trim();
        return;
      }
      if (line.trim().startsWith('|')) return;
      for (const link of findWikilinks(line)) {
        const resolved = resolveName(link.name, index, parts);
        references.push({
          pagePath: page.path,
          pageTitle: page.title,
          section,
          sourceKind: 'prose',
          lineNumber: lineIndex + 1,
          displayName: link.name,
          quantityText: null,
          quantity: countWordsQuantity(line),
          resolvedPart: resolved.partName,
          matchMethod: resolved.method,
          candidates: resolved.candidates,
        });
        referenceCount += 1;
      }
    });

    let reason;
    let machineReadable = false;
    if (referenceCount > 0 && pdfCount > 0) {
      machineReadable = true;
      reason = 'markdown component list; assembly steps are PDF-only';
    } else if (referenceCount > 0) {
      machineReadable = true;
      reason = 'markdown component list';
    } else if (pdfCount > 0) {
      reason = 'pdf-only';
    } else {
      reason = 'index page with no component list';
    }

    pages.push({
      path: page.path,
      title: page.title,
      machineReadable,
      reason,
      pdfCount,
      componentTableCount: componentTables.length,
      referenceCount,
    });
  }

  return { pages, references };
}

function parseQuantityCell(cell) {
  if (cell === null || cell === undefined) {
    return { value: null, unit: null, text: null };
  }
  const text = String(cell).trim();
  if (!text || text === '-' || text === '—' || text === '–') {
    return { value: null, unit: null, text: text || null };
  }
  const match = /^(\d+)(.*)$/.exec(text);
  if (!match) return { value: null, unit: text, text };
  const unit = match[2].trim();
  return { value: Number(match[1]), unit: unit || null, text };
}

function sectionVersion(section) {
  if (/\(xl\)|\bxl\b/i.test(section ?? '')) return 'xl';
  if (/genesis/i.test(section ?? '')) return 'standard';
  return 'both';
}

function cleanQualifier(text) {
  let value = stripMarkup(text);
  let previous;
  do {
    previous = value;
    value = value.replace(/\([^)]*\)/g, ' ');
  } while (value !== previous);
  return value.replace(/\s+/g, ' ').trim();
}

function readPacking(sourceDir, index, parts) {
  const root = join(sourceDir, SOURCE_LABEL, 'manufacturing', 'packing');
  const pages = [];
  const items = [];

  for (const file of listMarkdownFiles(root)) {
    const page = readPage(sourceDir, file);
    const tables = extractTables(page.body);
    let referenceCount = 0;
    let tableIndex = 0;

    for (const table of tables) {
      const isItemTable = (table.header[0] ?? '').toLowerCase().trim() === 'item';
      if (!isItemTable) {
        tableIndex += 1;
        continue;
      }

      const headers = table.header.map((header) => header.toLowerCase());
      const xlColumn = headers.findIndex((header) => /(^|[^a-z])xl([^a-z]|$)/.test(header));
      const standardColumn = headers.findIndex(
        (header) => header.includes('genesis') && !header.includes('xl'),
      );
      const quantityColumn = headers.findIndex((header) =>
        /^(qty|quantity)$/.test(header.trim()),
      );
      const version = sectionVersion(table.section);

      for (const row of table.rows) {
        const cells = row.cells;
        const cell = (position) => (position >= 0 ? (cells[position] ?? null) : null);
        const valueFor = (target) => {
          if (target === 'standard') {
            if (standardColumn >= 0) return parseQuantityCell(cell(standardColumn));
            if (quantityColumn >= 0 && (version === 'standard' || version === 'both')) {
              return parseQuantityCell(cell(quantityColumn));
            }
            return { value: null, unit: null, text: null };
          }
          if (xlColumn >= 0) return parseQuantityCell(cell(xlColumn));
          if (quantityColumn >= 0 && (version === 'xl' || version === 'both')) {
            return parseQuantityCell(cell(quantityColumn));
          }
          return { value: null, unit: null, text: null };
        };

        const standard = valueFor('standard');
        const xl = valueFor('xl');
        const standardApplies = standard.value !== null && standard.value > 0;
        const xlApplies = xl.value !== null && xl.value > 0;

        const segments = String(cells[0] ?? '')
          .split(/<br\s*\/?>/i)
          .map((segment) => segment.trim())
          .filter(Boolean);
        const main = segments[0] ?? '';
        const childSegments = segments.slice(1);
        const children = childSegments
          .map((segment) => {
            const match = /^[-*]\s*(?:(\d+)\s*x\s*)?\[\[([^\]]+)\]\]/i.exec(
              segment.replace(/^[-*]\s+/, '- '),
            );
            if (!match) return null;
            return {
              quantity: match[1] ? Number(match[1]) : null,
              displayName: match[2].trim(),
              text: segment,
            };
          })
          .filter((child) => child !== null);
        const qualifier = cleanQualifier(main);
        const fullItemText = String(cells[0] ?? '').trim();

        const rowItems = [];
        if (children.length > 0) {
          rowItems.push({
            pagePath: page.path,
            pageTitle: page.title,
            section: table.section,
            tableIndex,
            rowIndex: row.lineNumber,
            childIndex: 0,
            itemKind: 'pack',
            parentItem: null,
            itemText: fullItemText,
            displayName: null,
            subPacking: cell(1),
            quantityStandardText: standard.text,
            quantityStandard: standard.value,
            quantityStandardUnit: standard.unit,
            quantityXlText: xl.text,
            quantityXl: xl.value,
            quantityXlUnit: xl.unit,
            resolvedPart: null,
            matchMethod: null,
            candidates: [],
          });
        }

        for (const link of findWikilinks(main)) {
          const resolved = resolveWithQualifier(link.name, qualifier, index, parts);
          rowItems.push({
            pagePath: page.path,
            pageTitle: page.title,
            section: table.section,
            tableIndex,
            rowIndex: row.lineNumber,
            childIndex: 0,
            itemKind: 'item',
            parentItem: null,
            itemText: fullItemText,
            displayName: link.name,
            subPacking: cell(1),
            quantityStandardText: standard.text,
            quantityStandard: standard.value,
            quantityStandardUnit: standard.unit,
            quantityXlText: xl.text,
            quantityXl: xl.value,
            quantityXlUnit: xl.unit,
            resolvedPart: resolved.partName,
            matchMethod: resolved.method,
            candidates: resolved.candidates,
          });
        }

        children.forEach((child, childIndex) => {
          const quantity = child.quantity;
          const displayName = child.displayName;
          const resolved = resolveName(displayName, index, parts);
          rowItems.push({
            pagePath: page.path,
            pageTitle: page.title,
            section: table.section,
            tableIndex,
            rowIndex: row.lineNumber,
            childIndex: childIndex + 1,
            itemKind: 'component',
            parentItem: main.replace(/:$/, '').trim() || null,
            itemText: child.text,
            displayName,
            subPacking: cell(1),
            quantityStandardText: quantity !== null ? `${quantity}x` : null,
            quantityStandard: standardApplies ? quantity : null,
            quantityStandardUnit: null,
            quantityXlText: quantity !== null ? `${quantity}x` : null,
            quantityXl: xlApplies ? quantity : null,
            quantityXlUnit: null,
            resolvedPart: resolved.partName,
            matchMethod: resolved.method,
            candidates: resolved.candidates,
          });
        });

        items.push(...rowItems);
        referenceCount += rowItems.filter((item) => item.displayName !== null).length;
      }

      tableIndex += 1;
    }

    pages.push({
      path: page.path,
      title: page.title,
      referenceCount,
    });
  }

  return { pages, items };
}

function deriveQuantityComparisons(parts, packingItems) {
  const partsByName = new Map(parts.map((part) => [part.name, part]));
  const groups = new Map();

  for (const item of packingItems) {
    if (!item.displayName || !item.resolvedPart) continue;
    const key = `${item.pagePath}\u0000${item.resolvedPart}`;
    if (!groups.has(key)) {
      groups.set(key, {
        packingPage: item.pagePath,
        partName: item.resolvedPart,
        standard: { sum: 0, rows: 0, units: new Set(), sections: new Set() },
        xl: { sum: 0, rows: 0, units: new Set(), sections: new Set() },
      });
    }
    const group = groups.get(key);
    if (item.quantityStandard !== null) {
      group.standard.sum += item.quantityStandard;
      group.standard.rows += 1;
      if (item.section) group.standard.sections.add(item.section);
      if (item.quantityStandardUnit) group.standard.units.add(item.quantityStandardUnit);
    }
    if (item.quantityXl !== null) {
      group.xl.sum += item.quantityXl;
      group.xl.rows += 1;
      if (item.section) group.xl.sections.add(item.section);
      if (item.quantityXlUnit) group.xl.units.add(item.quantityXlUnit);
    }
  }

  const comparisons = [];
  for (const group of [...groups.values()].sort((a, b) => {
    const pageOrder = a.packingPage.localeCompare(b.packingPage);
    return pageOrder !== 0 ? pageOrder : a.partName.localeCompare(b.partName);
  })) {
    const part = partsByName.get(group.partName);
    for (const version of ['standard', 'xl']) {
      const aggregate = group[version];
      if (aggregate.rows === 0) continue;
      const partQuantity = version === 'standard' ? part.quantityStandard : part.quantityXl;
      const units = [...aggregate.units].sort();
      let status;
      let note = null;
      if (units.length > 0) {
        status = 'not_comparable';
        note = `packing quantity uses a non-count unit: ${units.join(', ')}`;
      } else if (partQuantity === null) {
        status = 'part_quantity_missing';
        note = 'the part page does not declare a quantity for this version';
      } else if (aggregate.sum === partQuantity) {
        status = 'match';
      } else {
        status = 'difference';
      }
      comparisons.push({
        packingPage: group.packingPage,
        partName: group.partName,
        version,
        sections: [...aggregate.sections].sort().join(', '),
        packingQuantity: aggregate.sum,
        partQuantity,
        difference: status === 'difference' ? aggregate.sum - partQuantity : null,
        status,
        note,
      });
    }
  }

  return comparisons;
}

function deriveUnmatched(references) {
  const groups = new Map();
  for (const reference of references) {
    if (!reference.displayName || reference.resolvedPart) continue;
    const key = reference.displayName;
    if (!groups.has(key)) {
      groups.set(key, {
        displayName: key,
        normalizedName: normalizeName(key),
        singularName: singularizeName(key),
        referenceCount: 0,
        sourceKinds: new Set(),
        sourcePages: new Set(),
        methods: new Set(),
        candidates: new Set(),
      });
    }
    const group = groups.get(key);
    group.referenceCount += 1;
    group.sourceKinds.add(reference.sourceCategory ?? reference.sourceKind);
    group.sourcePages.add(reference.pagePath);
    group.methods.add(reference.matchMethod);
    for (const candidate of reference.candidates ?? []) group.candidates.add(candidate);
  }

  return [...groups.values()]
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map((group) => ({
      displayName: group.displayName,
      normalizedName: group.normalizedName,
      singularName: group.singularName,
      referenceCount: group.referenceCount,
      sourceKinds: [...group.sourceKinds].sort().join(', '),
      sourcePages: [...group.sourcePages].sort().join(', '),
      status: group.methods.has('ambiguous') ? 'ambiguous' : 'unmatched',
      candidates: [...group.candidates].sort().join(', '),
    }));
}

async function buildDatabase(outFile, extract) {
  mkdirSync(dirname(outFile), { recursive: true });
  rmSync(outFile, { force: true });
  rmSync(`${outFile}.wal`, { force: true });

  const instance = await DuckDBInstance.create(outFile);
  const connection = await instance.connect();

  await connection.run(`
    CREATE TABLE part (
      name VARCHAR PRIMARY KEY,
      slug VARCHAR,
      path VARCHAR,
      category_slug VARCHAR,
      category_title VARCHAR,
      description VARCHAR,
      market_price VARCHAR,
      quantity_standard_raw VARCHAR,
      quantity_standard INTEGER,
      quantity_xl_raw VARCHAR,
      quantity_xl INTEGER,
      variant_count INTEGER,
      has_variants BOOLEAN,
      variants_raw VARCHAR,
      internal_part_name_raw VARCHAR
    )
  `);
  await connection.run(`
    CREATE TABLE part_variant (
      part_name VARCHAR,
      variant_index INTEGER,
      label VARCHAR,
      market_price VARCHAR,
      quantity_standard INTEGER,
      quantity_xl INTEGER,
      length VARCHAR,
      internal_part_name VARCHAR
    )
  `);
  await connection.run(`
    CREATE TABLE bom_category (
      slug VARCHAR PRIMARY KEY,
      title VARCHAR,
      path VARCHAR,
      part_count INTEGER
    )
  `);
  await connection.run(`
    CREATE TABLE assembly_page (
      path VARCHAR PRIMARY KEY,
      title VARCHAR,
      chapter VARCHAR,
      reference_count INTEGER
    )
  `);
  await connection.run(`
    CREATE TABLE assembly_reference (
      page_path VARCHAR,
      page_title VARCHAR,
      chapter VARCHAR,
      line_number INTEGER,
      display_name VARCHAR,
      resolved_part VARCHAR,
      match_method VARCHAR,
      candidates VARCHAR
    )
  `);
  await connection.run(`
    CREATE TABLE preassembly_page (
      path VARCHAR PRIMARY KEY,
      title VARCHAR,
      machine_readable BOOLEAN,
      machine_readable_reason VARCHAR,
      pdf_count INTEGER,
      component_table_count INTEGER,
      reference_count INTEGER
    )
  `);
  await connection.run(`
    CREATE TABLE preassembly_reference (
      page_path VARCHAR,
      page_title VARCHAR,
      section VARCHAR,
      source_kind VARCHAR,
      line_number INTEGER,
      display_name VARCHAR,
      quantity_text VARCHAR,
      quantity INTEGER,
      resolved_part VARCHAR,
      match_method VARCHAR,
      candidates VARCHAR
    )
  `);
  await connection.run(`
    CREATE TABLE packing_page (
      path VARCHAR PRIMARY KEY,
      title VARCHAR,
      reference_count INTEGER
    )
  `);
  await connection.run(`
    CREATE TABLE packing_item (
      page_path VARCHAR,
      page_title VARCHAR,
      section VARCHAR,
      table_index INTEGER,
      row_index INTEGER,
      child_index INTEGER,
      item_kind VARCHAR,
      parent_item VARCHAR,
      item_text VARCHAR,
      display_name VARCHAR,
      sub_packing VARCHAR,
      quantity_standard_text VARCHAR,
      quantity_standard INTEGER,
      quantity_standard_unit VARCHAR,
      quantity_xl_text VARCHAR,
      quantity_xl INTEGER,
      quantity_xl_unit VARCHAR,
      resolved_part VARCHAR,
      match_method VARCHAR,
      candidates VARCHAR
    )
  `);
  await connection.run(`
    CREATE TABLE quantity_comparison (
      packing_page VARCHAR,
      part_name VARCHAR,
      version VARCHAR,
      sections VARCHAR,
      packing_quantity INTEGER,
      part_quantity INTEGER,
      difference INTEGER,
      status VARCHAR,
      note VARCHAR
    )
  `);
  await connection.run(`
    CREATE TABLE quantity_difference (
      packing_page VARCHAR,
      part_name VARCHAR,
      version VARCHAR,
      sections VARCHAR,
      packing_quantity INTEGER,
      part_quantity INTEGER,
      packing_minus_part INTEGER
    )
  `);
  await connection.run(`
    CREATE TABLE unmatched_name (
      display_name VARCHAR,
      normalized_name VARCHAR,
      singular_name VARCHAR,
      reference_count INTEGER,
      source_kinds VARCHAR,
      source_pages VARCHAR,
      status VARCHAR,
      candidates VARCHAR
    )
  `);
  await connection.run(`
    CREATE TABLE extract_metadata (
      key VARCHAR PRIMARY KEY,
      value VARCHAR
    )
  `);

  const insert = async (table, columns, rows) => {
    if (rows.length === 0) return;
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns
      .map(() => '?')
      .join(', ')})`;
    for (const row of rows) await connection.run(sql, row);
  };

  const categories = extract.categories;
  await insert(
    'bom_category',
    ['slug', 'title', 'path', 'part_count'],
    [...categories.values()]
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map((category) => [
        category.slug,
        category.title,
        category.path,
        extract.parts.filter((part) => part.categorySlug === category.slug).length,
      ]),
  );

  await insert(
    'part',
    [
      'name',
      'slug',
      'path',
      'category_slug',
      'category_title',
      'description',
      'market_price',
      'quantity_standard_raw',
      'quantity_standard',
      'quantity_xl_raw',
      'quantity_xl',
      'variant_count',
      'has_variants',
      'variants_raw',
      'internal_part_name_raw',
    ],
    extract.parts.map((part) => [
      part.name,
      part.slug,
      part.path,
      part.categorySlug,
      part.categoryTitle,
      part.description,
      part.marketPrice,
      part.quantityStandardRaw,
      part.quantityStandard,
      part.quantityXlRaw,
      part.quantityXl,
      part.variantCount,
      part.hasVariants,
      part.variantsRaw,
      part.internalPartNameRaw,
    ]),
  );

  const variantRows = [];
  for (const part of extract.parts) {
    for (const variant of part.variants) {
      variantRows.push([
        variant.partName,
        variant.variantIndex,
        variant.label,
        variant.marketPrice,
        variant.quantityStandard,
        variant.quantityXl,
        variant.length,
        variant.internalPartName,
      ]);
    }
  }
  await insert(
    'part_variant',
    [
      'part_name',
      'variant_index',
      'label',
      'market_price',
      'quantity_standard',
      'quantity_xl',
      'length',
      'internal_part_name',
    ],
    variantRows,
  );

  await insert(
    'assembly_page',
    ['path', 'title', 'chapter', 'reference_count'],
    extract.assembly.pages.map((page) => [
      page.path,
      page.title,
      page.chapter,
      page.referenceCount,
    ]),
  );

  await insert(
    'assembly_reference',
    [
      'page_path',
      'page_title',
      'chapter',
      'line_number',
      'display_name',
      'resolved_part',
      'match_method',
      'candidates',
    ],
    extract.assembly.references.map((reference) => [
      reference.pagePath,
      reference.pageTitle,
      reference.chapter,
      reference.lineNumber,
      reference.displayName,
      reference.resolvedPart,
      reference.matchMethod,
      (reference.candidates ?? []).join(', ') || null,
    ]),
  );

  await insert(
    'preassembly_page',
    [
      'path',
      'title',
      'machine_readable',
      'machine_readable_reason',
      'pdf_count',
      'component_table_count',
      'reference_count',
    ],
    extract.preassembly.pages.map((page) => [
      page.path,
      page.title,
      page.machineReadable,
      page.reason,
      page.pdfCount,
      page.componentTableCount,
      page.referenceCount,
    ]),
  );

  await insert(
    'preassembly_reference',
    [
      'page_path',
      'page_title',
      'section',
      'source_kind',
      'line_number',
      'display_name',
      'quantity_text',
      'quantity',
      'resolved_part',
      'match_method',
      'candidates',
    ],
    extract.preassembly.references.map((reference) => [
      reference.pagePath,
      reference.pageTitle,
      reference.section,
      reference.sourceKind,
      reference.lineNumber,
      reference.displayName,
      reference.quantityText,
      reference.quantity,
      reference.resolvedPart,
      reference.matchMethod,
      (reference.candidates ?? []).join(', ') || null,
    ]),
  );

  await insert(
    'packing_page',
    ['path', 'title', 'reference_count'],
    extract.packing.pages.map((page) => [page.path, page.title, page.referenceCount]),
  );

  await insert(
    'packing_item',
    [
      'page_path',
      'page_title',
      'section',
      'table_index',
      'row_index',
      'child_index',
      'item_kind',
      'parent_item',
      'item_text',
      'display_name',
      'sub_packing',
      'quantity_standard_text',
      'quantity_standard',
      'quantity_standard_unit',
      'quantity_xl_text',
      'quantity_xl',
      'quantity_xl_unit',
      'resolved_part',
      'match_method',
      'candidates',
    ],
    extract.packing.items.map((item) => [
      item.pagePath,
      item.pageTitle,
      item.section,
      item.tableIndex,
      item.rowIndex,
      item.childIndex,
      item.itemKind,
      item.parentItem,
      item.itemText,
      item.displayName,
      item.subPacking,
      item.quantityStandardText,
      item.quantityStandard,
      item.quantityStandardUnit,
      item.quantityXlText,
      item.quantityXl,
      item.quantityXlUnit,
      item.resolvedPart,
      item.matchMethod,
      (item.candidates ?? []).join(', ') || null,
    ]),
  );

  await insert(
    'quantity_comparison',
    [
      'packing_page',
      'part_name',
      'version',
      'sections',
      'packing_quantity',
      'part_quantity',
      'difference',
      'status',
      'note',
    ],
    extract.comparisons.map((comparison) => [
      comparison.packingPage,
      comparison.partName,
      comparison.version,
      comparison.sections,
      comparison.packingQuantity,
      comparison.partQuantity,
      comparison.difference,
      comparison.status,
      comparison.note,
    ]),
  );

  await insert(
    'quantity_difference',
    [
      'packing_page',
      'part_name',
      'version',
      'sections',
      'packing_quantity',
      'part_quantity',
      'packing_minus_part',
    ],
    extract.comparisons
      .filter((comparison) => comparison.status === 'difference')
      .map((comparison) => [
        comparison.packingPage,
        comparison.partName,
        comparison.version,
        comparison.sections,
        comparison.packingQuantity,
        comparison.partQuantity,
        comparison.difference,
      ]),
  );

  await insert(
    'unmatched_name',
    [
      'display_name',
      'normalized_name',
      'singular_name',
      'reference_count',
      'source_kinds',
      'source_pages',
      'status',
      'candidates',
    ],
    extract.unmatched.map((entry) => [
      entry.displayName,
      entry.normalizedName,
      entry.singularName,
      entry.referenceCount,
      entry.sourceKinds,
      entry.sourcePages,
      entry.status,
      entry.candidates || null,
    ]),
  );

  const versionReader = await connection.runAndReadAll('SELECT version()');
  const duckdbVersion = String(versionReader.getRows()[0][0]);
  const metadata = [
    ['source_label', SOURCE_LABEL],
    ['source_pin', EXPECTED_PIN],
    ['schema_version', SCHEMA_VERSION],
    ['part_count', String(extract.parts.length)],
    ['assembly_page_count', String(extract.assembly.pages.length)],
    ['preassembly_page_count', String(extract.preassembly.pages.length)],
    ['packing_page_count', String(extract.packing.pages.length)],
    ['duckdb_version', duckdbVersion],
  ].sort((a, b) => a[0].localeCompare(b[0]));
  await insert('extract_metadata', ['key', 'value'], metadata);

  await connection.run('CHECKPOINT');
  connection.closeSync();
  instance.closeSync();
}

function canonicalValue(value) {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

// Hash of a stable dump of every table, not of the .duckdb file bytes.
// DuckDB's native file is not bit-identical across runs of the same
// insert (same logical rows; a small number of storage bytes change).
export async function canonicalDigest(dbPath) {
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  try {
    const tableReader = await connection.runAndReadAll(
      "SELECT table_name FROM information_schema.tables " +
        "WHERE table_schema = 'main' AND table_type = 'BASE TABLE' " +
        'ORDER BY table_name',
    );
    const tables = tableReader.getRowObjectsJS().map((row) => row.table_name);
    const hash = createHash('sha256');
    hash.update('farmbot-canonical-v1\n');
    for (const table of tables) {
      const colReader = await connection.runAndReadAll(
        'SELECT column_name FROM information_schema.columns ' +
          "WHERE table_schema = 'main' AND table_name = ? " +
          'ORDER BY ordinal_position',
        [table],
      );
      const columns = colReader.getRowObjectsJS().map((row) => row.column_name);
      const quoted = columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(', ');
      const safeTable = table.replaceAll('"', '""');
      const rowReader = await connection.runAndReadAll(
        `SELECT ${quoted} FROM "${safeTable}" ORDER BY ${quoted}`,
      );
      hash.update(`#${table}\n`);
      hash.update(`${JSON.stringify(columns)}\n`);
      for (const row of rowReader.getRowObjectsJS()) {
        const values = columns.map((column) => canonicalValue(row[column]));
        hash.update(`${JSON.stringify(values)}\n`);
      }
    }
    return hash.digest('hex');
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

function parseArguments(argv) {
  const options = {
    source: process.env.FARMBOT_GENESIS_DIR || DEFAULT_SOURCE,
    outDir: process.env.FARMBOT_OUT_DIR || DEFAULT_OUT_DIR,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === '--source' || argument === '--out') {
      const value = argv[i + 1];
      if (!value) throw new Error(`${argument} requires a path`);
      if (argument === '--source') options.source = resolve(value);
      else options.outDir = resolve(value);
      i += 1;
    } else if (argument.startsWith('--source=')) {
      options.source = resolve(argument.slice('--source='.length));
    } else if (argument.startsWith('--out=')) {
      options.outDir = resolve(argument.slice('--out='.length));
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

export async function runExtract(options = {}) {
  const sourceDir = options.source ?? DEFAULT_SOURCE;
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  verifySource(sourceDir);

  const categories = readCategories(sourceDir);
  const parts = readParts(sourceDir, categories);
  if (parts.length !== 149) {
    throw new Error(
      `expected 149 part pages with a quantity key at ${sourceDir}, found ${parts.length}`,
    );
  }

  const index = buildPartIndex(parts);
  const assembly = readAssembly(sourceDir, index, parts);
  const preassembly = readPreassembly(sourceDir, index, parts);
  const packing = readPacking(sourceDir, index, parts);

  const comparisons = deriveQuantityComparisons(parts, packing.items);
  const unmatched = deriveUnmatched([
    ...assembly.references.map((reference) => ({
      ...reference,
      sourceCategory: 'assembly',
    })),
    ...preassembly.references.map((reference) => ({
      ...reference,
      sourceCategory: `pre-assembly ${reference.sourceKind}`,
    })),
    ...packing.items.map((item) => ({ ...item, sourceCategory: 'packing list' })),
  ]);

  const extract = {
    parts,
    categories,
    assembly,
    preassembly,
    packing,
    comparisons,
    unmatched,
  };

  const outFile = join(outDir, OUTPUT_NAME);
  await buildDatabase(outFile, extract);
  const digest = await canonicalDigest(outFile);
  const hashFile = `${outFile}.sha256`;
  rmSync(hashFile, { force: true });
  await writeFile(hashFile, `${digest}\n`, 'utf8');

  return {
    outFile,
    hashFile,
    digest,
    parts: parts.length,
    variants: parts.reduce((sum, part) => sum + part.variants.length, 0),
    assemblyPages: assembly.pages.length,
    assemblyReferences: assembly.references.length,
    preassemblyPages: preassembly.pages.length,
    packingPages: packing.pages.length,
    packingItems: packing.items.length,
    comparisons: comparisons.length,
    differences: comparisons.filter((comparison) => comparison.status === 'difference').length,
    unmatched: unmatched.length,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const summary = await runExtract(options);
    console.log(`FarmBot extract written: ${summary.outFile}`);
    console.log(`canonical SHA-256: ${summary.digest}`);
    console.log(`parts: ${summary.parts}`);
    console.log(`variants: ${summary.variants}`);
    console.log(`assembly pages/references: ${summary.assemblyPages}/${summary.assemblyReferences}`);
    console.log(`pre-assembly pages: ${summary.preassemblyPages}`);
    console.log(`packing pages/items: ${summary.packingPages}/${summary.packingItems}`);
    console.log(`quantity comparisons: ${summary.comparisons} (differences: ${summary.differences})`);
    console.log(`unmatched display names: ${summary.unmatched}`);
  } catch (error) {
    console.error(`FarmBot extract failed: ${error.message}`);
    process.exitCode = 1;
  }
}
