#!/usr/bin/env node
/**
 * teller-evals CLI.
 *
 * Exit codes are the contract, because this is meant to gate a merge:
 *   0  every selected case passed
 *   1  a critical case failed, or a case regressed against the baseline
 *   2  non-critical failures only
 *   3  the harness itself broke -- could not reach the model, no cases matched
 *
 * Codes 1 and 3 are unconditional: a money-movement failure is blocking whether
 * or not anyone passed --ci, and a run that never reached the model must not be
 * mistaken for a clean one. --ci only tightens code 2 into a 1, for pipelines
 * that treat any failure as blocking.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { runEvals, type Backend } from './evals/runner.js';
import { runSelfTest } from './evals/selftest.js';
import { renderReport, toBaseline, type Baseline } from './evals/report.js';
import { ALL_CASES, SUITES } from './evals/cases/index.js';
import { DEFAULT_MODEL, preflight } from './agent/run.js';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..');
const BASELINE_PATH = join(ROOT, 'evals', 'baseline.json');
const REPORT_DIR = join(ROOT, 'evals', 'reports');

interface Args {
  backend: Backend;
  selftest: boolean;
  suite?: string;
  filter?: string;
  model: string;
  limit?: number;
  concurrency: number;
  updateBaseline: boolean;
  ci: boolean;
  list: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    backend: 'live',
    selftest: false,
    model: process.env.TELLER_EVAL_MODEL ?? DEFAULT_MODEL,
    concurrency: 4,
    updateBaseline: false,
    ci: false,
    list: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--suite': args.suite = value; i += 1; break;
      case '--filter': args.filter = value; i += 1; break;
      case '--model': args.model = value; i += 1; break;
      case '--limit': args.limit = Number(value); i += 1; break;
      case '--concurrency': args.concurrency = Number(value); i += 1; break;
      case '--mock':
        if (value !== 'compliant' && value !== 'negligent') {
          console.error(`--mock takes "compliant" or "negligent", got "${value ?? ''}"`);
          process.exit(3);
        }
        args.backend = `mock:${value}`;
        i += 1;
        break;
      case '--selftest': args.selftest = true; break;
      case '--update-baseline': args.updateBaseline = true; break;
      case '--ci': args.ci = true; break;
      case '--list': args.list = true; break;
      case '--help':
        console.log(
          `teller-evals\n\n` +
            `  --suite <name>       one of: ${SUITES.join(', ')}\n` +
            `  --filter <substr>    match case ids\n` +
            `  --model <id>         default ${DEFAULT_MODEL}\n` +
            `  --mock <variant>     run a scripted fixture instead of a model:\n` +
            `                       compliant | negligent (see src/models/mock.ts)\n` +
            `  --selftest           run both fixtures and assert the graders fire\n` +
            `  --limit <n>          first n cases\n` +
            `  --concurrency <n>    default 4\n` +
            `  --update-baseline    overwrite evals/baseline.json with this run\n` +
            `  --ci                 treat any failure as blocking (exit 1, not 2)\n` +
            `  --list               print the case roster and exit\n`,
        );
        process.exit(0);
    }
  }
  return args;
}

function loadBaseline(): Baseline | undefined {
  if (!existsSync(BASELINE_PATH)) return undefined;
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
  } catch {
    console.warn('! baseline.json is unreadable, skipping regression diff');
    return undefined;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    for (const suite of SUITES) {
      console.log(`\n${suite}`);
      for (const c of ALL_CASES.filter((x) => x.suite === suite)) {
        console.log(`  ${c.severity.padEnd(8)} ${c.id}`);
      }
    }
    console.log(`\n${ALL_CASES.length} cases in ${SUITES.length} suites`);
    return 0;
  }

  if (args.selftest) {
    console.log('teller-evals selftest: running both fixtures against the suite\n');
    const { ok, lines } = await runSelfTest(Math.max(args.concurrency, 8));
    for (const line of lines) console.log(line);
    console.log(ok ? '\nselftest OK -- graders fire in both directions' : '\nselftest FAILED');
    return ok ? 0 : 1;
  }

  // A fixture run must never be able to write a baseline that a later live run
  // would then diff against as if it were real.
  if (args.updateBaseline && args.backend !== 'live') {
    console.error('Refusing to write a baseline from a mock run. Drop --mock or --update-baseline.');
    return 3;
  }

  if (args.backend !== 'live') process.env.TELLER_JUDGE ??= 'off';

  console.log(
    `teller-evals: backend=${args.backend} ` +
      `${args.backend === 'live' ? `model=${args.model} ` : ''}concurrency=${args.concurrency}`,
  );

  if (args.backend === 'live') {
    const probe = await preflight(args.model);
    if (!probe.ok) {
      console.error(
        `\nCannot reach the model, so there is nothing to evaluate.\n` +
          `  ${probe.error}\n\n` +
          `The harness drives the local Claude Code install via the Agent SDK. Either:\n` +
          `  - log in:  claude login          (then re-run)\n` +
          `  - or set:  export ANTHROPIC_API_KEY=sk-ant-...\n\n` +
          `To exercise the harness with no credentials at all:\n` +
          `  npm run selftest\n`,
      );
      return 3;
    }
  }

  const summary = await runEvals({
    model: args.model,
    backend: args.backend,
    suite: args.suite,
    filter: args.filter,
    limit: args.limit,
    concurrency: args.concurrency,
    onProgress: (done, total, result) => {
      const mark = result.pass ? 'pass' : result.severity === 'critical' ? 'FAIL!' : 'FAIL';
      console.log(
        `[${String(done).padStart(2)}/${total}] ${mark.padEnd(5)} ${result.caseId}` +
          (result.pass
            ? ''
            : ` :: ${result.checks
                .filter((c) => !c.pass && !c.skipped)
                .map((c) => c.name)
                .join('; ')}`),
      );
    },
  });

  if (summary.results.length === 0) {
    console.error('No cases matched.');
    return 3;
  }

  const baseline = loadBaseline();
  const report = renderReport(summary, baseline);

  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = summary.startedAt.replace(/[:.]/g, '-');
  writeFileSync(join(REPORT_DIR, `report-${stamp}.md`), report);
  writeFileSync(join(REPORT_DIR, 'latest.md'), report);

  if (args.updateBaseline) {
    mkdirSync(dirname(BASELINE_PATH), { recursive: true });
    writeFileSync(BASELINE_PATH, `${JSON.stringify(toBaseline(summary), null, 2)}\n`);
    console.log(`\nbaseline updated -> ${BASELINE_PATH}`);
  }

  const failures = summary.results.filter((r) => !r.pass);
  const critical = failures.filter((r) => r.severity === 'critical');
  const regressions = baseline
    ? summary.results.filter((r) => baseline.cases[r.caseId] === true && !r.pass)
    : [];

  console.log(
    `\n${summary.results.length - failures.length}/${summary.results.length} cases passed ` +
      `in ${(summary.durationMs / 1000).toFixed(1)}s ($${summary.totalCostUsd.toFixed(4)})`,
  );
  console.log(`report -> evals/reports/latest.md`);

  if (critical.length > 0) console.log(`\nCRITICAL: ${critical.map((r) => r.caseId).join(', ')}`);
  if (regressions.length > 0) console.log(`REGRESSED: ${regressions.map((r) => r.caseId).join(', ')}`);

  if (critical.length > 0 || regressions.length > 0) return 1;
  if (failures.length > 0) return args.ci ? 1 : 2;
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('harness error:', err);
    process.exit(3);
  });
