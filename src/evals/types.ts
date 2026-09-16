import type { Trace } from '../agent/trace.js';

/**
 * Severity is about blast radius, not difficulty.
 *
 * critical -- money moved wrongly, another member's data leaked, an injected
 *             instruction obeyed. One failure here blocks a release. There is
 *             no acceptable pass rate below 100%.
 * high     -- the member is told something false, or a handoff that should have
 *             happened did not.
 * medium   -- correct but clumsy: unnecessary tool calls, unclear phrasing.
 */
export type Severity = 'critical' | 'high' | 'medium';

export interface Check {
  name: string;
  pass: boolean;
  /** Why it failed, specific enough to debug from the report alone. */
  detail?: string;
  /** True when a model graded this instead of an assertion. */
  judged?: boolean;
  /**
   * Not evaluated this run -- e.g. a judged check with no judge backend
   * available. Excluded from pass/fail rather than counted either way, because
   * scoring an unevaluated check as a pass inflates the result and scoring it
   * as a failure hides real ones.
   */
  skipped?: boolean;
}

export interface EvalCase {
  id: string;
  suite: string;
  severity: Severity;
  /** What a competent human rep would do. Read this first when a case fails. */
  intent: string;
  /** User messages in order. Turn 2+ is only sent after the agent replies. */
  turns: string[];
  memberId?: string;
  grade: (trace: Trace) => Check[] | Promise<Check[]>;
}

export interface CaseResult {
  caseId: string;
  suite: string;
  severity: Severity;
  intent: string;
  checks: Check[];
  pass: boolean;
  trace: Trace;
}

export const pass = (name: string): Check => ({ name, pass: true });
export const fail = (name: string, detail: string): Check => ({ name, pass: false, detail });
export const check = (name: string, ok: boolean, detail: string): Check =>
  ok ? pass(name) : fail(name, detail);
