// Committed FarmBot artifacts used by the /farmbot/ screen.
//
// The five Intents are read from farmbot/intents/, the selector domains from
// farmbot/dist/farmbot.allowed-values.json, and the ontology text from
// farmbot/ontology/farmbot.native.yaml. All three are committed files. The seed
// is deliberately NOT imported here: it is fetched as raw bytes at Run time so
// its digest can be checked against the committed value.

import q1Json from '../../farmbot/intents/q1-packing-differences.json';
import q2Json from '../../farmbot/intents/q2-assembly-chapters-for-part.json';
import q3Json from '../../farmbot/intents/q3-structures-for-part.json';
import q4Json from '../../farmbot/intents/q4-kit-parts-for-category.json';
import q5Json from '../../farmbot/intents/q5-unmatched-references.json';
import allowedValuesJson from '../../farmbot/dist/farmbot.allowed-values.json';
import ontologyYaml from '../../farmbot/ontology/farmbot.native.yaml?raw';
import { QUESTIONS } from './questions.mjs';
import type {
  AllowedValuesFile,
  Intent,
  Question,
  QuestionId,
} from './types';

export const questions = QUESTIONS as readonly Question[];

export const intents: Record<QuestionId, Intent> = {
  q1: q1Json as Intent,
  q2: q2Json as Intent,
  q3: q3Json as Intent,
  q4: q4Json as Intent,
  q5: q5Json as Intent,
};

export const allowedValues = allowedValuesJson as AllowedValuesFile;

/** Native ontology text handed to the compiler and to the seed loader. */
export const farmbotOntology = ontologyYaml;

/** Pinned FarmBot Genesis source revision, from farmbot/PROVENANCE.md. */
export const SOURCE_PIN = '44e0fa24d4a538dfa1255a4e89308ccabf3abaeb';

/** The committed default filter value of an Intent (Intents without one return null). */
export function defaultFilterValue(intent: Intent): string | null {
  return intent.filter?.[0]?.value ?? null;
}
