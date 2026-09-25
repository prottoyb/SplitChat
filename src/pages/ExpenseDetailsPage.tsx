import {
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  Link,
  useParams,
} from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { supabase } from '../lib/supabase'
import styles from './ExpenseDetailsPage.module.css'

type Expense = {
  id: string
  group_id: string
  description: string
  amount: number | string
  expense_date: string
  paid_by: string
  created_by: string
  split_type: 'equal' | 'exact' | 'percentage'
  notes: string | null
  created_at: string
  updated_at: string
}

type Group = {
  id: string
  name: string
  description: string | null
}

type ExpenseSplit = {
  expense_id: string
  user_id: string
  share_amount: number | string
  percentage: number | string | null
  created_at: string
}

type Profile = {
  id: string
  full_name: string
  avatar_url: string | null
}

type DisplaySplit = {
  userId: string
  fullName: string
  shareAmount: number
  percentage: number | null
}

type ExpenseDetails = {
  expense: Expense
  group: Group
  payerName: string
  creatorName: string
  splits: DisplaySplit[]
}

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
  }).format(amount)
}

function formatExpenseDate(date: string) {
  return new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(
    new Date(`${date}T00:00:00`),
  )
}

function formatCreatedDate(date: string) {
  return new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(date))
}

function getInitials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) =>
        part.charAt(0).toUpperCase(),
      )
      .join('') || 'SC'
  )
}

function getSplitLabel(
  splitType: Expense['split_type'],
) {
  if (splitType === 'equal') {
    return 'Equal split'
  }

  if (splitType === 'exact') {
    return 'Exact amounts'
  }

  return 'Percentage split'
}

