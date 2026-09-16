/**
 * Tests for the layer that has to hold when the model does not.
 *
 * transfer-03 in the eval suite asserts this path fires under a jailbreak
 * attempt, but that costs a model call and depends on the model actually
 * misbehaving. These tests pin the behaviour directly and for free.
 */

import { describe, expect, it } from 'vitest';
import { Guardrails, redact } from '../src/agent/guardrails.js';

describe('same-turn execution', () => {
  it('blocks execute_transfer in the turn it was prepared', () => {
    const g = new Guardrails();
    g.notePrepared('PT-1', 0);
    const verdict = g.check('execute_transfer', { token: 'PT-1' }, { turn: 0 });
    expect(verdict.allow).toBe(false);
    expect(g.blocks).toHaveLength(1);
  });

  it('allows it on a later turn, once the member has had a chance to reply', () => {
    const g = new Guardrails();
    g.notePrepared('PT-1', 0);
    expect(g.check('execute_transfer', { token: 'PT-1' }, { turn: 1 }).allow).toBe(true);
  });

  it('blocks a token that was never prepared', () => {
    const g = new Guardrails();
    expect(g.check('execute_transfer', { token: 'PT-fake' }, { turn: 3 }).allow).toBe(false);
  });

  it('blocks a missing token rather than defaulting to allow', () => {
    const g = new Guardrails();
    expect(g.check('execute_transfer', {}, { turn: 1 }).allow).toBe(false);
  });

  it('does not let a second prepare in a later turn retroactively bless an old token', () => {
    const g = new Guardrails();
    g.notePrepared('PT-1', 0);
    g.notePrepared('PT-2', 1);
    // PT-1 is still fine on turn 1 (member did reply), but PT-2 is not.
    expect(g.check('execute_transfer', { token: 'PT-2' }, { turn: 1 }).allow).toBe(false);
  });
});

describe('write cap', () => {
  it('stops runaway writes inside one session', () => {
    const g = new Guardrails(2);
    expect(g.check('freeze_card', { cardId: 'CARD-551' }, { turn: 0 }).allow).toBe(true);
    expect(g.check('open_dispute', { transactionId: 'T-1', reason: 'x' }, { turn: 0 }).allow).toBe(true);
    expect(g.check('open_dispute', { transactionId: 'T-2', reason: 'x' }, { turn: 0 }).allow).toBe(false);
  });

  it('does not count reads against the cap', () => {
    const g = new Guardrails(1);
    for (let i = 0; i < 10; i += 1) {
      expect(g.check('list_accounts', {}, { turn: 0 }).allow).toBe(true);
    }
    expect(g.check('freeze_card', { cardId: 'CARD-551' }, { turn: 0 }).allow).toBe(true);
  });
});

describe('redact', () => {
  it('masks card numbers down to the last four', () => {
    expect(redact('card 4111 1111 1111 1111 declined')).toBe('card ****1111 declined');
  });

  it('masks SSNs', () => {
    expect(redact('ssn 123-45-6789')).toBe('ssn ***-**-****');
  });

  it('masks email local parts', () => {
    expect(redact('maria.chen@example.com')).toBe('m***@example.com');
  });

  it('leaves internal account ids readable for support', () => {
    expect(redact('account CHK-4471 balance $2,847.63')).toBe('account CHK-4471 balance $2,847.63');
  });
});
