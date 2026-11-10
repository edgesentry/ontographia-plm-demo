// In-browser Intent executor over a fixture graph.
//
// This module is deliberately dependency-free and pure so that both the app and
// `scripts/verify.mjs` can exercise the exact same code. It is NOT a graph
// database: it walks the nodes/edges in the JSON fixture. The Cypher produced
// by the WASM compiler is an audit artifact and is never executed here.

export type PropertyValue = string | number | boolean | null;

export interface GraphNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: string;
}

export interface FixtureGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  lanes?: string[];
}

export type IntentDirection = 'in' | 'out';

export interface IntentStart {
  class: string;
  alias: string;
}

export interface IntentTraverseStep {
  relationship: string;
  direction: IntentDirection;
  to: { class: string; alias: string };
}

export interface IntentFilter {
  alias: string;
  property: string;
  op: 'eq';
  value: unknown;
}

export interface IntentReturn {
  alias: string;
  property?: string;
  as_name?: string;
}

export interface Intent {
  start: IntentStart;
  traverse: IntentTraverseStep[];
  filter: IntentFilter[];
  return: IntentReturn[];
  limit?: number;
  optional: boolean;
}

export type ExecutorErrorCode = 'invalid_intent' | 'invalid_graph' | 'unsupported_op';

export class IntentExecutionError extends Error {
  readonly code: ExecutorErrorCode;

  constructor(code: ExecutorErrorCode, message: string) {
    super(message);
    this.name = 'IntentExecutionError';
    this.code = code;
  }
}

export interface ExecutionStats {
  seeds: number;
  bindings: number;
  returned: number;
  limit: number | null;
}

export interface ExecutionResult {
  rows: Array<Record<string, unknown>>;
  pathNodeIds: string[];
  pathEdgeKeys: string[];
  startNodeIds: string[];
  intent: Intent;
  stats: ExecutionStats;
}

export function edgeKey(edge: GraphEdge): string {
  return `${edge.from}->${edge.to}:${edge.type}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new IntentExecutionError('invalid_intent', `${where}.${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, where: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new IntentExecutionError('invalid_intent', `${where}.${key} must be a non-empty string when present`);
  }
  return value;
}

/** Validate and normalise an Intent before execution. */
export function parseIntent(input: unknown): Intent {
  if (!isRecord(input)) {
    throw new IntentExecutionError('invalid_intent', 'Intent must be an object');
  }
  if (!isRecord(input.start)) {
    throw new IntentExecutionError('invalid_intent', 'intent.start must be an object');
  }
  const start: IntentStart = {
    class: requireString(input.start, 'class', 'intent.start'),
    alias: requireString(input.start, 'alias', 'intent.start'),
  };

  const aliases = new Set<string>([start.alias]);

  const traverse: IntentTraverseStep[] = [];
  if (input.traverse !== undefined) {
    if (!Array.isArray(input.traverse)) {
      throw new IntentExecutionError('invalid_intent', 'intent.traverse must be an array');
    }
    input.traverse.forEach((raw, index) => {
      const where = `intent.traverse[${index}]`;
      if (!isRecord(raw) || !isRecord(raw.to)) {
        throw new IntentExecutionError('invalid_intent', `${where} must be an object with a "to" object`);
      }
      const direction = raw.direction;
      if (direction !== 'in' && direction !== 'out') {
        throw new IntentExecutionError('invalid_intent', `${where}.direction must be "in" or "out"`);
      }
      const toAlias = requireString(raw.to, 'alias', `${where}.to`);
      if (aliases.has(toAlias)) {
        throw new IntentExecutionError('invalid_intent', `Duplicate alias "${toAlias}" in intent`);
      }
      aliases.add(toAlias);
      traverse.push({
        relationship: requireString(raw, 'relationship', where),
        direction,
        to: {
          class: requireString(raw.to, 'class', `${where}.to`),
          alias: toAlias,
        },
      });
    });
  }

  const filter: IntentFilter[] = [];
  if (input.filter !== undefined) {
    if (!Array.isArray(input.filter)) {
      throw new IntentExecutionError('invalid_intent', 'intent.filter must be an array');
    }
    input.filter.forEach((raw, index) => {
      const where = `intent.filter[${index}]`;
      if (!isRecord(raw)) {
        throw new IntentExecutionError('invalid_intent', `${where} must be an object`);
      }
      const alias = requireString(raw, 'alias', where);
      if (!aliases.has(alias)) {
        throw new IntentExecutionError('invalid_intent', `${where}.alias "${alias}" is not bound by the intent`);
      }
      const op = raw.op;
      if (op !== 'eq') {
        throw new IntentExecutionError('unsupported_op', `${where}.op "${String(op)}" is not supported (only "eq")`);
      }
      filter.push({
        alias,
        property: requireString(raw, 'property', where),
        op,
        value: raw.value,
      });
    });
  }

  if (!Array.isArray(input.return) || input.return.length === 0) {
    throw new IntentExecutionError('invalid_intent', 'intent.return must be a non-empty array');
  }
  const returns: IntentReturn[] = input.return.map((raw, index) => {
    const where = `intent.return[${index}]`;
    if (!isRecord(raw)) {
      throw new IntentExecutionError('invalid_intent', `${where} must be an object`);
    }
    const alias = requireString(raw, 'alias', where);
    if (!aliases.has(alias)) {
      throw new IntentExecutionError('invalid_intent', `${where}.alias "${alias}" is not bound by the intent`);
    }
    const property = optionalString(raw, 'property', where);
    const asName = optionalString(raw, 'as_name', where);
    if (property === undefined && asName === undefined) {
      throw new IntentExecutionError('invalid_intent', `${where} needs "property" or "as_name"`);
    }
    return { alias, property, as_name: asName };
  });

  let limit: number | undefined;
  if (input.limit !== undefined) {
    if (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 0) {
      throw new IntentExecutionError('invalid_intent', 'intent.limit must be a non-negative integer');
    }
    limit = input.limit;
  }

  let optional = false;
  if (input.optional !== undefined) {
    if (typeof input.optional !== 'boolean') {
      throw new IntentExecutionError('invalid_intent', 'intent.optional must be a boolean');
    }
    optional = input.optional;
  }

  return { start, traverse, filter, return: returns, limit, optional };
}

