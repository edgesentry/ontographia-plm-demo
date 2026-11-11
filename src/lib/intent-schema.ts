// Explicit schema checker for the Intent JSON produced by the in-browser model.
//
// This module is deliberately dependency-free (no WASM, no DOM) so that both
// the app and `scripts/verify.mjs` exercise the exact same checks. The model is
// untrusted input: only a value that passes every check here may reach
// `buildCypher()` or `executeIntent()`. Extra/unknown keys, missing required
// fields, wrong types, and Cypher text are all rejected.

export type ValidIntentValue = string | number | boolean;

export interface ValidIntentStart {
  class: string;
  alias: string;
}

export interface ValidIntentTraverse {
  relationship: string;
  direction: 'in' | 'out';
  to: { class: string; alias: string };
}

export interface ValidIntentFilter {
  alias: string;
  property: string;
  op: 'eq';
  value: ValidIntentValue;
}

export interface ValidIntentReturn {
  alias: string;
  property?: string;
  as_name: string;
}

export interface ValidIntent {
  start: ValidIntentStart;
  traverse: ValidIntentTraverse[];
  filter: ValidIntentFilter[];
  return: ValidIntentReturn[];
  limit: number;
  optional: boolean;
}

export type IntentValidation =
  | { ok: true; value: ValidIntent }
  | { ok: false; errors: string[] };

export type IntentParse = { ok: true; value: unknown } | { ok: false; error: string };

const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RELATIONSHIP = /^[A-Z][A-Z0-9_]*$/;
const MAX_TEXT = 160;
const MAX_STEPS = 8;
const MAX_LIMIT = 100;

// A model that writes Cypher is out of scope, even if it hides the statement
// inside a string value. Reject query keywords / arrows / code fences outright.
const CYPHER_PATTERN =
  /(\b(MATCH|OPTIONAL|RETURN|WITH|CREATE|MERGE|DELETE|DETACH|SET|REMOVE|UNWIND|CALL|YIELD|WHERE|ORDER\s+BY|SKIP|LIMIT|CYPHER|LOAD\s+CSV)\b|--|->|<-|\[\s*\w*\s*:|\bNODE\b|\bREL\b|```)/i;

const TOP_KEYS = ['start', 'traverse', 'filter', 'return', 'limit', 'optional'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathJoin(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return path ? `${path}.${key}` : key;
}

function checkKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      errors.push(`${pathJoin(path, key)}: unknown key is not allowed`);
    }
  }
  for (const key of allowed) {
    if (!(key in record)) {
      errors.push(`${pathJoin(path, key)}: required key is missing`);
    }
  }
}

function readString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
  pattern: RegExp,
  patternLabel: string,
): string | null {
  const value = record[key];
  const fieldPath = pathJoin(path, key);
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${fieldPath}: expected a non-empty string`);
    return null;
  }
  if (value.length > MAX_TEXT) {
    errors.push(`${fieldPath}: string is too long`);
    return null;
  }
  if (CYPHER_PATTERN.test(value)) {
    errors.push(`${fieldPath}: Cypher text is not allowed`);
    return null;
  }
  if (!pattern.test(value)) {
    errors.push(`${fieldPath}: expected ${patternLabel}`);
    return null;
  }
  return value;
}

function readArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
  maxLength: number,
): unknown[] | null {
  const value = record[key];
  const fieldPath = pathJoin(path, key);
  if (!Array.isArray(value)) {
    errors.push(`${fieldPath}: expected an array`);
    return null;
  }
  if (value.length > maxLength) {
    errors.push(`${fieldPath}: at most ${maxLength} entries are allowed`);
    return null;
  }
  return value;
}

/** Parse the raw model text. Markdown fences and prose are not JSON. */
export function parseIntentJson(raw: string): IntentParse {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'model output was not text' };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'model output was empty' };
  if (trimmed.length > 20000) return { ok: false, error: 'model output was too large' };
  if (trimmed.includes('```')) {
    return { ok: false, error: 'markdown fences are not valid Intent JSON' };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    // Do not echo the parser message: it can quote the untrusted output.
    return { ok: false, error: 'invalid JSON' };
  }
}

/**
 * Validate an already-parsed value. Returns every problem found (not just the
 * first) so the UI can explain why the model output was rejected.
 */
