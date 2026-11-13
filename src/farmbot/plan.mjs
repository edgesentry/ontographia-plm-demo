// Compile one preset-question Intent exactly the way the FarmBot screen does.
//
// Both the screen and farmbot/test/screen.test.mjs call this function, so the
// statement that Relate executes cannot drift from the statement the tests
// assert.

import { insertDistinctReturn } from './distinct-return.mjs';

/** The ontology file hint the compiler is given. */
export const ONTOLOGY_PATH_HINT = 'farmbot.native.yaml';

/**
 * @typedef {{
 *   buildCypher: (
 *     ontology: string,
 *     intent: object,
 *     options?: { dialect?: string, ontologyPathHint?: string },
 *   ) => { query: string, params: Record<string, unknown> }
 * }} CypherCompiler
 */

/**
 * @typedef {{
 *   compiled: string,
 *   executed: string,
 *   params: Record<string, unknown>,
 *   distinctApplied: boolean,
 * }} QuestionPlan
 */

/**
 * Compile an Intent and apply the documented DISTINCT step when asked.
 *
 * @param {CypherCompiler} compiler A loaded Ontographia engine.
 * @param {string} ontology Native ontology text.
 * @param {object} intent The Intent JSON, already carrying its filter value.
 * @param {boolean} applyDistinct True for the two set-valued questions.
 * @returns {QuestionPlan}
 */
export function planQuestion(compiler, ontology, intent, applyDistinct) {
  const { query, params } = compiler.buildCypher(ontology, intent, {
    dialect: 'cypher25',
    ontologyPathHint: ONTOLOGY_PATH_HINT,
  });
  return {
    compiled: query,
    executed: applyDistinct ? insertDistinctReturn(query) : query,
    params,
    distinctApplied: applyDistinct,
  };
}