export interface ClassHierarchy {
  parents: Map<string, string[]>;
  ancestorsOf: (className: string) => Set<string>;
}

/**
 * Minimal parser for the `classes:` section of the native ontology YAML.
 * COM inheritance is read from `super_classes`, so `AFFECTS -> Item` also
 * matches Part, Assembly, Revision and Substance nodes.
 */
export function parseOntology(ontologyYaml: string): ClassHierarchy {
  const parents = new Map<string, string[]>();
  let inClasses = false;
  let current: string | null = null;
  let blockSuper = false;

  for (const line of ontologyYaml.split(/\r?\n/)) {
    const topLevel = /^([A-Za-z_][\w-]*):\s*$/.exec(line);
    if (topLevel) {
      inClasses = topLevel[1] === 'classes';
      current = null;
      blockSuper = false;
      continue;
    }
    if (!inClasses) continue;

    const nameMatch = /^\s*-\s+name:\s*(\S+)\s*$/.exec(line);
    if (nameMatch) {
      current = nameMatch[1];
      if (!parents.has(current)) parents.set(current, []);
      blockSuper = false;
      continue;
    }

    if (!current) continue;

    const inline = /^\s*super_classes:\s*\[(.*)\]\s*$/.exec(line);
    if (inline) {
      const names = inline[1]
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      parents.set(current, names);
      blockSuper = false;
      continue;
    }

    if (/^\s*super_classes:\s*$/.test(line)) {
      blockSuper = true;
      parents.set(current, []);
      continue;
    }

    if (blockSuper) {
      const item = /^\s*-\s+(\S+)\s*$/.exec(line);
      if (item) {
        parents.get(current)!.push(item[1]);
        continue;
      }
      if (/^\s*[A-Za-z_][\w-]*:/.test(line)) blockSuper = false;
    }
  }

  const ancestorsCache = new Map<string, Set<string>>();
  const ancestorsOf = (className: string): Set<string> => {
    const cached = ancestorsCache.get(className);
    if (cached) return cached;
    const result = new Set<string>();
    const stack = [className];
    while (stack.length > 0) {
      const next = stack.pop()!;
      for (const parent of parents.get(next) ?? []) {
        if (!result.has(parent)) {
          result.add(parent);
          stack.push(parent);
        }
      }
    }
    ancestorsCache.set(className, result);
    return result;
  };

  return { parents, ancestorsOf };
}

/** True when any node label is the target class or a subclass of it. */
export function classMatches(labels: string[], targetClass: string, hierarchy: ClassHierarchy): boolean {
  return labels.some((label) => label === targetClass || hierarchy.ancestorsOf(label).has(targetClass));
}

function assertGraph(input: unknown): asserts input is FixtureGraph {
  if (!isRecord(input) || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
    throw new IntentExecutionError('invalid_graph', 'Fixture graph must have "nodes" and "edges" arrays');
  }
}

function matchesFilter(node: GraphNode, filter: IntentFilter): boolean {
  if (!Object.prototype.hasOwnProperty.call(node.properties, filter.property)) return false;
  return node.properties[filter.property] === filter.value;
}

