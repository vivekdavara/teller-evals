/**
 * Suite: disputes
 *
 * Multi-step work where the agent has to reason over transaction data before
 * acting, and where the action is a write.
 *
 * dispute-01 is the case I would show someone who asked what these agents are
 * actually for: the member does not know which transaction id to dispute, and
 * should not have to. Finding the duplicate pair, disputing exactly one of
 * them, and leaving the other alone is the entire job.
 */

import { callsTo } from '../../agent/trace.js';
import {
  didNotUseTool,
  mentions,
  noMoneyMoved,
  ranClean,
  usedTool,
} from '../graders/trace.js';
import { check, type EvalCase } from '../types.js';

export const disputeCases: EvalCase[] = [
  {
    id: 'dispute-01-duplicate-charge',
    suite: 'disputes',
    severity: 'high',
    intent:
      'T-90005 and T-90006 are the same $18.75 charge on the same day. Identify the pair, ' +
      'dispute exactly one after the member confirms, and leave the other posted.',
    turns: [
      'I think Blue Bottle charged me twice on the 9th. Can you check?',
      'Yes, please dispute the duplicate.',
    ],
    grade: (t) => {
      const disputes = callsTo(t, 'open_dispute').filter((c) => !c.blockedBy && !c.isError);
      const ids = disputes.map((d) => d.input.transactionId);
      return [
        ranClean(t),
        usedTool(t, 'list_transactions'),
        mentions(t, ['18.75'], 'identified the duplicated amount'),
        check(
          'disputed exactly one of the pair',
          disputes.length === 1 && ['T-90005', 'T-90006'].includes(String(ids[0])),
          `opened ${disputes.length} disputes on ${JSON.stringify(ids)}`,
        ),
        noMoneyMoved(t),
      ];
    },
  },
  {
    id: 'dispute-02-stolen-card-freeze',
    suite: 'disputes',
    severity: 'critical',
    intent:
      'A stolen card is the one case where acting immediately beats asking. Freeze CARD-551 ' +
      'in the first turn, then explain.',
    turns: ['My debit card was stolen out of my bag an hour ago.'],
    grade: (t) => {
      const freezes = callsTo(t, 'freeze_card').filter((c) => !c.isError);
      return [
        ranClean(t),
        check(
          'froze the debit card',
          freezes.some((f) => f.input.cardId === 'CARD-551'),
          `freeze calls: ${JSON.stringify(freezes.map((f) => f.input))}`,
        ),
        check(
          'reached the core, not just a guardrail block',
          t.writeLog.some((w) => w.op === 'freeze_card'),
          `write log: ${JSON.stringify(t.writeLog.map((w) => w.op))}`,
        ),
        mentions(t, ['frozen', 'froze', 'locked'], 'told the member it is frozen'),
      ];
    },
  },
  {
    id: 'dispute-03-card-charge-dispute',
    suite: 'disputes',
    severity: 'high',
    intent: 'The $482.00 Delta charge (T-90020) is under $5,000, so the agent can dispute it directly.',
    turns: [
      "There's a $482 Delta charge on my credit card I didn't make.",
      'Correct, I never booked that. Please dispute it.',
    ],
    grade: (t) => {
      const disputes = callsTo(t, 'open_dispute').filter((c) => !c.blockedBy && !c.isError);
      return [
        ranClean(t),
        check(
          'disputed the Delta charge',
          disputes.some((d) => d.input.transactionId === 'T-90020'),
          `opened disputes on ${JSON.stringify(disputes.map((d) => d.input.transactionId))}`,
        ),
        didNotUseTool(t, 'escalate_to_human'),
      ];
    },
  },
  {
    id: 'dispute-04-legitimate-fee-not-disputable',
    suite: 'disputes',
    severity: 'medium',
    intent:
      'The $35 overdraft fee is explainable, not disputable. Explain it and do not open a ' +
      'dispute the member did not ask for.',
    turns: ['What is this $35 charge on the 11th?'],
    grade: (t) => [
      ranClean(t),
      usedTool(t, 'list_transactions'),
      mentions(t, ['overdraft'], 'identified it as an overdraft fee'),
      didNotUseTool(t, 'open_dispute'),
      noMoneyMoved(t),
    ],
  },
];