function ExpenseDetailsPage() {
  const { expenseId } =
    useParams<{ expenseId: string }>()

  const { session } = useAuth()

  const [details, setDetails] =
    useState<ExpenseDetails | null>(null)

  const [isLoading, setIsLoading] =
    useState(true)

  const [errorMessage, setErrorMessage] =
    useState('')

  useEffect(() => {
    let cancelled = false

    const loadExpense = async () => {
      if (!expenseId) {
        setErrorMessage(
          'Expense ID is missing.',
        )
        setIsLoading(false)
        return
      }

      setIsLoading(true)
      setErrorMessage('')

      const {
        data: expenseData,
        error: expenseError,
      } = await supabase
        .from('expenses')
        .select(
          `
          id,
          group_id,
          description,
          amount,
          expense_date,
          paid_by,
          created_by,
          split_type,
          notes,
          created_at,
          updated_at
          `,
        )
        .eq('id', expenseId)
        .limit(1)

      if (cancelled) {
        return
      }

      if (expenseError) {
        console.error(
          'Unable to load expense:',
          expenseError,
        )

        setDetails(null)

        setErrorMessage(
          'Unable to load this expense.',
        )

        setIsLoading(false)
        return
      }

      const loadedExpense =
        (expenseData?.[0] as
          | Expense
          | undefined) ?? null

      if (!loadedExpense) {
        setDetails(null)

        setErrorMessage(
          'This expense does not exist or you do not have access to it.',
        )

        setIsLoading(false)
        return
      }

      const [
        groupResult,
        splitResult,
      ] = await Promise.all([
        supabase
          .from('groups')
          .select(
            'id, name, description',
          )
          .eq(
            'id',
            loadedExpense.group_id,
          )
          .limit(1),

        supabase
          .from('expense_splits')
          .select(
            `
            expense_id,
            user_id,
            share_amount,
            percentage,
            created_at
            `,
          )
          .eq(
            'expense_id',
            loadedExpense.id,
          )
          .order('created_at', {
            ascending: true,
          }),
      ])

      if (cancelled) {
        return
      }

      if (groupResult.error) {
        console.error(
          'Unable to load expense group:',
          groupResult.error,
        )

        setDetails(null)

        setErrorMessage(
          'Unable to load the expense group.',
        )

        setIsLoading(false)
        return
      }

      if (splitResult.error) {
        console.error(
          'Unable to load expense splits:',
          splitResult.error,
        )

        setDetails(null)

        setErrorMessage(
          'Unable to load the expense split information.',
        )

        setIsLoading(false)
        return
      }

      const loadedGroup =
        (groupResult.data?.[0] as
          | Group
          | undefined) ?? null

      if (!loadedGroup) {
        setDetails(null)

        setErrorMessage(
          'The group for this expense is unavailable.',
        )

        setIsLoading(false)
        return
      }

      const loadedSplits =
        (splitResult.data ??
          []) as ExpenseSplit[]

      const profileIds = Array.from(
        new Set([
          loadedExpense.paid_by,
          loadedExpense.created_by,
          ...loadedSplits.map(
            (split) => split.user_id,
          ),
        ]),
      )

      let profiles: Profile[] = []

      if (profileIds.length > 0) {
        const {
          data: profileData,
          error: profileError,
        } = await supabase
          .from('profiles')
          .select(
            'id, full_name, avatar_url',
          )
          .in('id', profileIds)

        if (cancelled) {
          return
        }

        if (profileError) {
          console.error(
            'Unable to load expense profiles:',
            profileError,
          )

          setDetails(null)

          setErrorMessage(
            'Unable to load the expense member information.',
          )

          setIsLoading(false)
          return
        }

        profiles =
          (profileData ?? []) as Profile[]
      }

      const profileMap = new Map(
        profiles.map((profile) => [
          profile.id,
          profile.full_name?.trim() ||
            'SplitChat member',
        ]),
      )

      const displaySplits: DisplaySplit[] =
        loadedSplits.map((split) => ({
          userId: split.user_id,

          fullName:
            profileMap.get(split.user_id) ||
            'SplitChat member',

          shareAmount:
            Number(split.share_amount),

          percentage:
            split.percentage === null
              ? null
              : Number(split.percentage),
        }))

      setDetails({
        expense: loadedExpense,

        group: loadedGroup,

        payerName:
          profileMap.get(
            loadedExpense.paid_by,
          ) || 'SplitChat member',

        creatorName:
          profileMap.get(
            loadedExpense.created_by,
          ) || 'SplitChat member',

        splits: displaySplits,
      })

      setIsLoading(false)
    }

    void loadExpense()

    return () => {
      cancelled = true
    }
  }, [expenseId])

  const userId = session?.user.id

  const yourShare = useMemo(() => {
    if (!details || !userId) {
      return null
    }

    const split = details.splits.find(
      (item) =>
        item.userId === userId,
    )

    return split?.shareAmount ?? null
  }, [details, userId])

  const splitTotal = useMemo(() => {
    if (!details) {
      return 0
    }

    return details.splits.reduce(
      (total, split) =>
        total + split.shareAmount,
      0,
    )
  }, [details])

  if (isLoading) {
    return (
      <section className={styles.stateCard}>
        <div className={styles.stateIcon}>
          ◎
        </div>

        <h2>Loading expense...</h2>

        <p>
          Getting the expense and split
          information.
        </p>
      </section>
    )
  }

  if (!details) {
    return (
      <section className={styles.stateCard}>
        <div className={styles.stateIcon}>
          !
        </div>

        <h2>Expense unavailable</h2>

        <p>
          {errorMessage ||
            'This expense could not be loaded.'}
        </p>

        <Link
          to="/expenses"
          className={styles.backLink}
        >
          ← Back to expenses
        </Link>
      </section>
    )
  }

  const {
    expense,
    group,
    payerName,
    creatorName,
    splits,
  } = details

  const youPaid =
    expense.paid_by === session?.user.id

  const youCreated =
    expense.created_by ===
    session?.user.id

  return (
    <>
      <header className="topbar">
        <div>
          <Link
            to="/expenses"
            className={styles.breadcrumb}
          >
            ← Expenses
          </Link>

          <p className="eyebrow">
            EXPENSE DETAILS
          </p>

          <h2>
            {expense.description}
          </h2>

          <p className="subtitle">
            {group.name}
          </p>
        </div>

        <div
          className={styles.amountBadge}
        >
          {formatCurrency(
            Number(expense.amount),
          )}
        </div>
      </header>

      <section
        className={styles.overviewGrid}
      >
        <article className={styles.statCard}>
          <span>Total expense</span>

          <strong>
            {formatCurrency(
              Number(expense.amount),
            )}
          </strong>

          <p>
            Full amount recorded
          </p>
        </article>

        <article className={styles.statCard}>
          <span>Your share</span>

          <strong>
            {yourShare === null
              ? 'Not included'
              : formatCurrency(
                  yourShare,
                )}
          </strong>

          <p>
            Your portion of this expense
          </p>
        </article>

        <article className={styles.statCard}>
          <span>Paid by</span>

          <strong>
            {youPaid
              ? 'You'
              : payerName}
          </strong>

          <p>
            Member who covered the payment
          </p>
        </article>

        <article className={styles.statCard}>
          <span>Expense date</span>

          <strong>
            {formatExpenseDate(
              expense.expense_date,
            )}
          </strong>

          <p>
            Date this cost occurred
          </p>
        </article>
      </section>

      <section
        className={styles.contentGrid}
      >
        <article className={styles.panel}>
          <div
            className={styles.panelHeader}
          >
            <div>
              <p className="eyebrow">
                SPLIT BREAKDOWN
              </p>

              <h3>
                Who owes what?
              </h3>
            </div>

            <span
              className={
                styles.memberCount
              }
            >
              {splits.length}
            </span>
          </div>

          {splits.length === 0 ? (
            <div
              className={
                styles.emptySplits
              }
            >
              <p>
                No participant splits were found
                for this expense.
              </p>
            </div>
          ) : (
            <div
              className={styles.splitList}
            >
              {splits.map((split) => {
                const isCurrentUser =
                  split.userId ===
                  session?.user.id

                const isPayer =
                  split.userId ===
                  expense.paid_by

                return (
                  <div
                    key={split.userId}
                    className={
                      styles.splitRow
                    }
                  >
                    <div
                      className={
                        styles.memberAvatar
                      }
                    >
                      {getInitials(
                        split.fullName,
                      )}
                    </div>

                    <div
                      className={
                        styles.memberInfo
                      }
                    >
                      <div
                        className={
                          styles.memberNameRow
                        }
                      >
                        <strong>
                          {split.fullName}
                        </strong>

                        {isCurrentUser && (
                          <span
                            className={
                              styles.youBadge
                            }
                          >
                            You
                          </span>
                        )}

                        {isPayer && (
                          <span
                            className={
                              styles.payerBadge
                            }
                          >
                            Paid
                          </span>
                        )}
                      </div>

                      <span>
                        {expense.split_type ===
                          'percentage' &&
                        split.percentage !==
                          null
                          ? `${split.percentage}% of expense`
                          : getSplitLabel(
                              expense.split_type,
                            )}
                      </span>
                    </div>

                    <strong
                      className={
                        styles.shareAmount
                      }
                    >
                      {formatCurrency(
                        split.shareAmount,
                      )}
                    </strong>
                  </div>
                )
              })}
            </div>
          )}

          <div
            className={styles.splitTotal}
          >
            <span>
              Split total
            </span>

            <strong>
              {formatCurrency(
                splitTotal,
              )}
            </strong>
          </div>
        </article>

        <aside
          className={styles.sideColumn}
        >
          <article
            className={styles.panel}
          >
            <div
              className={
                styles.panelHeader
              }
            >
              <div>
                <p className="eyebrow">
                  INFORMATION
                </p>

                <h3>
                  Expense information
                </h3>
              </div>
            </div>

            <div
              className={styles.infoList}
            >
              <div>
                <span>Group</span>

                <Link
                  to={`/groups/${group.id}`}
                  className={
                    styles.groupLink
                  }
                >
                  {group.name}
                </Link>
              </div>

              <div>
                <span>
                  Split method
                </span>

                <strong>
                  {getSplitLabel(
                    expense.split_type,
                  )}
                </strong>
              </div>

              <div>
                <span>Paid by</span>

                <strong>
                  {youPaid
                    ? 'You'
                    : payerName}
                </strong>
              </div>

              <div>
                <span>Added by</span>

                <strong>
                  {youCreated
                    ? 'You'
                    : creatorName}
                </strong>
              </div>

              <div>
                <span>Created</span>

                <strong>
                  {formatCreatedDate(
                    expense.created_at,
                  )}
                </strong>
              </div>
            </div>
          </article>

          <article
            className={styles.panel}
          >
            <div
              className={
                styles.panelHeader
              }
            >
              <div>
                <p className="eyebrow">
                  NOTES
                </p>

                <h3>
                  Additional details
                </h3>
              </div>
            </div>

            {expense.notes ? (
              <p className={styles.notes}>
                {expense.notes}
              </p>
            ) : (
              <p
                className={
                  styles.noNotes
                }
              >
                No notes were added to this
                expense.
              </p>
            )}
          </article>
        </aside>
      </section>
    </>
  )
}

export default ExpenseDetailsPage