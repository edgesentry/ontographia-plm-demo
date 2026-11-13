// Read the declared endpoint classes of every relationship from the committed
// native ontology text, without a YAML runtime dependency.
//
// The browser has to name a label when it creates a seed edge
// (`MATCH (a:From {id: ...}), (b:To {id: ...})`), and the declared classes are
// in farmbot/ontology/farmbot.native.yaml. The file is committed and its
// `relationships:` block is a flat list of `name` / `from_class` / `to_class`
// scalars, so a small line parser is enough. farmbot/test/screen.test.mjs
// checks the result against the full YAML parse used by the graph generator.

/**
 * @typedef {{ from: string, to: string }} RelationshipEndpoints
 */

/**
 * Parse the `relationships:` section of the native ontology.
 *
 * @param {string} text Native ontology YAML.
 * @returns {Map<string, RelationshipEndpoints>}
 */
export function parseRelationshipEndpoints(text) {
  const relationships = new Map();
  let inSection = false;
  /** @type {{ name: string | null, from: string | null, to: string | null } | null} */
  let current = null;

  const finish = () => {
    if (!current) return;
    if (!current.name || !current.from || !current.to) {
      throw new Error(
        `incomplete relationship declaration in the ontology: ${JSON.stringify(current)}`,
      );
    }
    if (relationships.has(current.name)) {
      throw new Error(`duplicate relationship declaration ${current.name}`);
    }
    relationships.set(current.name, { from: current.from, to: current.to });
    current = null;
  };

  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;

    if (/^\S/.test(line)) {
      if (/^relationships:\s*$/.test(line)) {
        inSection = true;
        continue;
      }
      if (inSection) break;
      continue;
    }
    if (!inSection) continue;

    const name = /^\s*-\s+name:\s*(\S+)\s*$/.exec(line);
    if (name) {
      finish();
      current = { name: name[1], from: null, to: null };
      continue;
    }
    const from = /^\s+from_class:\s*(\S+)\s*$/.exec(line);
    if (from && current) {
      current.from = from[1];
      continue;
    }
    const to = /^\s+to_class:\s*(\S+)\s*$/.exec(line);
    if (to && current) {
      current.to = to[1];
    }
  }
  finish();

  if (relationships.size === 0) {
    throw new Error('no relationship declarations found in the ontology');
  }
  return relationships;
}
