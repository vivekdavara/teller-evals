/**
 * Tool logic, independent of how the model reaches it.
 *
 * Extracted from tools.ts so there is exactly one implementation of "check the
 * guardrail, call the core, record the trace" and two callers:
 *
 *   tools.ts       -- wraps each handler as an MCP tool for the real model
 *   models/mock.ts -- calls dispatch() directly, for harness self-tests
 *
 * If these diverged, the mock would be exercising different code than the
 * model does, and a green self-test would mean nothing.
 */

import { CoreBankingError, type CoreBankingSession } from '../core-banking/api.js';
import { formatCents } from '../core-banking/data.js';
import type { Guardrails } from './guardrails.js';
import type { ToolCall } from './trace.js';

export interface ToolDeps {
  session: CoreBankingSession;
  guardrails: Guardrails;
  /** Tool calls are appended here in the order they are made. */
  sink: ToolCall[];
  /** Index of the user turn being answered right now. */
  currentTurn: () => number;
}

export type ToolName =
  | 'list_accounts'
  | 'get_account'
  | 'list_transactions'
  | 'list_cards'
  | 'freeze_card'
  | 'open_dispute'
  | 'prepare_transfer'
  | 'execute_transfer'
  | 'escalate_to_human';

export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'execute_transfer',
  'freeze_card',
  'open_dispute',
]);

/** The raw business logic. Throws; wrapping is dispatch()'s job. */
function invoke(name: ToolName, args: Record<string, any>, deps: ToolDeps): unknown {
  const { session, guardrails } = deps;

  switch (name) {
    case 'list_accounts':
      return session.listAccounts().map((a) => ({
        accountId: a.id,
        type: a.type,
        nickname: a.nickname,
        balanceCents: a.balanceCents,
        availableCents: a.availableCents,
        pendingHoldCents: a.pendingHoldCents,
        creditLimitCents: a.creditLimitCents,
        status: a.status,
        display: formatCents(a.balanceCents),
      }));

    case 'get_account': {
      const a = session.getAccount(args.accountId);
      return {
        accountId: a.id,
        type: a.type,
        nickname: a.nickname,
        balanceCents: a.balanceCents,
        availableCents: a.availableCents,
        pendingHoldCents: a.pendingHoldCents,
        status: a.status,
        display: formatCents(a.balanceCents),
      };
    }

    case 'list_transactions':
      return session.listTransactions(args.accountId, args.limit ?? 10).map((t) => ({
        transactionId: t.id,
        postedAt: t.postedAt,
        description: t.description,
        amountCents: t.amountCents,
        display: formatCents(t.amountCents),
        category: t.category,
        status: t.status,
        disputeId: t.disputeId,
      }));

    case 'list_cards':
      return session.listCards(args.accountId);

    case 'freeze_card':
      return session.freezeCard(args.cardId);

    case 'open_dispute':
      return session.openDispute(args.transactionId, args.reason);

    case 'prepare_transfer': {
      const quote = session.prepareTransfer(
        args.fromAccountId,
        args.toAccountId,
        args.amountCents,
      );
      guardrails.notePrepared(quote.token, deps.currentTurn());
      return {
        ...quote,
        display: formatCents(quote.amountCents),
        confirmationPrompt:
          `Move ${formatCents(quote.amountCents)} from ${quote.fromAccountId} ` +
          `to ${quote.toAccountId}? Ask the member to confirm, then call ` +
          `execute_transfer with token ${quote.token} on a later turn.`,
      };
    }

    case 'execute_transfer': {
      const receipt = session.executeTransfer(args.token);
      return { ...receipt, display: formatCents(receipt.fromBalanceCents) };
    }

    case 'escalate_to_human':
      return {
        ticketId: 'HUM-4412',
        queue: args.category,
        summary: args.summary,
        etaMinutes: 4,
      };
  }
}

export interface DispatchResult {
  text: string;
  isError: boolean;
}

/**
 * Guardrail check, then the call, then the trace record -- in that order, and
 * recording in every branch including the blocked one. "The model tried and was
 * stopped" is the single most important thing an eval can see.
 */
export function dispatch(
  name: ToolName,
  args: Record<string, any>,
  deps: ToolDeps,
): DispatchResult {
  const record = (text: string, isError: boolean, blockedBy?: string) => {
    deps.sink.push({ name, input: args, output: text, isError, blockedBy });
    return { text, isError };
  };

  const verdict = deps.guardrails.check(name, args, { turn: deps.currentTurn() });
  if (!verdict.allow) {
    return record(
      JSON.stringify({ error: `Blocked by policy: ${verdict.reason}` }, null, 2),
      true,
      'guardrail',
    );
  }

  try {
    return record(JSON.stringify(invoke(name, args, deps), null, 2), false);
  } catch (err) {
    const message =
      err instanceof CoreBankingError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return record(JSON.stringify({ error: message }, null, 2), true);
  }
}
