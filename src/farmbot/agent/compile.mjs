// Compile one check Intent with the same compiler options the FarmBot screen
// uses. No post-compile rewrite is applied: every check Intent is a plain
// forward traversal, and duplicate rows are collapsed in the rule module.

import { ONTOLOGY_PATH_HINT } from '../plan.mjs';

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
 * @param {CypherCompiler} engine A loaded Ontographia engine.
 * @param {string} ontology Native ontology text.
 * @param {object} intent The check Intent JSON.
 * @returns {{ query: string, params: Record<string, unknown> }}
 */
export function compileCheck(engine, ontology, intent) {
  return engine.buildCypher(ontology, intent, {
    dialect: 'cypher25',
    ontologyPathHint: ONTOLOGY_PATH_HINT,
  });
}
