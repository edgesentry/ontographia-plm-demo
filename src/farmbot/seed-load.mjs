// Load the committed seed into an in-memory Relate database.
//
// Nodes are created per label set with `UNWIND $rows AS row CREATE (n:...) SET
// n += row`, so a node carries its own labels plus its ancestors' labels (the
// generator puts ancestor labels on every concrete node). Edges are then
// matched on the relationship's declared endpoint classes from the ontology.
// This is the same load the preset-question tests perform, moved here so the
// browser and the tests run one implementation.

/**
 * @typedef {{ id: string, labels: string[], properties: Record<string, unknown> }} SeedNode
 * @typedef {{ from: string, to: string, type: string }} SeedEdge
 * @typedef {{ nodes: SeedNode[], edges: SeedEdge[] }} Seed
 * @typedef {{ query: string, params: Record<string, unknown>, kind: 'nodes' | 'edges', name: string }} SeedStatement
 * @typedef {{ execute: (query: string, paramsJson?: string | null) => string }} QueryableDb
 */

/**
 * Group entries by a key, preserving first-seen order.
 *
 * @template T
 * @param {T[]} entries
 * @param {(entry: T) => string} keyOf
 * @returns {Array<[string, T[]]>}
 */
export function groupBy(entries, keyOf) {
  /** @type {Map<string, T[]>} */
  const groups = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(entry);
  }
  return [...groups];
}

/**
 * Turn a seed into the statements that create every node and edge.
 *
 * @param {Seed} seed
 * @param {Map<string, { from: string, to: string }>} relationships
 * @returns {SeedStatement[]} Node statements first, then edge statements.
 */
export function buildSeedStatements(seed, relationships) {
  if (!seed || !Array.isArray(seed.nodes) || !Array.isArray(seed.edges)) {
    throw new Error('seed must have nodes and edges arrays');
  }

  /** @type {SeedStatement[]} */
  const statements = [];
  for (const [labelSet, nodes] of groupBy(seed.nodes, (node) =>
    node.labels.join(':'),
  )) {
    const labelText = labelSet
      .split(':')
      .map((label) => `:${label}`)
      .join('');
    statements.push({
      kind: 'nodes',
      name: labelSet,
      query: `UNWIND $rows AS row CREATE (n${labelText}) SET n += row`,
      params: { rows: nodes.map((node) => ({ id: node.id, ...node.properties })) },
    });
  }

  for (const [type, edges] of groupBy(seed.edges, (edge) => edge.type)) {
    const declaration = relationships.get(type);
    if (!declaration) throw new Error(`undeclared relationship type ${type}`);
    statements.push({
      kind: 'edges',
      name: type,
      query:
        'UNWIND $rows AS row ' +
        `MATCH (a:${declaration.from} {id: row.from}), ` +
        `(b:${declaration.to} {id: row.to}) ` +
        `CREATE (a)-[:${type}]->(b)`,
      params: { rows: edges.map((edge) => ({ from: edge.from, to: edge.to })) },
    });
  }
  return statements;
}

/**
 * Run every seed statement, stopping at the first engine error.
 *
 * @param {QueryableDb} db An open, empty database.
 * @param {SeedStatement[]} statements
 * @returns {{ statements: number }} How many statements were run.
 */
export function loadSeed(db, statements) {
  for (const statement of statements) {
    const envelope = JSON.parse(db.execute(statement.query, JSON.stringify(statement.params)));
    if (envelope.error) {
      throw new Error(`seeding ${statement.kind} ${statement.name}: ${envelope.error}`);
    }
  }
  return { statements: statements.length };
}
