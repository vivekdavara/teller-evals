/**
 * Enforcement that does not depend on the model cooperating.
 *
 * The system prompt asks the agent to confirm before moving money. This file
 * makes it true. Everything here is deterministic and runs in-process between
 * the model's tool call and the core banking API, so a jailbroken or simply
 * confused model still cannot execute a transfer the member never saw.
 *
 * Division of labour:
 *   policy.ts     -- what we ask the model to do
 *   guardrails.ts -- what we refuse to let it do
 *   evals/        -- whether the first one is working, since the second one
 *                    only catches what we thought of in advance
 */

export interface GuardrailContext {
  /** 0-based index of the user turn currently being answered. */
  turn: number;
}

export type GuardrailVerdict = { allow: true } | { allow: false; reason: string };

export class Guardrails {
  /** token -> turn index it was prepared in. */
  private readonly preparedInTurn = new Map<string, number>();
  private writes = 0;

  /** Refusals, for the report. A guardrail that never fires is untested. */
  readonly blocks: Array<{ tool: string; reason: string; turn: number }> = [];

  constructor(private readonly maxWritesPerSession = 3) {}

  /** Called after a successful prepare_transfer so execute can be checked. */
  notePrepared(token: string, turn: number): void {
    this.preparedInTurn.set(token, turn);
  }

  check(tool: string, input: Record<string, unknown>, ctx: GuardrailContext): GuardrailVerdict {
    const isWrite =
      tool === 'execute_transfer' || tool === 'freeze_card' || tool === 'open_dispute';

    if (isWrite && this.writes >= this.maxWritesPerSession) {
      return this.deny(tool, ctx, `Session write cap (${this.maxWritesPerSession}) reached.`);
    }

    if (tool === 'execute_transfer') {
      const token = typeof input.token === 'string' ? input.token : '';
      const preparedTurn = this.preparedInTurn.get(token);

      if (preparedTurn === undefined) {
        return this.deny(
          tool,
          ctx,
          'No prepared transfer matches that token. Call prepare_transfer and read the quote back to the member first.',
        );
      }

      // The load-bearing check. A new turn index means the member sent another
      // message after seeing the quote -- the only evidence of consent we can
      // verify without trusting the model's own account of the conversation.
      if (preparedTurn === ctx.turn) {
        return this.deny(
          tool,
          ctx,
          'Refusing to execute a transfer in the same turn it was prepared. Show the member the quote and wait for their confirmation.',
        );
      }
    }

    if (isWrite) this.writes += 1;
    return { allow: true };
  }

  private deny(tool: string, ctx: GuardrailContext, reason: string): GuardrailVerdict {
    this.blocks.push({ tool, reason, turn: ctx.turn });
    return { allow: false, reason };
  }
}

/**
 * Scrubs values that should never reach a log sink, even ours.
 *
 * Account ids stay readable (they are how support finds the case) but anything
 * shaped like a card number, SSN, or full-length account number is masked.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, (m) => `****${m.replace(/\D/g, '').slice(-4)}`)
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '***-**-****')
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, (m) => `${m[0]}***@${m.split('@')[1]}`);
}
