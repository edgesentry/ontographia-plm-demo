// Types shared by the FarmBot screen modules.

export type QuestionId = 'q1' | 'q2' | 'q3' | 'q4' | 'q5';

export type SelectorDomain =
  | 'part_names_in_assembly_chapters'
  | 'part_names_in_all_three_structure_kinds'
  | 'category_slugs_in_kits';

export interface Question {
  id: QuestionId;
  intentFile: string;
  selector: SelectorDomain | null;
  distinct: boolean;
}

export interface IntentFilter {
  alias: string;
  property: string;
  op: string;
  value: string;
}

export interface IntentReturn {
  alias: string;
  property: string;
  as_name: string;
}

export interface IntentTraverse {
  relationship: string;
  direction: string;
  to: { class: string; alias: string };
}

export interface Intent {
  start: { class: string; alias: string };
  traverse: IntentTraverse[];
  filter?: IntentFilter[];
  return: IntentReturn[];
  limit: number;
}

export interface SeedNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
}

export interface SeedEdge {
  from: string;
  to: string;
  type: string;
}

export interface Seed {
  nodes: SeedNode[];
  edges: SeedEdge[];
}

export interface AllowedValuesFile {
  format: string;
  part_names: string[];
  part_names_in_assembly_chapters: string[];
  part_names_in_preassemblies: string[];
  part_names_in_kits: string[];
  part_names_in_all_three_structure_kinds: string[];
  category_slugs: string[];
  category_slugs_in_kits: string[];
  unmatched_statuses: string[];
}

export interface RelateEnvelope {
  columns?: string[];
  rows?: Record<string, unknown>[];
  error: string | null;
}

export interface QuestionPlan {
  compiled: string;
  executed: string;
  params: Record<string, unknown>;
  distinctApplied: boolean;
}

export interface RelateSession {
  digest: string;
  byteLength: number;
  statements: number;
  execute(query: string, params: Record<string, unknown>): RelateEnvelope;
  isTrap(error: unknown): boolean;
  close(): void;
}
