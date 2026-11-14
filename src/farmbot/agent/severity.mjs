// Severity formula for a finding.
//
// Every finding carries four non-negative factors:
//
//   P  processes reached          distinct structure nodes in the evidence
//   V  product variants reached   distinct product variant codes reached
//   Q  quantity difference        absolute packing-minus-part difference
//   O  overlap                    other findings with the same subject node id
//
// score = 2P + V + min(Q, 10) + 2O
//
// levels: score >= 10 "action", score >= 6 "review", otherwise "info".
// R3 and R4 are always "info": they report a gap in the extract, not a
// disagreement between two documents, and the missing pre-assembly data can
// explain them without any action on the part.
//
// The factors are integers and every input is derived from the committed seed,
// so the level is reproducible. The formula is documented in
// farmbot/docs/checks.md.

export const SEVERITY_WEIGHTS = Object.freeze({
  process: 2,
  variant: 1,
  quantityCap: 10,
  overlap: 2,
});

export const SEVERITY_THRESHOLDS = Object.freeze({
  action: 10,
  review: 6,
});

export const INFO_ONLY_RULES = Object.freeze(['R3', 'R4']);

/**
 * @typedef {{
 *   processesReached: number,
 *   productVariantsReached: number,
 *   quantityDifference: number,
 *   overlap: number,
 * }} SeverityFactors
 * @typedef {{ level: 'action' | 'review' | 'info', score: number }} Severity
 */

/**
 * @param {string} ruleId
 * @param {SeverityFactors} factors
 * @returns {Severity}
 */
export function evaluateSeverity(ruleId, factors) {
  const quantity = Math.min(
    Math.max(Math.trunc(factors.quantityDifference), 0),
    SEVERITY_WEIGHTS.quantityCap,
  );
  const score =
    SEVERITY_WEIGHTS.process * factors.processesReached +
    SEVERITY_WEIGHTS.variant * factors.productVariantsReached +
    quantity +
    SEVERITY_WEIGHTS.overlap * factors.overlap;
  if (INFO_ONLY_RULES.includes(ruleId)) return { level: 'info', score };
  if (score >= SEVERITY_THRESHOLDS.action) return { level: 'action', score };
  if (score >= SEVERITY_THRESHOLDS.review) return { level: 'review', score };
  return { level: 'info', score };
}
