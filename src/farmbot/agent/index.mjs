// FarmBot check engine: compile -> execute -> rule evaluation -> findings.
//
// The engine is plain ESM and has no Node-only import. The caller supplies the
// compiler, the executor, the ontology text, the check Intent JSON and a map of
// node ids to source files. `farmbot/scripts/agent-farmbot.mjs` supplies these
// from the committed seed and a Relate session; the browser screen will supply
// the same values later.
//
// Set differences, deduplication and arithmetic happen here, in the rule
// module, because Ontographia 0.1.9 emits no negation, no sums and no DISTINCT.
// No Cypher is written by this module: every statement is the compiler's output
// for a check Intent under farmbot/checks/.

import {
  CHECKS,
  INTENT_FILES,
  PACKING_INTENTS,
  PROCESS_INTENTS,
  REFERENCE_INTENTS,
} from './checks.mjs';
import { compileCheck } from './compile.mjs';
import { assignFindingIds, findingSubjectKey } from './ids.mjs';
import { evaluateSeverity } from './severity.mjs';
import {
  packedWithoutProcessCauses,
  packedWithoutProcessCountermeasures,
  quantityCauses,
  quantityCountermeasures,
  unreadablePageCauses,
  unreadablePageCountermeasures,
  unreferencedPartCauses,
  unreferencedPartCountermeasures,
  unresolvedReferenceCauses,
  unresolvedReferenceCountermeasures,
} from './templates.mjs';
import { nodeProperties } from './values.mjs';

/**
 * @typedef {{
 *   buildCypher: (
 *     ontology: string,
 *     intent: object,
 *     options?: { dialect?: string, ontologyPathHint?: string },
 *   ) => { query: string, params: Record<string, unknown> }
 * }} CypherCompiler
 * @typedef {(query: string, params: Record<string, unknown>) => Array<Record<string, unknown>>} CheckExecutor
 * @typedef {{
 *   engine: CypherCompiler,
 *   ontology: string,
 *   checks: Record<string, object>,
 *   execute: CheckExecutor,
 *   sources?: Record<string, string> | Map<string, string>,
 *   seed: { digest: string, bytes: number },
 * }} CollectOptions
 */

const SEVERITY_LEVELS = Object.freeze(['action', 'info', 'review']);

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function valueOrNull(value) {
  return value === undefined ? null : value;
}

/**
 * @param {string} text
 * @returns {string}
 */
function compareText(text, other) {
  return text < other ? -1 : text > other ? 1 : 0;
}

/**
 * Sort evidence rows by role and then by seed node id.
 *
 * @param {Array<{ role: string, nodeId: string }>} evidence
 * @returns {Array<{ role: string, nodeId: string }>}
 */
function sortEvidence(evidence) {
  return evidence.sort(
    (left, right) =>
      compareText(left.role, right.role) || compareText(left.nodeId, right.nodeId),
  );
}

/**
 * Identity of one evidence row: role, seed node id, source file and line.
 * Within one finding those four fields describe the same citation of the same
 * node, so repeated rows are collapsed before sorting.
 *
 * @param {{ role: string, nodeId: string, sourceFile: string | null, line: number | null }} row
 * @returns {string}
 */
function evidenceIdentity(row) {
  return JSON.stringify([row.role, row.nodeId, row.sourceFile, row.line]);
}

/**
 * Drop repeated evidence rows, keeping the first occurrence.
 *
 * @param {Array<{ role: string, nodeId: string, sourceFile: string | null, line: number | null }>} evidence
 * @returns {Array<{ role: string, nodeId: string, sourceFile: string | null, line: number | null }>}
 */
