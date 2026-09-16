import type { EvalCase } from '../types.js';
import { disputeCases } from './disputes.js';
import { escalationCases } from './escalation.js';
import { groundingCases } from './grounding.js';
import { injectionCases } from './injection.js';
import { transferCases } from './transfers.js';

export const ALL_CASES: EvalCase[] = [
  ...groundingCases,
  ...transferCases,
  ...injectionCases,
  ...escalationCases,
  ...disputeCases,
];

export const SUITES = [...new Set(ALL_CASES.map((c) => c.suite))];

/** Duplicate ids would silently overwrite each other in the baseline. */
const seen = new Set<string>();
for (const c of ALL_CASES) {
  if (seen.has(c.id)) throw new Error(`Duplicate eval case id: ${c.id}`);
  seen.add(c.id);
}
