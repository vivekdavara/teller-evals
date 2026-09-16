/**
 * Orchestrates a run: pick cases, run them concurrently, grade, collect.
 *
 * One deliberate choice: a harness error (timeout, transport hiccup) is retried
 * once, and a graded failure never is. Retrying until green is how a suite
 * stops telling you anything, and flaky infrastructure and a flaky agent need
 * different fixes, so they are recorded differently.
 */

import { runAgent, DEFAULT_MODEL } from '../agent/run.js';
import type { Trace } from '../agent/trace.js';
import { runMockAgent, type MockVariant } from '../models/mock.js';
import { ALL_CASES } from './cases/index.js';
import type { CaseResult, EvalCase } from './types.js';

/** `live` drives a real model; the mocks are scripted fixtures for self-tests. */
export type Backend = 'live' | `mock:${MockVariant}`;

export interface RunConfig {
  model?: string;
  backend?: Backend;
  /** Substring match on suite name. */
  suite?: string;
  /** Substring match on case id. */
  filter?: string;
  limit?: number;
  concurrency?: number;
  onProgress?: (done: number, total: number, result: CaseResult) => void;
}

export interface RunSummary {
  startedAt: string;
  model: string;
  backend: Backend;
  results: CaseResult[];
  durationMs: number;
  totalCostUsd: number;
}

export function selectCases(config: RunConfig): EvalCase[] {
  let cases = ALL_CASES;
  if (config.suite) cases = cases.filter((c) => c.suite.includes(config.suite!));
  if (config.filter) cases = cases.filter((c) => c.id.includes(config.filter!));
  if (config.limit) cases = cases.slice(0, config.limit);
  return cases;
}

async function gradeOne(
  evalCase: EvalCase,
  model: string,
  backend: Backend,
): Promise<CaseResult> {
  const once = (): Promise<Trace> =>
    backend === 'live'
      ? runAgent({
          caseId: evalCase.id,
          turns: evalCase.turns,
          memberId: evalCase.memberId,
          model,
        })
      : runMockAgent({
          caseId: evalCase.id,
          turns: evalCase.turns,
          memberId: evalCase.memberId,
          variant: backend.slice('mock:'.length) as MockVariant,
        });

  let trace = await once();
  // One retry, harness errors only. A graded failure is never retried: retrying
  // until green is how a suite stops telling you anything.
  if (trace.error) trace = await once();

  const checks = await evalCase.grade(trace);
  return {
    caseId: evalCase.id,
    suite: evalCase.suite,
    severity: evalCase.severity,
    intent: evalCase.intent,
    checks,
    // Skipped checks do not count either way.
    pass: checks.filter((c) => !c.skipped).every((c) => c.pass),
    trace,
  };
}

/** Bounded-concurrency map. Enough for a suite this size; no dependency needed. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

export async function runEvals(config: RunConfig = {}): Promise<RunSummary> {
  const backend = config.backend ?? 'live';
  const model = backend === 'live' ? (config.model ?? DEFAULT_MODEL) : backend;
  const cases = selectCases(config);
  const startedAt = new Date().toISOString();
  const started = Date.now();

  let done = 0;
  const results = await mapWithConcurrency(cases, config.concurrency ?? 4, async (evalCase) => {
    const result = await gradeOne(evalCase, model, backend);
    done += 1;
    config.onProgress?.(done, cases.length, result);
    return result;
  });

  // Stable order regardless of completion order, so report diffs stay readable.
  const order = new Map(cases.map((c, i) => [c.id, i]));
  results.sort((a, b) => (order.get(a.caseId) ?? 0) - (order.get(b.caseId) ?? 0));

  return {
    startedAt,
    model,
    backend,
    results,
    durationMs: Date.now() - started,
    totalCostUsd: results.reduce((sum, r) => sum + r.trace.costUsd, 0),
  };
}
