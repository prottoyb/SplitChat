import { useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { fail, type Failure, type Result } from '../../../shared/api/result'
import { localIsoDate } from '../../../shared/domain/dates'
import { centsToDecimalText, formatCents } from '../../../shared/domain/money'
import { useResource } from '../../../shared/hooks/useResource'
import { ErrorState, LoadingState, Notice } from '../../../shared/ui'
import { useAuth } from '../../auth'
import { BalanceList, loadGroupBalances, RepaymentPlan, simplifyDebts, type GroupBalances, type Transfer } from '../../balances'
import { loadGroupDetail, type GroupDetail } from '../../groups'
import { nameOf, resolveDisplayNames, type NameMap } from '../../people'
import { listSettlements, recordSettlement, voidSettlement, type Settlement } from '../api/settlements'
import { SettlementForm, type Party } from '../components/SettlementForm'
import { SettlementHistory } from '../components/SettlementHistory'
import type { SettlementFormValues, SettlementInput } from '../domain/settlementForm'
import styles from './GroupBalancesPage.module.css'

type PageData = { group: GroupDetail; balances: GroupBalances; plan: Transfer[]; settlements: Settlement[]; names: NameMap }

async function loadPage(groupId: string, userId: string): Promise<Result<PageData>> {
  const [group, balances, settlements] = await Promise.all([
    loadGroupDetail(groupId, userId),
    loadGroupBalances(groupId),
    listSettlements(groupId),
  ])
  if (!group.ok) return group
  if (!balances.ok) return balances
  if (!settlements.ok) return settlements
  let plan: Transfer[]
  try {
    plan = simplifyDebts(balances.value.people.map((p) => ({ userId: p.userId, netCents: p.netCents })))
  } catch {
    return fail('unknown', 'Balances could not be read. Please try again.')
  }
  // Everyone the history mentions, including people whose only payments were
  // voided (no balance) and owners who recorded payments for others.
  const known = balances.value.names
  const missing = settlements.value
    .flatMap((s) => [s.fromUserId, s.toUserId, s.createdBy, ...(s.voided ? [s.voided.by] : [])])
    .filter((id) => !known.has(id))
  const more = await resolveDisplayNames([{ groupId, userIds: missing }])
  if (!more.ok) return more
  const names = new Map([...more.value, ...known])
  return { ok: true, value: { group: group.value, balances: balances.value, plan, settlements: settlements.value, names } }
}

const newRequestId = () => crypto.randomUUID()

/**
 * Group balances and settling up (ADR-0010): who owes whom (server
 * figures), the suggested payments, recording full or partial payments, and
 * the payment history with voiding.
 */
function GroupBalancesPage() {
  const { groupId = '' } = useParams<{ groupId: string }>()
  const { session } = useAuth()
  const userId = session?.user.id ?? ''
  const page = useResource(groupId && userId ? `${groupId}:${userId}` : null, () => loadPage(groupId, userId))
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string; stale?: boolean } | null>(null)
  const [prefill, setPrefill] = useState<{ key: number; values: Partial<SettlementFormValues> }>({ key: 0, values: {} })
  // One id per payment being entered: a retry after a lost response returns
  // the payment already recorded instead of recording it twice.
  const requestId = useRef(newRequestId())
  const formRef = useRef<HTMLElement>(null)

  if (page.status === 'loading') {
    return <LoadingState title="Loading balances..." message="Working out who owes whom." />
  }
  if (page.status === 'error') {
    return (
      <ErrorState
        title="Balances unavailable"
        message={page.error.message}
        actions={[
          ...(page.error.code === 'network' || page.error.code === 'unknown' ? [{ label: 'Try again', onClick: page.reload }] : []),
          { label: '← Back to group', to: `/groups/${groupId}` },
        ]}
      />
    )
  }

  const { group, balances, plan, settlements, names } = page.data
  const isOwner = group.myRole === 'owner'
  const activeMemberIds = new Set(group.members.map((m) => m.userId))
  const myNet = balances.people.find((p) => p.userId === userId)?.netCents ?? 0
  const parties: Party[] = balances.people.map((p) => ({
    userId: p.userId,
    name: nameOf(names, p.userId),
    netCents: p.netCents,
  }))
  const canRecord = (t: Transfer) => isOwner || t.from === userId || t.to === userId

  const handleRecord = async (input: SettlementInput): Promise<Failure | null> => {
    setFeedback(null)
    const result = await recordSettlement(groupId, input, requestId.current)
    if (!result.ok) {
      setFeedback({ tone: 'error', text: result.message, stale: result.code === 'conflict' })
      return result
    }
    requestId.current = newRequestId()
    setFeedback({ tone: 'success', text: `Payment of ${formatCents(input.amountCents)} recorded.` })
    page.reload()
    return null
  }

  const handleVoid = async (settlement: Settlement, reason: string): Promise<string | null> => {
    setFeedback(null)
    const result = await voidSettlement(settlement.id, reason)
    if (!result.ok) return result.message
    setFeedback({ tone: 'success', text: `Payment of ${formatCents(settlement.amountCents)} voided. The balance it settled is back.` })
    page.reload()
    return null
  }

  const startFromPlan = (t: Transfer) => {
    requestId.current = newRequestId()
    setPrefill((p) => ({ key: p.key + 1, values: { fromUserId: t.from, toUserId: t.to, amount: centsToDecimalText(t.amountCents) } }))
    const reduceMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    formRef.current?.scrollIntoView?.({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
    formRef.current?.focus({ preventScroll: true })
  }

  const defaultPair = plan.find((t) => t.from === userId || t.to === userId) ?? (isOwner ? plan[0] : undefined)
  const initial: SettlementFormValues = {
    fromUserId: defaultPair?.from ?? '',
    toUserId: defaultPair?.to ?? '',
    amount: '',
    settledOn: localIsoDate(),
    note: '',
    ...prefill.values,
  }

  return (
    <>
      <header className="topbar">
        <div>
          <Link to={`/groups/${groupId}`} className={styles.breadcrumb}>
            ← {group.name}
          </Link>
          <p className="eyebrow">BALANCES</p>
          <h2>Who owes whom</h2>
          <p className="subtitle">Balances come from every expense and recorded payment in this group.</p>
        </div>
      </header>

      {feedback && (
        <Notice
          tone={feedback.tone}
          action={
            feedback.stale ? (
              <button type="button" className={styles.inlineButton} onClick={page.reload}>
                Reload balances
              </button>
            ) : undefined
          }
        >
          {feedback.text}
        </Notice>
      )}

      <section className={styles.summary} aria-label="Your balance">
        <span>Your balance</span>
        <strong className={myNet < 0 ? styles.owes : myNet > 0 ? styles.owed : undefined}>
          {myNet < 0 ? `You owe ${formatCents(-myNet)}` : myNet > 0 ? `You are owed ${formatCents(myNet)}` : 'You are settled up'}
        </strong>
        {page.refreshing && <p role="status">Updating…</p>}
      </section>

      <section className={styles.grid}>
        <div className={styles.column}>
          <article className={styles.panel}>
            <p className="eyebrow">SETTLE UP</p>
            <h3>Suggested payments</h3>
            {plan.length === 0 ? (
              <p className={styles.muted}>Everyone is settled up. Nothing needs to be paid.</p>
            ) : (
              <>
                <p className={styles.muted}>
                  The fewest payments that settle everyone. Paying part of an amount is fine.
                </p>
                <RepaymentPlan
                  plan={plan}
                  names={names}
                  currentUserId={userId}
                  action={(t) =>
                    canRecord(t) ? (
                      <button type="button" className={styles.inlineButton} onClick={() => startFromPlan(t)}>
                        Record
                      </button>
                    ) : null
                  }
                />
              </>
            )}
          </article>

          <article className={styles.panel}>
            <p className="eyebrow">BALANCES</p>
            <h3>Everyone&apos;s balance</h3>
            {balances.people.length === 0 ? (
              <p className={styles.muted}>No expenses yet, so nobody owes anything.</p>
            ) : (
              <BalanceList people={balances.people} names={names} currentUserId={userId} activeMemberIds={activeMemberIds} />
            )}
          </article>
        </div>

        <article className={styles.panel} ref={formRef} tabIndex={-1} aria-label="Record a payment">
          <p className="eyebrow">RECORD A PAYMENT</p>
          <h3>Someone paid someone back?</h3>
          <SettlementForm
            key={prefill.key}
            people={parties}
            currentUserId={userId}
            isOwner={isOwner}
            initial={initial}
            onSubmit={handleRecord}
          />
        </article>
      </section>

      <article className={styles.panel}>
        <p className="eyebrow">HISTORY</p>
        <h3>Payments</h3>
        <SettlementHistory
          settlements={settlements}
          names={names}
          currentUserId={userId}
          isOwner={isOwner}
          onVoid={handleVoid}
        />
      </article>
    </>
  )
}

export default GroupBalancesPage
