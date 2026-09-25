import {
  useEffect,
  useMemo,
  useState,
} from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { supabase } from '../lib/supabase'
import styles from './ExpensesPage.module.css'

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
}

type Profile = {
  id: string
  full_name: string
  avatar_url: string | null
}

type ExpenseSplit = {
  expense_id: string
  user_id: string
  share_amount: number | string
}

type DisplayExpense = {
  id: string
  groupId: string
  groupName: string
  description: string
  amount: number
  expenseDate: string
  paidById: string
  paidByName: string
  splitType: 'equal' | 'exact' | 'percentage'
  notes: string | null
  yourShare: number | null
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
    month: 'short',
    year: 'numeric',
  }).format(
    new Date(`${date}T00:00:00`),
  )
}

function getSplitLabel(
  splitType: DisplayExpense['splitType'],
) {
  if (splitType === 'equal') {
    return 'equally'
  }

  if (splitType === 'exact') {
    return 'by exact amounts'
  }

  return 'by percentage'
}

function ExpensesPage() {
  const { session } = useAuth()

  const [expenses, setExpenses] =
    useState<DisplayExpense[]>([])

  const [isLoading, setIsLoading] =
    useState(true)

  const [errorMessage, setErrorMessage] =
    useState('')

  const userId = session?.user.id

  const [reloadKey, setReloadKey] = useState(0)

  const reload = () => {
    setReloadKey((key) => key + 1)
  }

  useEffect(() => {
    let cancelled = false

    const loadExpenses = async () => {
      if (!userId) {
        setExpenses([])
        setErrorMessage(
          'Your session information is unavailable.',
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
        .order('expense_date', {
          ascending: false,
        })
        .order('created_at', {
          ascending: false,
        })

      if (cancelled) {
        return
      }

      if (expenseError) {
        console.error(
          'Unable to load expenses:',
          expenseError,
        )

        setExpenses([])
        setErrorMessage(
          'Unable to load your expenses.',
        )
        setIsLoading(false)
        return
      }

      const loadedExpenses =
        (expenseData ?? []) as Expense[]

      if (loadedExpenses.length === 0) {
        setExpenses([])
        setIsLoading(false)
        return
      }

      const groupIds = Array.from(
        new Set(
          loadedExpenses.map(
            (expense) => expense.group_id,
          ),
        ),
      )

      const profileIds = Array.from(
        new Set(
          loadedExpenses.map(
            (expense) => expense.paid_by,
          ),
        ),
      )

      const expenseIds = loadedExpenses.map(
        (expense) => expense.id,
      )

      const [
        groupResult,
        profileResult,
        splitResult,
      ] = await Promise.all([
        supabase
          .from('groups')
          .select('id, name')
          .in('id', groupIds),

        supabase
          .from('profiles')
          .select('id, full_name, avatar_url')
          .in('id', profileIds),

        supabase
          .from('expense_splits')
          .select(
            'expense_id, user_id, share_amount',
          )
          .in('expense_id', expenseIds)
          .eq('user_id', userId),
      ])

      if (cancelled) {
        return
      }

      if (groupResult.error) {
        console.error(
          'Unable to load expense groups:',
          groupResult.error,
        )

        setExpenses([])
        setErrorMessage(
          'Unable to load expense group information.',
        )
        setIsLoading(false)
        return
      }

      if (profileResult.error) {
        console.error(
          'Unable to load expense profiles:',
          profileResult.error,
        )

        setExpenses([])
        setErrorMessage(
          'Unable to load expense member information.',
        )
        setIsLoading(false)
        return
      }

      if (splitResult.error) {
        console.error(
          'Unable to load your expense shares:',
          splitResult.error,
        )

        setExpenses([])
        setErrorMessage(
          'Unable to load your expense shares.',
        )
        setIsLoading(false)
        return
      }

      const groups =
        (groupResult.data ?? []) as Group[]

      const profiles =
        (profileResult.data ?? []) as Profile[]

      const userSplits =
        (splitResult.data ?? []) as ExpenseSplit[]

      const groupMap = new Map(
        groups.map((group) => [
          group.id,
          group.name,
        ]),
      )

      const profileMap = new Map(
        profiles.map((profile) => [
          profile.id,
          profile.full_name?.trim() ||
            'SplitChat member',
        ]),
      )

      const splitMap = new Map(
        userSplits.map((split) => [
          split.expense_id,
          Number(split.share_amount),
        ]),
      )

      const displayExpenses: DisplayExpense[] =
        loadedExpenses.map((expense) => ({
          id: expense.id,

          groupId: expense.group_id,

          groupName:
            groupMap.get(expense.group_id) ||
            'SplitChat group',

          description: expense.description,

          amount: Number(expense.amount),

          expenseDate: expense.expense_date,

          paidById: expense.paid_by,

          paidByName:
            profileMap.get(expense.paid_by) ||
            'SplitChat member',

          splitType: expense.split_type,

          notes: expense.notes,

          yourShare:
            splitMap.get(expense.id) ?? null,
        }))

      setExpenses(displayExpenses)
      setIsLoading(false)
    }

    void loadExpenses()

    return () => {
      cancelled = true
    }
  }, [userId, reloadKey])

  const totalSpend = useMemo(
    () =>
      expenses.reduce(
        (total, expense) =>
          total + expense.amount,
        0,
      ),
    [expenses],
  )

  const yourTotalShare = useMemo(
    () =>
      expenses.reduce(
        (total, expense) =>
          total + (expense.yourShare ?? 0),
        0,
      ),
    [expenses],
  )

  const groupCount = useMemo(
    () =>
      new Set(
        expenses.map(
          (expense) => expense.groupId,
        ),
      ).size,
    [expenses],
  )

  if (isLoading) {
    return (
      <section className={styles.stateCard}>
        <div className={styles.stateIcon}>
          ◎
        </div>

        <h2>Loading expenses...</h2>

        <p>
          Getting your shared expense history.
        </p>
      </section>
    )
  }

  if (errorMessage) {
    return (
      <section className={styles.stateCard}>
        <div className={styles.stateIcon}>
          !
        </div>

        <h2>Unable to load expenses</h2>

        <p>{errorMessage}</p>

        <button
          type="button"
          className="primary-button"
          onClick={() =>
            reload()
          }
        >
          Try again
        </button>
      </section>
    )
  }

  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">
            EXPENSES
          </p>

          <h2>Shared expenses</h2>

          <p className="subtitle">
            Review costs recorded across all of
            your SplitChat groups.
          </p>
        </div>

        <Link
          to="/groups"
          className="primary-button"
        >
          + Add expense
        </Link>
      </header>

      {expenses.length === 0 ? (
        <section className={styles.emptyState}>
          <div className={styles.emptyIcon}>
            $
          </div>

          <p className="eyebrow">
            NO EXPENSES YET
          </p>

          <h3>
            Your shared expenses will appear here
          </h3>

          <p>
            Open one of your groups to record
            your first shared expense.
          </p>

          <Link
            to="/groups"
            className="primary-button"
          >
            View groups
          </Link>
        </section>
      ) : (
        <>
          <section
            className={styles.overviewGrid}
          >
            <article
              className={styles.statCard}
            >
              <span>
                Total shared spend
              </span>

              <strong>
                {formatCurrency(
                  totalSpend,
                )}
              </strong>

              <p>
                Across expenses you can access
              </p>
            </article>

            <article
              className={styles.statCard}
            >
              <span>
                Your total share
              </span>

              <strong>
                {formatCurrency(
                  yourTotalShare,
                )}
              </strong>

              <p>
                Your recorded portion of these
                costs
              </p>
            </article>

            <article
              className={styles.statCard}
            >
              <span>Expenses</span>

              <strong>
                {expenses.length}
              </strong>

              <p>
                Shared costs currently recorded
              </p>
            </article>

            <article
              className={styles.statCard}
            >
              <span>Groups</span>

              <strong>
                {groupCount}
              </strong>

              <p>
                Groups represented in this history
              </p>
            </article>
          </section>

          <section
            className={styles.expensePanel}
          >
            <div
              className={styles.panelHeader}
            >
              <div>
                <p className="eyebrow">
                  RECENT ACTIVITY
                </p>

                <h3>
                  Expense history
                </h3>
              </div>

              <span
                className={
                  styles.expenseCount
                }
              >
                {expenses.length}
              </span>
            </div>

            <div
              className={styles.expenseList}
            >
              {expenses.map((expense) => {
                const youPaid =
                  expense.paidById ===
                  session?.user.id

                return (
                  <article
                    key={expense.id}
                    className={
                      styles.expenseRow
                    }
                  >
                    <div
                      className={
                        styles.expenseIcon
                      }
                    >
                      $
                    </div>

                    <div
                      className={
                        styles.expenseMain
                      }
                    >
                      <div
                        className={
                          styles.expenseTitleRow
                        }
                      >
                        <div>
                          <h4>
                            {
                              expense.description
                            }
                          </h4>

                          <div
                            className={
                              styles.expenseMeta
                            }
                          >
                            <Link
                              to={`/groups/${expense.groupId}`}
                              className={
                                styles.groupLink
                              }
                            >
                              {
                                expense.groupName
                              }
                            </Link>

                            <span>•</span>

                            <span>
                              {formatExpenseDate(
                                expense.expenseDate,
                              )}
                            </span>
                          </div>
                        </div>

                        <strong
                          className={
                            styles.expenseAmount
                          }
                        >
                          {formatCurrency(
                            expense.amount,
                          )}
                        </strong>
                      </div>

                      <div
                        className={
                          styles.expenseDetails
                        }
                      >
                        <span>
                          Paid by{' '}
                          <strong>
                            {youPaid
                              ? 'You'
                              : expense.paidByName}
                          </strong>
                        </span>

                        <span>
                          Split{' '}
                          <strong>
                            {getSplitLabel(
                              expense.splitType,
                            )}
                          </strong>
                        </span>

                        {expense.yourShare !==
                          null && (
                          <span>
                            Your share{' '}
                            <strong>
                              {formatCurrency(
                                expense.yourShare,
                              )}
                            </strong>
                          </span>
                        )}

                        <Link
                          to={`/expenses/${expense.id}`}
                          className={
                            styles.detailsLink
                          }
                        >
                          View details →
                        </Link>
                      </div>

                      {expense.notes && (
                        <p
                          className={
                            styles.expenseNotes
                          }
                        >
                          {expense.notes}
                        </p>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>
          </section>
        </>
      )}
    </>
  )
}

export default ExpensesPage