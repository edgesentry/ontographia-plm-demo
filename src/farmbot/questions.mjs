// Preset questions shown on the FarmBot screen.
//
// The Intent JSON files, their default filter values and their return columns
// are committed under farmbot/intents/. This table adds only what the screen
// needs on top: which allowed-values domain feeds the selector and whether the
// answer is a set that needs the documented post-compile DISTINCT step.
//
// A selector is populated only from its committed allowed-values domain; the
// screen never accepts a typed part name or category.

/**
 * @typedef {'q1' | 'q2' | 'q3' | 'q4' | 'q5'} QuestionId
 * @typedef {'part_names_in_assembly_chapters'
 *   | 'part_names_in_all_three_structure_kinds'
 *   | 'category_slugs_in_kits'} SelectorDomain
 * @typedef {{
 *   id: QuestionId,
 *   intentFile: string,
 *   selector: SelectorDomain | null,
 *   distinct: boolean,
 * }} Question
 */

/** @type {readonly Question[]} */
export const QUESTIONS = Object.freeze([
  Object.freeze({
    id: 'q1',
    intentFile: 'q1-packing-differences.json',
    selector: null,
    distinct: false,
  }),
  Object.freeze({
    id: 'q2',
    intentFile: 'q2-assembly-chapters-for-part.json',
    selector: 'part_names_in_assembly_chapters',
    distinct: true,
  }),
  Object.freeze({
    id: 'q3',
    intentFile: 'q3-structures-for-part.json',
    selector: 'part_names_in_all_three_structure_kinds',
    distinct: true,
  }),
  Object.freeze({
    id: 'q4',
    intentFile: 'q4-kit-parts-for-category.json',
    selector: 'category_slugs_in_kits',
    distinct: false,
  }),
  Object.freeze({
    id: 'q5',
    intentFile: 'q5-unmatched-references.json',
    selector: null,
    distinct: false,
  }),
]);

/** @type {readonly QuestionId[]} */
export const QUESTION_IDS = Object.freeze(QUESTIONS.map((question) => question.id));

/**
 * Look up one question by id.
 *
 * @param {QuestionId} id
 * @returns {Question}
 */
export function findQuestion(id) {
  const question = QUESTIONS.find((candidate) => candidate.id === id);
  if (!question) throw new Error(`unknown question ${id}`);
  return question;
}
