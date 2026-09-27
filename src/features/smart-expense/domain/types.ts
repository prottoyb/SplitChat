/** The candidate structure every Smart Expense interpreter produces (ADR-0012). */

export type Member = { id: string; name: string }

export type InterpretContext = {
  senderId: string
  /** The sender's local date of the message (YYYY-MM-DD). */
  messageDate: string
  /** Active members of the group (former and deleted members never match). */
  members: readonly Member[]
}

export type DraftField = 'description' | 'amount' | 'date' | 'payer' | 'participants'

export type IssueCode =
  | 'missing'
  | 'ambiguous'
  | 'unknown_name'
  | 'multiple_amounts'
  | 'invalid_amount'
  | 'unsupported_currency'
  | 'too_long'
  | 'invalid_date'

export type Issue = { field: DraftField; code: IssueCode; token?: string; matches?: string[] }

export type Draft = {
  description: string | null
  amountCents: number | null
  expenseDate: string | null
  paidBy: string | null
  participantIds: string[] | null
}

export type Interpretation =
  | { kind: 'none' }
  | { kind: 'candidate'; source: 'command' | 'natural'; draft: Draft; issues: Issue[]; interpreterVersion: string }

/** Anything that can produce a candidate draft — deterministic now, possibly an LLM later — without authority over money. */
export interface ExpenseInterpreter {
  readonly version: string
  interpret(body: string, ctx: InterpretContext): Promise<Interpretation>
}

export const DETERMINISTIC_VERSION = 'deterministic-1'
export const MAX_NATURAL_LENGTH = 500
