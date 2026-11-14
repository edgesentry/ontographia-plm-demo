// Stable, URL-safe finding ids.
//
// A finding id is the rule id, a hyphen, and a lowercase ASCII slug of the
// finding's subject key. The subject key is taken from the evidence (a seeded
// part name, display name, page path or part-plus-variant pair). When the slug
// is longer than MAX_SLUG characters or two subjects in the same rule share a
// slug, the id gains "-" plus eight lowercase hex digits of an FNV-1a hash of
// the full subject key. The result matches ^[A-Za-z0-9-]+$ and is used later as
// `#finding=<id>`.
//
// Ids depend only on the set of subjects, never on the order in which they are
// passed. Subjects are sorted by rule and key before any collision is resolved,
// so a fallback counter cannot move between runs when a caller reorders its
// input. A repeated rule-and-key pair is rejected: such a pair would name two
// different findings, which the caller must resolve first.

const MAX_SLUG = 48;
const SUBJECT_SEPARATOR = '\u0000';

/**
 * Map key for one subject. Rule ids and subject keys never contain a NUL byte,
 * so the two parts cannot run together.
 *
 * @param {string} rule
 * @param {string} key
 * @returns {string}
 */
export function findingSubjectKey(rule, key) {
  return `${rule}${SUBJECT_SEPARATOR}${key}`;
}

/**
 * Lowercase ASCII slug: non-ASCII and punctuation become single hyphens.
 *
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * FNV-1a 32-bit hash as eight lowercase hex digits. Stable across Node and the
 * browser and far cheaper than a cryptographic digest for id disambiguation.
 *
 * @param {string} text
 * @returns {string}
 */
export function shortHash(text) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Assign one id per subject and return a map keyed by
 * `findingSubjectKey(subject.rule, subject.key)`.
 *
 * @param {Array<{ rule: string, key: string }>} subjects
 * @returns {Map<string, string>}
 */
export function assignFindingIds(subjects) {
  if (!Array.isArray(subjects)) throw new Error('assignFindingIds needs an array of subjects');

  const seen = new Set();
  for (const subject of subjects) {
    if (!subject || typeof subject.rule !== 'string' || typeof subject.key !== 'string') {
      throw new Error('assignFindingIds needs a string rule and key for every subject');
    }
    const subjectKey = findingSubjectKey(subject.rule, subject.key);
    if (seen.has(subjectKey)) {
      throw new Error(`duplicate finding subject ${subject.rule}: ${subject.key}`);
    }
    seen.add(subjectKey);
  }

  const canonical = [...subjects].sort(
    (left, right) => compareText(left.rule, right.rule) || compareText(left.key, right.key),
  );

  const baseCounts = new Map();
  for (const subject of canonical) {
    const base = `${subject.rule}-${slugify(subject.key)}`;
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }

  const used = new Set();
  const ids = new Map();
  for (const subject of canonical) {
    const slug = slugify(subject.key);
    const base = `${subject.rule}-${slug}`;
    let id = slug.length === 0 ? `${subject.rule}-${shortHash(subject.key)}` : base;
    if (slug.length > 0 && (baseCounts.get(base) > 1 || slug.length > MAX_SLUG)) {
      const head = slug.slice(0, MAX_SLUG).replace(/-+$/g, '');
      id = `${subject.rule}-${head}-${shortHash(subject.key)}`;
    }
    const root = id;
    let counter = 2;
    while (used.has(id)) id = `${root}-${counter++}`;
    used.add(id);
    ids.set(findingSubjectKey(subject.rule, subject.key), id);
  }
  return ids;
}
