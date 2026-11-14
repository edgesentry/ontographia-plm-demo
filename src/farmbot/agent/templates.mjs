// Fixed per-rule text for causes and countermeasures.
//
// A cause is labelled `fact` when it restates a value from the evidence or the
// seed, and `inference` when it is a candidate explanation. The tool shows that
// two documents disagree; it never decides which document is right. Cause
// entries that point at another rule carry that rule id in `rule`.
//
// Countermeasures are fixed sentences per rule. They are not derived from
// third-party text: every value interpolated here is a seeded name, path or
// integer.

/**
 * @typedef {{ kind: 'fact' | 'inference', rule: string | null, text: string }} Cause
 */

/**
 * @param {'fact' | 'inference'} kind
 * @param {string} text
 * @param {string | null} [rule]
 * @returns {Cause}
 */
function cause(kind, text, rule = null) {
  return { kind, rule, text };
}

/**
 * Describe the non-machine-readable pre-assembly pages as a cause candidate.
 *
 * @param {readonly string[]} paths Sorted page paths.
 * @returns {Cause}
 */
export function r5CauseCandidate(paths) {
  if (paths.length === 0) {
    return cause(
      'inference',
      'R5: no pre-assembly page lacks a machine-readable parts table on the current seed.',
      'R5',
    );
  }
  return cause(
    'inference',
    `R5: ${paths.length} pre-assembly page(s) have no machine-readable parts table ` +
      `(${paths.join(', ')}), so their component lists cannot appear as references.`,
    'R5',
  );
}

/**
 * @param {{ file: string, partName: string, variantCode: string, packingQuantity: number, partQuantity: number, quantityDifference: number }} facts
 * @returns {Cause[]}
 */
export function quantityCauses(facts) {
  const direction = facts.quantityDifference > 0 ? 'higher' : 'lower';
  return [
    cause(
      'fact',
      `The packing list on ${facts.file} gives ${facts.packingQuantity} for ` +
        `${facts.partName} (${facts.variantCode}); the part page gives ${facts.partQuantity}.`,
    ),
    cause(
      'fact',
      `The packing quantity is ${direction} by ${Math.abs(facts.quantityDifference)}.`,
    ),
    cause(
      'inference',
      'The two documents disagree; either may be stale, and this tool does not decide which count is intended.',
    ),
  ];
}

/**
 * @param {{ partName: string, variantCode: string }} facts
 * @returns {string[]}
 */
export function quantityCountermeasures(facts) {
  return [
    `Confirm the intended count for ${facts.partName} (${facts.variantCode}) with manufacturing.`,
    'Correct whichever of the packing list and the part page is out of date, then rebuild the extract.',
  ];
}

/**
 * @param {{ displayName: string, lineCount: number, structureCount: number }} facts
 * @returns {Cause[]}
 */
export function unresolvedReferenceCauses(facts) {
  return [
    cause(
      'fact',
      `The name "${facts.displayName}" appears on ${facts.lineCount} reference line(s) ` +
        `across ${facts.structureCount} page(s), and none of them resolves to a part.`,
    ),
    cause(
      'inference',
      'The name may be misspelled, may use a synonym for a part listed under another name, or may refer to an item that has no part page.',
    ),
  ];
}

/**
 * @param {{ displayName: string }} facts
 * @returns {string[]}
 */
export function unresolvedReferenceCountermeasures(facts) {
  return [
    `Add a part page for "${facts.displayName}" or correct the spelling at the listed lines.`,
    'If the name is a synonym, record the mapping so the same reference resolves on the next extract.',
  ];
}

/**
 * @param {{ partName: string, categorySlug: string, r5Paths: readonly string[] }} facts
 * @returns {Cause[]}
 */
export function unreferencedPartCauses(facts) {
  return [
    cause(
      'fact',
      `No assembly chapter, pre-assembly, bag or packing usage references ${facts.partName} in the extract.`,
    ),
    cause('fact', `The part is filed under the BOM category ${facts.categorySlug}.`),
    cause(
      'inference',
      'The part may be unused, superseded, or documented only on a page whose component list is not machine-readable.',
    ),
    r5CauseCandidate(facts.r5Paths),
  ];
}

/**
 * @param {{ partName: string }} facts
 * @returns {string[]}
 */
export function unreferencedPartCountermeasures(facts) {
  return [
    `Confirm whether ${facts.partName} is still in the BOM and remove or re-file it if it is not.`,
    'If the part belongs to a pre-assembly, add a machine-readable parts table to that page.',
  ];
}

/**
 * @param {{ partName: string, files: readonly string[], r5Paths: readonly string[] }} facts
 * @returns {Cause[]}
 */
export function packedWithoutProcessCauses(facts) {
  return [
    cause(
      'fact',
      `${facts.partName} is packed on ${facts.files.join(', ')} but no assembly chapter, ` +
        'pre-assembly or bag usage references it.',
    ),
    cause(
      'inference',
      'The part may be a deliberate shipping spare, or an assembly step that uses it may be missing from the extract.',
    ),
    r5CauseCandidate(facts.r5Paths),
  ];
}

/**
 * @param {{ partName: string }} facts
 * @returns {string[]}
 */
export function packedWithoutProcessCountermeasures(facts) {
  return [
    `Confirm whether ${facts.partName} is a deliberate spare in the packing list.`,
    'Otherwise add the missing assembly chapter or pre-assembly reference so the packed part has a process step.',
  ];
}

/**
 * @param {{ path: string, reason: string, pdfCount: number }} facts
 * @returns {Cause[]}
 */
export function unreadablePageCauses(facts) {
  return [
    cause(
      'fact',
      `The pre-assembly page ${facts.path} has no machine-readable parts table ` +
        `(${facts.reason}; ${facts.pdfCount} PDF file(s)).`,
    ),
    cause(
      'inference',
      'Components of this page cannot be linked to part pages, so checks that rely on pre-assembly references cannot see them.',
    ),
  ];
}

/**
 * @param {{ path: string }} facts
 * @returns {string[]}
 */
export function unreadablePageCountermeasures(facts) {
  return [
    `Add a Markdown parts table to ${facts.path}, or record the component list from the PDF extract.`,
  ];
}
