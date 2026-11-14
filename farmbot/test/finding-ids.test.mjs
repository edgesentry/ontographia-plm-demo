import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assignFindingIds,
  findingSubjectKey,
  shortHash,
} from '../../src/farmbot/agent/ids.mjs';

const LONG_KEY =
  'A very long part name that is deliberately longer than forty-eight characters';

// The third subject's slug equals the hash-qualified candidate of the first
// one, so the two collide even though only one of them takes the hash branch.
const SUBJECTS = [
  { rule: 'R2', key: 'Wood Screws' },
  { rule: 'R2', key: 'wood screws' },
  { rule: 'R2', key: `Wood Screws ${shortHash('Wood Screws')}` },
  { rule: 'R4', key: LONG_KEY },
  { rule: 'R4', key: `${LONG_KEY} too` },
  { rule: 'R3', key: 'M3 Locknut' },
  { rule: 'R5', key: 'v1.7/pre-assembly/rotary-tool.md' },
];

const SHUFFLED_ORDER = [3, 0, 5, 2, 6, 1, 4];

function idOf(ids, subject) {
  return ids.get(findingSubjectKey(subject.rule, subject.key));
}

test('finding ids depend only on the set of subjects', () => {
  const forward = assignFindingIds(SUBJECTS);
  const reversed = assignFindingIds([...SUBJECTS].reverse());
  const shuffled = assignFindingIds(SHUFFLED_ORDER.map((index) => SUBJECTS[index]));

  assert.deepEqual(reversed, forward, 'reversed input changed a subject id');
  assert.deepEqual(shuffled, forward, 'shuffled input changed a subject id');
  assert.equal(new Set(forward.values()).size, SUBJECTS.length, 'ids must be unique');
  for (const subject of SUBJECTS) {
    assert.match(idOf(forward, subject), /^[A-Za-z0-9-]+$/);
  }
});

test('a slug collision gives each subject a hashed id', () => {
  const subjects = [
    { rule: 'R2', key: 'Wood Screws' },
    { rule: 'R2', key: 'wood screws' },
  ];
  const ids = assignFindingIds(subjects);
  const first = idOf(ids, subjects[0]);
  const second = idOf(ids, subjects[1]);

  assert.match(first, /^R2-wood-screws-[0-9a-f]{8}$/);
  assert.match(second, /^R2-wood-screws-[0-9a-f]{8}$/);
  assert.notEqual(first, second);
});

test('a long slug is truncated before its hash suffix', () => {
  const subject = { rule: 'R4', key: LONG_KEY };
  const id = idOf(assignFindingIds([subject]), subject);
  const suffix = `-${shortHash(subject.key)}`;

  assert.ok(id.startsWith('R4-'), `${id} must start with the rule id`);
  assert.ok(id.endsWith(suffix), `${id} must end with the key hash`);
  const head = id.slice('R4-'.length, id.length - suffix.length);
  assert.ok(head.length > 0 && head.length <= 48, `${id} has a ${head.length}-char slug`);
});

test('duplicate rule-and-key pairs are rejected', () => {
  assert.throws(
    () =>
      assignFindingIds([
        { rule: 'R2', key: 'same' },
        { rule: 'R2', key: 'same' },
      ]),
    /duplicate finding subject/,
  );

  const ids = assignFindingIds([
    { rule: 'R2', key: 'same' },
    { rule: 'R3', key: 'same' },
  ]);
  assert.equal(ids.size, 2);
  assert.notEqual(idOf(ids, { rule: 'R2', key: 'same' }), idOf(ids, { rule: 'R3', key: 'same' }));
});