export function validateIntent(value: unknown): IntentValidation {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ['root: expected a single JSON object'] };
  }

  checkKeys(value, TOP_KEYS, '', errors);

  // start
  const start = value.start;
  if (!isRecord(start)) {
    errors.push('start: expected an object');
  } else {
    checkKeys(start, ['class', 'alias'], 'start', errors);
    readString(start, 'class', 'start', errors, FIELD, 'a class name');
    readString(start, 'alias', 'start', errors, FIELD, 'an identifier');
  }

  // traverse
  const traverse = readArray(value, 'traverse', '', errors, MAX_STEPS);
  if (traverse) {
    traverse.forEach((step, index) => {
      const path = `traverse[${index}]`;
      if (!isRecord(step)) {
        errors.push(`${path}: expected an object`);
        return;
      }
      checkKeys(step, ['relationship', 'direction', 'to'], path, errors);
      readString(step, 'relationship', path, errors, RELATIONSHIP, 'an UPPER_SNAKE relationship');
      const direction = step.direction;
      if (direction !== 'in' && direction !== 'out') {
        errors.push(`${path}.direction: expected "in" or "out"`);
      }
      const to = step.to;
      if (!isRecord(to)) {
        errors.push(`${path}.to: expected an object`);
      } else {
        checkKeys(to, ['class', 'alias'], `${path}.to`, errors);
        readString(to, 'class', `${path}.to`, errors, FIELD, 'a class name');
        readString(to, 'alias', `${path}.to`, errors, FIELD, 'an identifier');
      }
    });
  }

  // filter
  const filter = readArray(value, 'filter', '', errors, MAX_STEPS);
  if (filter) {
    filter.forEach((entry, index) => {
      const path = `filter[${index}]`;
      if (!isRecord(entry)) {
        errors.push(`${path}: expected an object`);
        return;
      }
      checkKeys(entry, ['alias', 'property', 'op', 'value'], path, errors);
      readString(entry, 'alias', path, errors, FIELD, 'an identifier');
      readString(entry, 'property', path, errors, FIELD, 'a property name');
      if (entry.op !== 'eq') {
        errors.push(`${path}.op: only "eq" is supported`);
      }
      const propertyValue = entry.value;
      let primitive = false;
      if (typeof propertyValue === 'string') {
        primitive = !CYPHER_PATTERN.test(propertyValue);
        if (!primitive) errors.push(`${path}.value: Cypher text is not allowed`);
      } else if (typeof propertyValue === 'number') {
        primitive = Number.isFinite(propertyValue);
      } else if (typeof propertyValue === 'boolean') {
        primitive = true;
      }
      if (!primitive) {
        errors.push(`${path}.value: expected a finite string, number, or boolean`);
      }
    });
  }

  // return
  const returns = readArray(value, 'return', '', errors, MAX_STEPS);
  if (returns) {
    if (returns.length === 0) errors.push('return: at least one entry is required');
    returns.forEach((entry, index) => {
      const path = `return[${index}]`;
      if (!isRecord(entry)) {
        errors.push(`${path}: expected an object`);
        return;
      }
      for (const key of Object.keys(entry)) {
        if (key !== 'alias' && key !== 'property' && key !== 'as_name') {
          errors.push(`${path}.${key}: unknown key is not allowed`);
        }
      }
      for (const key of ['alias', 'as_name']) {
        if (!(key in entry)) errors.push(`${path}.${key}: required key is missing`);
      }
      readString(entry, 'alias', path, errors, FIELD, 'an identifier');
      readString(entry, 'as_name', path, errors, FIELD, 'an output name');
      if ('property' in entry) {
        readString(entry, 'property', path, errors, FIELD, 'a property name');
      }
    });
  }

  // limit
  if (value.limit !== undefined) {
    const limit = value.limit;
    if (
      typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_LIMIT
    ) {
      errors.push(`limit: expected an integer between 1 and ${MAX_LIMIT}`);
    }
  }

  // optional
  if (value.optional !== undefined && typeof value.optional !== 'boolean') {
    errors.push('optional: expected a boolean');
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: value as unknown as ValidIntent };
}

/**
 * Small canonical form used by the local prompt-set check. Aliases are
 * resolved to class names so an equivalent Intent with different alias names
 * still matches its gold file.
 */
export function canonicalIntent(intent: ValidIntent): string {
  const classByAlias = new Map<string, string>();
  classByAlias.set(intent.start.alias, intent.start.class);
  for (const step of intent.traverse) classByAlias.set(step.to.alias, step.to.class);

  const resolve = (alias: string): string => classByAlias.get(alias) ?? `alias:${alias}`;
  const traverse = intent.traverse.map(
    (step) => `${step.relationship}:${step.direction}:${step.to.class}`,
  );
  const filter = intent.filter
    .map((entry) => `${resolve(entry.alias)}.${entry.property}:${entry.op}:${JSON.stringify(entry.value)}`)
    .sort();
  const returns = intent.return
    .map((entry) => `${resolve(entry.alias)}.${entry.property ?? '*'}:${entry.as_name}`)
    .sort();

  return JSON.stringify({
    start: intent.start.class,
    traverse,
    filter,
    return: returns,
    limit: intent.limit,
    optional: intent.optional,
  });
}
