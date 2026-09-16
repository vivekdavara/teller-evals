/**
 * Tests for the authorization boundary and the money arithmetic.
 *
 * No model involved. These are the invariants the eval suite assumes are true;
 * if they break, every eval result above them is meaningless.
 */

import { describe, expect, it } from 'vitest';
import { CoreBankingError, CoreBankingSession, TRANSFER_CAP_CENTS } from '../src/core-banking/api.js';
import { formatCents } from '../src/core-banking/data.js';

describe('tenant isolation', () => {
  it("refuses an account belonging to another member", () => {
    const session = new CoreBankingSession('M-1001');
    expect(() => session.getAccount('CHK-9902')).toThrow(CoreBankingError);
  });

  it('gives the same error for a foreign account as for a nonexistent one', () => {
    // Otherwise the error message is an account-enumeration oracle.
    const session = new CoreBankingSession('M-1001');
    const foreign = (() => { try { session.getAccount('CHK-9902'); } catch (e) { return (e as Error).message; } })();
    const missing = (() => { try { session.getAccount('CHK-0000'); } catch (e) { return (e as Error).message; } })();
    expect(foreign?.replace('CHK-9902', 'X')).toBe(missing?.replace('CHK-0000', 'X'));
  });

  it('lists only the authenticated member\'s accounts', () => {
    expect(new CoreBankingSession('M-1001').listAccounts().map((a) => a.id)).toEqual([
      'CHK-4471', 'SAV-8820', 'CC-3390',
    ]);
    expect(new CoreBankingSession('M-1002').listAccounts().map((a) => a.id)).toEqual(['CHK-9902']);
  });

  it('refuses transactions on a foreign account', () => {
    const session = new CoreBankingSession('M-1001');
    expect(() => session.listTransactions('CHK-9902')).toThrow(/No account/);
  });
});

describe('available funds', () => {
  it('subtracts pending holds from checking', () => {
    const account = new CoreBankingSession('M-1001').getAccount('CHK-4471');
    expect(account.balanceCents).toBe(284763);
    expect(account.pendingHoldCents).toBe(4210);
    expect(account.availableCents).toBe(280553);
  });

  it('computes credit-card availability as limit minus balance', () => {
    expect(new CoreBankingSession('M-1001').getAccount('CC-3390').availableCents).toBe(679545);
  });
});

describe('two-phase transfer', () => {
  it('prepare moves no money', () => {
    const session = new CoreBankingSession('M-1001');
    const before = session.getAccount('SAV-8820').balanceCents;
    session.prepareTransfer('SAV-8820', 'CHK-4471', 50000);
    expect(session.getAccount('SAV-8820').balanceCents).toBe(before);
  });

  it('execute moves exactly the quoted amount', () => {
    const session = new CoreBankingSession('M-1001');
    const quote = session.prepareTransfer('SAV-8820', 'CHK-4471', 50000);
    const receipt = session.executeTransfer(quote.token);
    expect(receipt.fromBalanceCents).toBe(1520311 - 50000);
    expect(receipt.toBalanceCents).toBe(284763 + 50000);
  });

  it('rejects a reused token, so a retry cannot double-spend', () => {
    const session = new CoreBankingSession('M-1001');
    const quote = session.prepareTransfer('SAV-8820', 'CHK-4471', 1000);
    session.executeTransfer(quote.token);
    expect(() => session.executeTransfer(quote.token)).toThrow(/already-used/);
  });

  it('rejects an unknown token', () => {
    expect(() => new CoreBankingSession('M-1001').executeTransfer('PT-999')).toThrow(/Unknown/);
  });

  it('enforces available funds, not just balance', () => {
    const session = new CoreBankingSession('M-1001');
    // 284000 < balance 284763 but > available 280553.
    expect(() => session.prepareTransfer('CHK-4471', 'SAV-8820', 284000)).toThrow(/Insufficient/);
  });

  it('enforces the single-transfer cap', () => {
    const session = new CoreBankingSession('M-1001');
    expect(() => session.prepareTransfer('SAV-8820', 'CHK-4471', TRANSFER_CAP_CENTS + 1)).toThrow(
      /human reviewer/,
    );
  });

  it('keeps both refusal paths reachable in the seed data', () => {
    // Regression guard for a bug this suite caught: the cap originally sat
    // below every available balance, so `insufficient_funds` could never be
    // returned and the eval case for it was really grading the cap.
    //
    // The seed data has to support both refusals, which needs one account on
    // each side of the cap.
    const accounts = new CoreBankingSession('M-1001').listAccounts();

    const insufficientReachable = accounts.some((a) => a.availableCents < TRANSFER_CAP_CENTS);
    const capReachable = accounts.some((a) => a.availableCents > TRANSFER_CAP_CENTS);

    expect(insufficientReachable, 'no account can run out of money before the cap').toBe(true);
    expect(capReachable, 'no account holds enough to exceed the cap').toBe(true);
  });

  it('returns insufficient_funds, not the cap error, when funds bind first', () => {
    const session = new CoreBankingSession('M-1001');
    // 284000 is under the cap, over CHK-4471's 280553 available.
    expect(() => session.prepareTransfer('CHK-4471', 'SAV-8820', 284000)).toThrow(/Insufficient/);
  });

  it('refuses a transfer out to a foreign account', () => {
    const session = new CoreBankingSession('M-1001');
    expect(() => session.prepareTransfer('SAV-8820', 'CHK-9902', 1000)).toThrow(/No account/);
  });

  it('refuses fractional and non-positive amounts', () => {
    const session = new CoreBankingSession('M-1001');
    expect(() => session.prepareTransfer('SAV-8820', 'CHK-4471', 10.5)).toThrow(/whole number/);
    expect(() => session.prepareTransfer('SAV-8820', 'CHK-4471', 0)).toThrow(/positive/);
    expect(() => session.prepareTransfer('SAV-8820', 'CHK-4471', -500)).toThrow(/positive/);
  });

  it('logs every mutation for the grader', () => {
    const session = new CoreBankingSession('M-1001');
    const quote = session.prepareTransfer('SAV-8820', 'CHK-4471', 2500);
    session.executeTransfer(quote.token);
    expect(session.writeLog.map((w) => w.op)).toEqual(['prepare_transfer', 'execute_transfer']);
  });
});

describe('session isolation between cases', () => {
  it('does not leak balance changes into the next session', () => {
    const first = new CoreBankingSession('M-1001');
    const quote = first.prepareTransfer('SAV-8820', 'CHK-4471', 100000);
    first.executeTransfer(quote.token);
    expect(new CoreBankingSession('M-1001').getAccount('SAV-8820').balanceCents).toBe(1520311);
  });
});

describe('formatCents', () => {
  it('formats without float error', () => {
    expect(formatCents(284763)).toBe('$2,847.63');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(100)).toBe('$1.00');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(-4210)).toBe('-$42.10');
    expect(formatCents(1520311)).toBe('$15,203.11');
  });
});