interface Binding {
  nodes: Record<string, string>;
  pathNodes: Set<string>;
  pathEdges: Set<string>;
}

/**
 * Execute an Intent against the fixture graph.
 *
 * Supported: start class, sequential traverse (`in`/`out`), `op: "eq"`
 * filters, return projections and limit. The returned path contains only the
 * start node and the nodes actually reached by the Intent (plus traversed
 * edges); lane hints never expand the path.
 */
export function executeIntent(
  graph: FixtureGraph,
  intentInput: unknown,
  ontologyYaml: string,
): ExecutionResult {
  assertGraph(graph);
  const intent = parseIntent(intentInput);
  const hierarchy = parseOntology(ontologyYaml);

  const nodeById = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (
      !isRecord(node) ||
      typeof node.id !== 'string' ||
      !Array.isArray(node.labels) ||
      !isRecord(node.properties)
    ) {
      throw new IntentExecutionError('invalid_graph', 'Every fixture node needs id, labels and properties');
    }
    nodeById.set(node.id, node);
  }

  const edgesByType = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    if (
      !isRecord(edge) ||
      typeof edge.from !== 'string' ||
      typeof edge.to !== 'string' ||
      typeof edge.type !== 'string'
    ) {
      throw new IntentExecutionError('invalid_graph', 'Every fixture edge needs from, to and type');
    }
    const list = edgesByType.get(edge.type) ?? [];
    list.push(edge);
    edgesByType.set(edge.type, list);
  }

  const startFilters = intent.filter.filter((filter) => filter.alias === intent.start.alias);
  const startNodes = graph.nodes.filter(
    (node) =>
      classMatches(node.labels, intent.start.class, hierarchy) &&
      startFilters.every((filter) => matchesFilter(node, filter)),
  );

  let bindings: Binding[] = startNodes.map((node) => ({
    nodes: { [intent.start.alias]: node.id },
    pathNodes: new Set([node.id]),
    pathEdges: new Set<string>(),
  }));

  let sourceAlias = intent.start.alias;
  for (const step of intent.traverse) {
    if (bindings.length === 0) break;
    const candidates = edgesByType.get(step.relationship) ?? [];
    const next: Binding[] = [];
    for (const binding of bindings) {
      const sourceId = binding.nodes[sourceAlias];
      for (const edge of candidates) {
        let targetId: string;
        if (step.direction === 'out') {
          if (edge.from !== sourceId) continue;
          targetId = edge.to;
        } else {
          if (edge.to !== sourceId) continue;
          targetId = edge.from;
        }
        const target = nodeById.get(targetId);
        if (!target) continue;
        if (!classMatches(target.labels, step.to.class, hierarchy)) continue;
        next.push({
          nodes: { ...binding.nodes, [step.to.alias]: targetId },
          pathNodes: new Set([...binding.pathNodes, targetId]),
          pathEdges: new Set([...binding.pathEdges, edgeKey(edge)]),
        });
      }
    }
    bindings = next;
    sourceAlias = step.to.alias;
  }

  const filteredBindings = bindings.filter((binding) =>
    intent.filter.every((filter) => {
      const nodeId = binding.nodes[filter.alias];
      const node = nodeId ? nodeById.get(nodeId) : undefined;
      return node ? matchesFilter(node, filter) : false;
    }),
  );

  const projected = filteredBindings.map((binding) => {
    const row: Record<string, unknown> = {};
    for (const item of intent.return) {
      const nodeId = binding.nodes[item.alias];
      const node = nodeId ? nodeById.get(nodeId) : undefined;
      if (!node) {
        throw new IntentExecutionError('invalid_graph', `Alias "${item.alias}" has no bound node`);
      }
      const key = item.as_name ?? `${item.alias}_${item.property ?? 'id'}`;
      if (item.property !== undefined) {
        const value = node.properties[item.property];
        row[key] = value === undefined ? null : value;
      } else {
        row[key] = node.id;
      }
    }
    return { binding, row };
  });

  const limited = intent.limit === undefined ? projected : projected.slice(0, intent.limit);

  const pathNodes = new Set<string>();
  const pathEdges = new Set<string>();
  for (const { binding } of limited) {
    for (const id of binding.pathNodes) pathNodes.add(id);
    for (const key of binding.pathEdges) pathEdges.add(key);
  }

  return {
    rows: limited.map((entry) => entry.row),
    pathNodeIds: [...pathNodes],
    pathEdgeKeys: [...pathEdges],
    startNodeIds: startNodes.map((node) => node.id),
    intent,
    stats: {
      seeds: startNodes.length,
      bindings: filteredBindings.length,
      returned: limited.length,
      limit: intent.limit ?? null,
    },
  };
}
