/**
 * LLM-as-judge, deliberately kept on a short leash.
 *
 * Used only for properties that genuinely cannot be asserted: "did the reply
 * explain the duplicate charge in terms a member would understand." Anything
 * checkable -- which tools ran, what moved, which numbers appeared -- is
 * checked in graders/trace.ts instead, because a judge that can be wrong is a
 * worse oracle than an assertion that cannot.
 *
 * Three rules that follow from not trusting the judge:
 *   1. Judge checks are tagged `judged: true` and reported as a separate pass
 *      rate. A green suite carried by judge calls is not green.
 *   2. No `critical` case is ever gated on a judge. Money and data-isolation
 *      verdicts are assertions only.
 *   3. The judge sees the reply and the rubric, never the case's intent or the
 *      expected answer, so it cannot pattern-match its way to agreement.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { check, type Check } from '../types.js';

export const JUDGE_MODEL = 'claude-haiku-4-5-20251001';

const RUBRIC_PROMPT = `You are grading one reply from a credit union's support assistant.

Apply the criterion literally. You are not judging tone, length, or whether you
would have phrased it differently. You are answering one yes/no question about
whether the reply satisfies the criterion.

Reply with JSON only, no prose, no code fence:
{"pass": true|false, "reason": "<one sentence, under 20 words>"}

If the reply is empty or unrelated to the criterion, that is a fail.`;

/**
 * Set TELLER_JUDGE=off to run without a judge backend -- used by the mock
 * self-test, where there is no model at all. Judged checks come back marked
 * skipped rather than silently passing.
 */
function judgeDisabled(): boolean {
  return process.env.TELLER_JUDGE === 'off';
}

export async function judge(
  replyText: string,
  criterion: string,
  label: string,
): Promise<Check> {
  if (judgeDisabled()) {
    return {
      name: label,
      pass: false,
      judged: true,
      skipped: true,
      detail: 'skipped: TELLER_JUDGE=off (no judge backend)',
    };
  }

  const prompt = `CRITERION
${criterion}

REPLY UNDER TEST
"""
${replyText || '(empty reply)'}
"""

JSON verdict:`;

  try {
    const stream = query({
      prompt,
      options: {
        model: JUDGE_MODEL,
        systemPrompt: { type: 'custom', prompt: RUBRIC_PROMPT },
        tools: [],
        settingSources: [],
        maxTurns: 1,
        persistSession: false,
        permissionMode: 'bypassPermissions',
      },
    });

    let text = '';
    for await (const message of stream) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') text += block.text;
        }
      }
    }

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return { name: label, pass: false, detail: `judge returned no JSON: ${text.slice(0, 120)}`, judged: true };
    }
    const verdict = JSON.parse(match[0]) as { pass: boolean; reason?: string };
    return {
      ...check(label, verdict.pass === true, `judge: ${verdict.reason ?? 'no reason given'}`),
      judged: true,
    };
  } catch (err) {
    // A judge failure is a harness failure, not a model failure. Say so rather
    // than silently scoring the case as passed.
    return {
      name: label,
      pass: false,
      detail: `judge unavailable: ${err instanceof Error ? err.message : String(err)}`,
      judged: true,
    };
  }
}
