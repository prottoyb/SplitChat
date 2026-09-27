/**
 * Deterministic Smart Expense interpretation (ADR-0012). An interpreter only
 * turns a chat message into a draft: it never writes anything, never calls an
 * API, and never guesses a critical field — anything not stated and resolved
 * to exactly one value is left null with an issue explaining why.
 */

import { COMMAND, interpretCommand } from './command'
import { interpretNatural } from './natural'
import { normalize } from './text'
import { DETERMINISTIC_VERSION, type ExpenseInterpreter, type InterpretContext, type Interpretation } from './types'

export type { Draft, DraftField, ExpenseInterpreter, InterpretContext, Interpretation, Issue, IssueCode, Member } from './types'
export { DETERMINISTIC_VERSION, MAX_NATURAL_LENGTH } from './types'
export { normalize } from './text'


/** Synchronous core, for tests and callers that need no interface. */
export function interpretMessage(body: string, ctx: InterpretContext): Interpretation {
  const text = normalize(body)
  if (!text) return { kind: 'none' }
  if (COMMAND.test(text)) return interpretCommand(text, ctx)
  return interpretNatural(text, ctx)
}

export const deterministicInterpreter: ExpenseInterpreter = {
  version: DETERMINISTIC_VERSION,
  interpret: (body, ctx) => Promise.resolve(interpretMessage(body, ctx)),
}
