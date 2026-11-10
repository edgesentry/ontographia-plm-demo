// Demo data wiring for the browser.
//
// Chip `intent_path` values in chips.json point at upstream repository paths.
// We resolve them by filename only, against the Intents vendored under
// vendor/ontographia/data/intents/. The fixture graph and ontology are the
// vendored desk-fan EOL/ECO data; nothing is fetched at runtime.
import chipsJson from '../../vendor/ontographia/data/chips.json';
import graphJson from '../../vendor/ontographia/data/fixtures/deskfan_eol.graph.json';
import ontologyYaml from '../../vendor/ontographia/data/plm.native.yaml?raw';
import type { FixtureGraph, GraphNode } from './executor';
import type { MessageKey } from '../i18n';

export type LaneId = 'ebom' | 'mbom' | 'sbom' | 'bop';

export interface LaneDefinition {
  id: LaneId;
  labelKey: MessageKey;
}

export interface Chip {
  chip_id: string;
  label_ja: string;
  label_en: string;
  intent_path: string;
  lane_hints: string[];
  description_ja: string;
  description_en: string;
}

/** Left-to-right lane order required by the demo. MBOM has no fixture data. */
export const LANES: readonly LaneDefinition[] = [
  { id: 'ebom', labelKey: 'laneEbom' },
  { id: 'mbom', labelKey: 'laneMbom' },
  { id: 'sbom', labelKey: 'laneSbom' },
  { id: 'bop', labelKey: 'laneBop' },
];

export const chips = chipsJson as Chip[];
export const graph = graphJson as unknown as FixtureGraph;
export const ontology = ontologyYaml;

const intentModules = import.meta.glob('../../vendor/ontographia/data/intents/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

const intentsByFilename = new Map<string, unknown>();
for (const [path, value] of Object.entries(intentModules)) {
  const filename = path.split('/').pop();
  if (filename) intentsByFilename.set(filename, value);
}

/** Resolve an upstream `intent_path` by basename under data/intents/. */
export function resolveIntentByPath(intentPath: string): unknown {
  const filename = intentPath.split(/[\\/]/).pop() ?? '';
  const intent = intentsByFilename.get(filename);
  if (!intent) {
    throw new Error(`Intent file not found for path "${intentPath}" (looked for "${filename}")`);
  }
  return intent;
}

export function laneOf(node: GraphNode): LaneId | null {
  const lane = node.properties.lane;
  return lane === 'ebom' || lane === 'mbom' || lane === 'sbom' || lane === 'bop' ? lane : null;
}

/** Human-readable identity for a node card, without inventing data. */
export function nodeCaption(node: GraphNode): string {
  const properties = node.properties;
  for (const key of ['name', 'part_number', 'revision_id', 'eco_id'] as const) {
    const value = properties[key];
    if (typeof value === 'string' && value !== node.id) return value;
  }
  return node.id;
}

export function nodeMeta(node: GraphNode): string {
  const properties = node.properties;
  if (typeof properties.status === 'string') return `status: ${properties.status}`;
  if (typeof properties.revision_id === 'string') return properties.revision_id;
  if (typeof properties.cas_number === 'string') return properties.cas_number;
  return node.labels.join(', ');
}
