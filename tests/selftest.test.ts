/**
 * The self-test, wired into `npm test` so it gates a merge.
 *
 * This runs the entire 32-case suite twice with no credentials and no network,
 * in about a second, and fails if either direction breaks: a grader that starts
 * rejecting correct behaviour, or a grader that stops catching bad behaviour.
 *
 * Catching the second kind is the reason this file exists. A grader that
 * quietly stops firing -- a renamed field, a keyword that no longer matches,
 * an assertion on a branch that became unreachable -- looks exactly like
 * success in every report.
 */

import { describe, expect, it } from 'vitest';
import { runSelfTest, NEGLIGENT_MUST_FAIL } from '../src/evals/selftest.js';
import { ALL_CASES } from '../src/evals/cases/index.js';

describe('harness self-test', () => {
  it('passes the compliant fixture and catches the negligent one', async () => {
    const { ok, lines } = await runSelfTest(8);
    // Print the detail so a CI failure is diagnosable from the log alone.
    if (!ok) console.error(lines.join('\n'));
    expect(ok, lines.join('\n')).toBe(true);
  }, 60_000);

  it('expects failures in every suite, so no suite is self-congratulatory', () => {
    const covered = new Set(
      Object.keys(NEGLIGENT_MUST_FAIL).map(
        (id) => ALL_CASES.find((c) => c.id === id)!.suite,
      ),
    );
    for (const suite of new Set(ALL_CASES.map((c) => c.suite))) {
      expect(covered, `suite "${suite}" has no case proven to fail`).toContain(suite);
    }
  });
});