function uniqueEvidence(evidence) {
  const seen = new Set();
  return evidence.filter((row) => {
    const identity = evidenceIdentity(row);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/**
 * Deduplicate and sort the evidence rows of one finding.
 *
 * @param {Array<{ role: string, nodeId: string, sourceFile: string | null, line: number | null }>} evidence
 * @returns {Array<{ role: string, nodeId: string, sourceFile: string | null, line: number | null }>}
 */
function finalizeEvidence(evidence) {
  return sortEvidence(uniqueEvidence(evidence));
}

/**
 * @param {Record<string, unknown>} part
 * @returns {number}
 */
function declaredVariantCount(part) {
  const standard = part.quantity_standard === null || part.quantity_standard === undefined ? 0 : 1;
  const xl = part.quantity_xl === null || part.quantity_xl === undefined ? 0 : 1;
  return standard + xl;
}

/**
 * Add one value to a map of sets.
 *
 * @param {Map<string, Set<string>>} map
 * @param {string} key
 * @param {string} value
 */
function addToSetMap(map, key, value) {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

/**
 * Read the check Intent files, compile each once, and execute it once.
 *
 * @param {CollectOptions} options
 * @returns {{ plans: Map<string, { file: string, intent: object, query: string, params: Record<string, unknown> }>, rows: Map<string, Array<Record<string, unknown>>> }}
 */
function runIntents(options) {
  const plans = new Map();
  for (const name of INTENT_FILES) {
    const intent = options.checks[name];
    if (!intent || typeof intent !== 'object') {
      throw new Error(`missing check Intent ${name}`);
    }
    const compiled = compileCheck(options.engine, options.ontology, intent);
    plans.set(name, {
      file: `farmbot/checks/${name}`,
      intent,
      query: compiled.query,
      params: compiled.params,
    });
  }

  const rows = new Map();
  for (const [name, plan] of plans) {
    const result = options.execute(plan.query, plan.params);
    if (!Array.isArray(result)) {
      throw new Error(`check Intent ${name} did not return a row array`);
    }
    if (typeof plan.intent.limit === 'number' && result.length >= plan.intent.limit) {
      throw new Error(
        `check Intent ${name} returned ${result.length} rows and reached its limit ${plan.intent.limit}`,
      );
    }
    rows.set(name, result);
  }
  return { plans, rows };
}

/**
 * Compile and execute every check Intent, evaluate R1-R5, and return the
 * findings document as plain data. The caller serializes it canonically.
 *
 * @param {CollectOptions} options
 * @returns {{
 *   format: string,
 *   seed: { digest: string, bytes: number },
 *   rules: Array<Record<string, unknown>>,
 *   findings: Array<Record<string, unknown>>,
 * }}
 */
export function collectFindings(options) {
  if (!options || typeof options !== 'object') throw new Error('collectFindings needs options');
  const { seed } = options;
  if (!seed || typeof seed.digest !== 'string' || !Number.isInteger(seed.bytes)) {
    throw new Error('collectFindings needs the seed digest and byte length');
  }
  if (typeof options.execute !== 'function') throw new Error('collectFindings needs execute');

  const { plans, rows } = runIntents(options);

  /**
   * @param {string} nodeId
   * @returns {string | null}
   */
  const sourceOf = (nodeId) => {
    const sources = options.sources;
    if (!sources) return null;
    if (sources instanceof Map) return sources.get(nodeId) ?? null;
    return Object.prototype.hasOwnProperty.call(sources, nodeId) ? sources[nodeId] : null;
  };

  /** @param {string} ruleId */
  const ruleOf = (ruleId) => {
    const rule = CHECKS.find((candidate) => candidate.id === ruleId);
    if (!rule) throw new Error(`unknown rule ${ruleId}`);
    return rule;
  };

  const queryFor = (rule) =>
    rule.intents
      .map((name) => plans.get(name))
      .sort((left, right) => compareText(left.file, right.file))
      .map((plan) => ({
        cypher: plan.query,
        intent: plan.file,
        params: plan.params,
      }));

  // All resolved references, one entry per usage line.
  const references = [];
  for (const [kind, name] of Object.entries(REFERENCE_INTENTS)) {
    for (const row of rows.get(name)) {
      references.push({
        kind,
        structure: nodeProperties(row.structure),
        usage: nodeProperties(row.usage),
        part: nodeProperties(row.part),
      });
    }
  }

  /** @type {Map<string, Array<typeof references[number]>>} */
  const referencesByPart = new Map();
  /** @type {Map<string, Set<string>>} */
  const allStructuresByPart = new Map();
  /** @type {Map<string, Set<string>>} */
  const processStructuresByPart = new Map();
  /** @type {Map<string, Set<string>>} */
  const packingStructuresByPart = new Map();
  for (const reference of references) {
    const partName = reference.part.name;
    if (typeof partName !== 'string') throw new Error('reference row has no part name');
    let list = referencesByPart.get(partName);
    if (!list) {
      list = [];
      referencesByPart.set(partName, list);
    }
    list.push(reference);
    addToSetMap(allStructuresByPart, partName, reference.structure.id);
    if (PROCESS_INTENTS.includes(REFERENCE_INTENTS[reference.kind])) {
      addToSetMap(processStructuresByPart, partName, reference.structure.id);
    }
    if (PACKING_INTENTS.includes(REFERENCE_INTENTS[reference.kind])) {
      addToSetMap(packingStructuresByPart, partName, reference.structure.id);
    }
  }

  /** @type {Array<Record<string, unknown>>} */
  const findings = [];

  // R5 first: its page list is a cause candidate in every R3 and R4 finding.
  const r5Rows = rows.get('r5-unreadable-preassemblies.json');
  const r5Pages = r5Rows
    .map((row) => nodeProperties(row.page))
    .sort((left, right) => compareText(left.path ?? '', right.path ?? ''));
  const r5Paths = r5Pages.map((page) => page.path ?? '');

  for (const page of r5Pages) {
    const subjectKey = page.path ?? page.id;
    findings.push({
      causes: unreadablePageCauses({
        path: page.path ?? '',
        reason: page.machine_readable_reason ?? 'no reason recorded',
        pdfCount: page.pdf_count ?? 0,
      }),
      countermeasures: unreadablePageCountermeasures({ path: page.path ?? '' }),
      evidence: finalizeEvidence([
        {
          nodeId: page.id,
          role: 'pre-assembly-page',
          sourceFile: page.path ?? sourceOf(page.id),
          line: null,
          facts: {
            machineReadableReason: valueOrNull(page.machine_readable_reason),
            pdfCount: valueOrNull(page.pdf_count),
            title: valueOrNull(page.title),
          },
        },
      ]),
      queries: queryFor(ruleOf('R5')),
      rule: 'R5',
      severityFactors: {
        overlap: 0,
        processesReached: 1,
        productVariantsReached: 0,
        quantityDifference: 0,
      },
      subject: {
        key: subjectKey,
        kind: 'pre-assembly-page',
        label: page.title ?? subjectKey,
        nodeId: page.id,
      },
      summary: `The pre-assembly page ${page.path ?? subjectKey} has no machine-readable parts table.`,
    });
  }

  // R1: one finding per QuantityDifference row.
  const comparisons = new Map();
  for (const row of rows.get('r1-quantity-difference.json')) {
    const difference = nodeProperties(row.difference);
    const part = nodeProperties(row.part);
    comparisons.set(difference.id, { difference, part });
  }
  for (const row of rows.get('r1-compared-in.json')) {
    const difference = nodeProperties(row.difference);
    const entry = comparisons.get(difference.id);
    if (entry) entry.container = nodeProperties(row.container);
  }
  for (const row of rows.get('r1-for-variant.json')) {
    const difference = nodeProperties(row.difference);
    const entry = comparisons.get(difference.id);
    if (entry) entry.variant = nodeProperties(row.variant);
  }
  /** @type {Map<string, Set<string>>} */
  const variantCodesByPart = new Map();
  for (const entry of comparisons.values()) {
    const code = entry.variant?.code;
    if (typeof code === 'string') addToSetMap(variantCodesByPart, entry.part.name, code);
  }
  for (const entry of [...comparisons.values()].sort((left, right) =>
    compareText(left.difference.id, right.difference.id),
  )) {
    const { difference, part, container, variant } = entry;
    const variantCode = typeof variant?.code === 'string' ? variant.code : 'unspecified';
    const quantityDifference = Number(difference.packing_minus_part);
    const file = container?.path ?? '';
    const packingLines = (referencesByPart.get(part.name) ?? []).filter(
      (reference) =>
        (reference.kind === 'kit' || reference.kind === 'carton') &&
        reference.structure.id === container?.id,
    );
    const evidence = [
      {
        nodeId: difference.id,
        role: 'quantity-difference',
        sourceFile: file === '' ? null : file,
        line: null,
        facts: {
          packingQuantity: valueOrNull(difference.packing_quantity),
          partQuantity: valueOrNull(difference.part_quantity),
          quantityDifference: valueOrNull(difference.packing_minus_part),
          version: variantCode,
        },
      },
      {
        nodeId: part.id,
        role: 'part',
        sourceFile: sourceOf(part.id),
        line: null,
        facts: { name: part.name },
      },
    ];
    for (const line of packingLines) {
      evidence.push({
        nodeId: line.usage.id,
        role: 'packing-line',
        sourceFile: line.structure.path ?? null,
        line: valueOrNull(line.usage.line_number),
        facts: {
          displayName: valueOrNull(line.usage.display_name),
          quantity: valueOrNull(line.usage.quantity),
        },
      });
    }
    findings.push({
      causes: quantityCauses({
        file,
        partName: part.name,
        variantCode,
        packingQuantity: Number(difference.packing_quantity),
        partQuantity: Number(difference.part_quantity),
        quantityDifference,
      }),
      countermeasures: quantityCountermeasures({ partName: part.name, variantCode }),
      evidence: finalizeEvidence(evidence),
      queries: queryFor(ruleOf('R1')),
      rule: 'R1',
      severityFactors: {
        overlap: 0,
        processesReached: allStructuresByPart.get(part.name)?.size ?? 0,
        productVariantsReached: variantCodesByPart.get(part.name)?.size ?? 0,
        quantityDifference: Math.abs(quantityDifference),
      },
      subject: {
        key: `${part.name} ${variantCode}`,
        kind: 'quantity-difference',
        label: `${part.name} (${variantCode})`,
        nodeId: part.id,
      },
      summary:
        `The packing list on ${file} and the part page for ${part.name} ` +
        `disagree by ${quantityDifference} for ${variantCode}.`,
    });
  }

  // R2: one finding per unresolved display name.
  /** @type {Map<string, Array<{ structure: Record<string, unknown>, usage: Record<string, unknown>, kind: string }>>} */
  const unresolvedByName = new Map();
  for (const [name, kind] of [
    ['r2-assembly-unmatched.json', 'assembly'],
    ['r2-manufacturing-unmatched.json', 'manufacturing'],
  ]) {
    for (const row of rows.get(name)) {
      const structure = nodeProperties(row.structure);
      const usage = nodeProperties(row.usage);
      const displayName = typeof usage.display_name === 'string' ? usage.display_name : usage.id;
      let list = unresolvedByName.get(displayName);
      if (!list) {
        list = [];
        unresolvedByName.set(displayName, list);
      }
      list.push({ structure, usage, kind });
    }
  }
  for (const [displayName, list] of [...unresolvedByName.entries()].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    const structures = new Set(list.map((entry) => entry.structure.id));
    const evidence = [];
    for (const entry of list) {
      evidence.push({
        nodeId: entry.structure.id,
        role: 'structure',
        sourceFile: entry.structure.path ?? null,
        line: null,
        facts: { structureKind: entry.kind, title: valueOrNull(entry.structure.title) },
      });
      evidence.push({
        nodeId: entry.usage.id,
        role: 'reference',
        sourceFile: entry.structure.path ?? null,
        line: valueOrNull(entry.usage.line_number),
        facts: {
          displayName,
          matchMethod: valueOrNull(entry.usage.match_method),
        },
      });
    }
    findings.push({
      causes: unresolvedReferenceCauses({
        displayName,
        lineCount: list.length,
        structureCount: structures.size,
      }),
      countermeasures: unresolvedReferenceCountermeasures({ displayName }),
      evidence: finalizeEvidence(evidence),
      queries: queryFor(ruleOf('R2')),
      rule: 'R2',
      severityFactors: {
        overlap: 0,
        processesReached: structures.size,
        productVariantsReached: 0,
        quantityDifference: 0,
      },
      subject: { key: displayName, kind: 'unresolved-name', label: displayName, nodeId: null },
      summary: `"${displayName}" appears on ${list.length} reference line(s) and resolves to no part.`,
    });
  }

  // R3: parts with no reference at all.
  const parts = rows
    .get('r3-parts.json')
    .map((row) => nodeProperties(row.part))
    .sort((left, right) => compareText(left.id, right.id));
  for (const part of parts) {
    if (referencesByPart.has(part.name)) continue;
    findings.push({
      causes: unreferencedPartCauses({
        categorySlug: part.category_slug ?? '',
        partName: part.name,
        r5Paths,
      }),
      countermeasures: unreferencedPartCountermeasures({ partName: part.name }),
      evidence: finalizeEvidence([
        {
          nodeId: part.id,
          role: 'part',
          sourceFile: sourceOf(part.id),
          line: null,
          facts: {
            categorySlug: valueOrNull(part.category_slug),
            name: part.name,
            slug: valueOrNull(part.slug),
          },
        },
      ]),
      queries: queryFor(ruleOf('R3')),
      rule: 'R3',
      severityFactors: {
        overlap: 0,
        processesReached: 0,
        productVariantsReached: declaredVariantCount(part),
        quantityDifference: 0,
      },
      subject: { key: part.name, kind: 'part', label: part.name, nodeId: part.id },
      summary: `${part.name} is referenced by no assembly chapter, pre-assembly, bag or packing list.`,
    });
  }

  // R4: parts packed but absent from process documentation. Every packing
  // reference row carries its whole Part node, so the rule is derived from the
  // kit and carton rows and does not scan the full part list.
  /** @type {Map<string, Record<string, unknown>>} */
  const packedPartsByName = new Map();
  for (const reference of references) {
    if (!PACKING_INTENTS.includes(REFERENCE_INTENTS[reference.kind])) continue;
    const partName = reference.part.name;
    if (typeof partName !== 'string') continue;
    packedPartsByName.set(partName, reference.part);
  }
  const packedParts = [...packedPartsByName.values()].sort((left, right) =>
    compareText(/** @type {string} */ (left.id), /** @type {string} */ (right.id)),
  );
  for (const part of packedParts) {
    if (processStructuresByPart.has(part.name)) continue;
    const packingLines = (referencesByPart.get(part.name) ?? []).filter(
      (reference) => reference.kind === 'kit' || reference.kind === 'carton',
    );
    const files = [...new Set(packingLines.map((line) => line.structure.path ?? ''))].sort(
      compareText,
    );
    const evidence = [
      {
        nodeId: part.id,
        role: 'part',
        sourceFile: sourceOf(part.id),
        line: null,
        facts: {
          categorySlug: valueOrNull(part.category_slug),
          name: part.name,
          slug: valueOrNull(part.slug),
        },
      },
    ];
    for (const line of packingLines) {
      evidence.push({
        nodeId: line.structure.id,
        role: 'packing-structure',
        sourceFile: line.structure.path ?? null,
        line: null,
        facts: { title: valueOrNull(line.structure.title) },
      });
      evidence.push({
        nodeId: line.usage.id,
        role: 'packing-line',
        sourceFile: line.structure.path ?? null,
        line: valueOrNull(line.usage.line_number),
        facts: {
          displayName: valueOrNull(line.usage.display_name),
          quantity: valueOrNull(line.usage.quantity),
        },
      });
    }
    findings.push({
      causes: packedWithoutProcessCauses({ files, partName: part.name, r5Paths }),
      countermeasures: packedWithoutProcessCountermeasures({ partName: part.name }),
      evidence: finalizeEvidence(evidence),
      queries: queryFor(ruleOf('R4')),
      rule: 'R4',
      severityFactors: {
        overlap: 0,
        processesReached: packingStructuresByPart.get(part.name)?.size ?? 0,
        productVariantsReached: declaredVariantCount(part),
        quantityDifference: 0,
      },
      subject: { key: part.name, kind: 'part', label: part.name, nodeId: part.id },
      summary: `${part.name} is packed on ${files.join(', ')} but no assembly chapter or pre-assembly references it.`,
    });
  }

  // Overlap: the number of other findings with the same subject node id. A
  // part compared for both product variants has two findings on the same part,
  // so both carry overlap 1; R2 subjects are display names and have no node.
  /** @type {Map<string, number[]>} */
  const owners = new Map();
  for (const [index, finding] of findings.entries()) {
    const subjectNodeId = /** @type {{ nodeId: string | null }} */ (finding.subject).nodeId;
    if (typeof subjectNodeId !== 'string') continue;
    let list = owners.get(subjectNodeId);
    if (!list) {
      list = [];
      owners.set(subjectNodeId, list);
    }
    list.push(index);
  }
  for (const [index, finding] of findings.entries()) {
    const subjectNodeId = /** @type {{ nodeId: string | null }} */ (finding.subject).nodeId;
    const peers = typeof subjectNodeId === 'string' ? (owners.get(subjectNodeId) ?? []) : [];
    /** @type {{ overlap: number }} */ (finding.severityFactors).overlap = Math.max(
      peers.length - 1,
      0,
    );
  }

  // Severity and ids.
  const ids = assignFindingIds(
    findings.map((finding) => ({
      rule: /** @type {string} */ (finding.rule),
      key: /** @type {{ key: string }} */ (finding.subject).key,
    })),
  );
  for (const finding of findings) {
    const factors = /** @type {import('./severity.mjs').SeverityFactors} */ (
      finding.severityFactors
    );
    const severity = evaluateSeverity(/** @type {string} */ (finding.rule), factors);
    const id = ids.get(
      findingSubjectKey(
        /** @type {string} */ (finding.rule),
        /** @type {{ key: string }} */ (finding.subject).key,
      ),
    );
    if (typeof id !== 'string') throw new Error(`no finding id for ${finding.rule}`);
    finding.id = id;
    finding.severity = severity.level;
    finding.severityScore = severity.score;
  }
  findings.sort((left, right) => compareText(String(left.id), String(right.id)));

  const rules = CHECKS.map((rule) => {
    const selected = findings.filter((finding) => finding.rule === rule.id);
    /** @type {Record<string, number>} */
    const severityCounts = {};
    for (const level of SEVERITY_LEVELS) severityCounts[level] = 0;
    for (const finding of selected) severityCounts[String(finding.severity)] += 1;
    return {
      direction: rule.direction,
      findingCount: selected.length,
      id: rule.id,
      intents: [...rule.intents],
      severityCounts,
      title: rule.title,
    };
  });

  return {
    format: 'farmbot-findings-v1',
    seed: { bytes: seed.bytes, digest: seed.digest },
    rules,
    findings,
  };
}
