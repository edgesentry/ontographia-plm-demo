// Shared post-compile step for the two preset questions whose answer is a set.
//
// Ontographia 0.1.9 cannot express DISTINCT: the Intent schema has no such
// field (unknown keys are rejected) and the Cypher 25 emitter writes RETURN
// without DISTINCT. This module is the single implementation of the documented
// rewrite, used by the preset-question tests and by the FarmBot screen, so the
// two cannot drift. See farmbot/intents/README.md.

/**
 * Replace the one `\nRETURN ` of a compiled statement with `\nRETURN DISTINCT `.
 *
 * Every other byte, including the `$param_N` placeholders, is left unchanged.
 *
 * @param {string} query Compiled Cypher text.
 * @returns {string} The same statement with DISTINCT added.
 */
export function insertDistinctReturn(query) {
  const returns = query.match(/\nRETURN /g) ?? [];
  if (returns.length !== 1) {
    throw new Error(
      `expected exactly one RETURN clause in the compiled Cypher, found ${returns.length}`,
    );
  }
  return query.replace('\nRETURN ', '\nRETURN DISTINCT ');
}
