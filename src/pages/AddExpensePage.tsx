import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { supabase } from '../lib/supabase'
import {
  allocateEqualSplit,
  validateExpenseInput,
} from '../lib/expenseSplit'
import {
  formatCents,
  parseAmountToCents,
} from '../lib/money'
import { rpcErrorMessage } from '../lib/rpcErrors'
import styles from './AddExpensePage.module.css'

type Group = {
  id: string
  name: string
  description: string | null
}

type GroupMembership = {
  group_id: string
  user_id: string
  role: 'owner' | 'member'
  joined_at: string
}

type MemberProfile = {
  id: string
  full_name: string
  avatar_url: string | null
}

type DisplayMember = {
  userId: string
  fullName: string
  avatarUrl: string | null
  role: 'owner' | 'member'
}

type SplitPreview = {
  totalCents: number
  shares: {
    userId: string
    fullName: string
    shareCents: number
  }[]
}

function getTodayInputValue() {
  const today = new Date()

  const year = today.getFullYear()
  const month = String(today.getMonth() + 1).padStart(2, '0')
  const day = String(today.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

function getInitials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join('') || 'SC'
  )
}

function AddExpensePage() {
  const { groupId } = useParams<{ groupId: string }>()
  const { session } = useAuth()

  const [group, setGroup] = useState<Group | null>(null)
  const [members, setMembers] = useState<DisplayMember[]>([])

  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [expenseDate, setExpenseDate] = useState(
    getTodayInputValue(),
  )
  const [paidBy, setPaidBy] = useState('')
  const [participantIds, setParticipantIds] = useState<string[]>(
    [],
  )
  const [notes, setNotes] = useState('')

  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const [errorMessage, setErrorMessage] = useState('')
  const [successMessage, setSuccessMessage] = useState('')

  const userId = session?.user.id

  useEffect(() => {
    let cancelled = false

    const loadExpenseContext = async () => {
      if (!groupId) {
        setErrorMessage('Group ID is missing.')
        setIsLoading(false)
        return
      }

      setIsLoading(true)
      setErrorMessage('')

      const { data: groupData, error: groupError } =
        await supabase
          .from('groups')
          .select('id, name, description')
          .eq('id', groupId)
          .limit(1)

      if (cancelled) {
        return
      }

      if (groupError) {
        console.error(
          'Unable to load expense group:',
          groupError,
        )

        setGroup(null)
        setMembers([])
        setErrorMessage('Unable to load this group.')
        setIsLoading(false)
        return
      }

      const loadedGroup = groupData?.[0] ?? null

      if (!loadedGroup) {
        setGroup(null)
        setMembers([])
        setErrorMessage(
          'This group does not exist or you do not have access to it.',
        )
        setIsLoading(false)
        return
      }

      const {
        data: membershipData,
        error: membershipError,
      } = await supabase
        .from('group_members')
        .select('group_id, user_id, role, joined_at')
        .eq('group_id', groupId)
        .order('joined_at', { ascending: true })

      if (cancelled) {
        return
      }

      if (membershipError) {
        console.error(
          'Unable to load expense members:',
          membershipError,
        )

        setGroup(loadedGroup)
        setMembers([])
        setErrorMessage('Unable to load the group members.')
        setIsLoading(false)
        return
      }

      const memberships =
        (membershipData ?? []) as GroupMembership[]

      const memberIds = memberships.map(
        (membership) => membership.user_id,
      )

      let profiles: MemberProfile[] = []

      if (memberIds.length > 0) {
        const { data: profileData, error: profileError } =
          await supabase
            .from('profiles')
            .select('id, full_name, avatar_url')
            .in('id', memberIds)

        if (cancelled) {
          return
        }

        if (profileError) {
          console.error(
            'Unable to load expense member profiles:',
            profileError,
          )

          setGroup(loadedGroup)
          setMembers([])
          setErrorMessage(
            'Unable to load the group member profiles.',
          )
          setIsLoading(false)
          return
        }

        profiles = (profileData ?? []) as MemberProfile[]
      }

      const profileMap = new Map(
        profiles.map((profile) => [profile.id, profile]),
      )

      const displayMembers: DisplayMember[] =
        memberships.map((membership) => {
          const profile = profileMap.get(
            membership.user_id,
          )

          return {
            userId: membership.user_id,
            fullName:
              profile?.full_name?.trim() ||
              'SplitChat member',
            avatarUrl: profile?.avatar_url ?? null,
            role: membership.role,
          }
        })

      setGroup(loadedGroup)
      setMembers(displayMembers)

      setParticipantIds(
        displayMembers.map((member) => member.userId),
      )

      const currentUserIsMember = displayMembers.some(
        (member) =>
          member.userId === userId,
      )

      if (currentUserIsMember && userId) {
        setPaidBy(userId)
      } else {
        setPaidBy(displayMembers[0]?.userId ?? '')
      }

      setIsLoading(false)
    }

    void loadExpenseContext()

    return () => {
      cancelled = true
    }
  }, [groupId, userId])

  const selectedMembers = useMemo(
    () =>
      members.filter((member) =>
        participantIds.includes(member.userId),
      ),
    [members, participantIds],
  )

  // The same canonical allocation the database applies (ADR-0006). Shares are
  // looked up by user id, so the preview matches what will be stored whatever
  // order participants were selected in.
  const splitPreview = useMemo<SplitPreview | null>(() => {
    const parsedAmount = parseAmountToCents(amount)

    if (!parsedAmount.ok) {
      return null
    }

    const allocation = allocateEqualSplit(
      parsedAmount.cents,
      selectedMembers.map((member) => member.userId),
    )

    if (!allocation.ok) {
      return null
    }

    const shareByUser = new Map(
      allocation.shares.map((share) => [
        share.userId,
        share.shareCents,
      ]),
    )

    return {
      totalCents: parsedAmount.cents,
      shares: selectedMembers.map((member) => ({
        userId: member.userId,
        fullName: member.fullName,
        shareCents:
          shareByUser.get(member.userId.toLowerCase()) ?? 0,
      })),
    }
  }, [amount, selectedMembers])

  const toggleParticipant = (userId: string) => {
    setSuccessMessage('')

    setParticipantIds((currentIds) => {
      if (currentIds.includes(userId)) {
        return currentIds.filter(
          (id) => id !== userId,
        )
      }

      return [...currentIds, userId]
    })
  }

  const selectEveryone = () => {
    setParticipantIds(
      members.map((member) => member.userId),
    )
  }

  const clearParticipants = () => {
    setParticipantIds([])
  }

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault()

    setErrorMessage('')
    setSuccessMessage('')

    if (!groupId) {
      setErrorMessage('Group ID is unavailable.')
      return
    }

    const validation = validateExpenseInput({
      description,
      amount,
      expenseDate,
      paidBy,
      participantIds,
      notes,
      memberIds: members.map((member) => member.userId),
    })

    if (!validation.ok) {
      setErrorMessage(validation.error)
      return
    }

    const expense = validation.value

    try {
      setIsSubmitting(true)

      const { error } = await supabase.rpc(
        'create_equal_split_expense_v2',
        {
          p_group_id: groupId,
          p_description: expense.description,
          p_amount_cents: expense.amountCents,
          p_expense_date: expense.expenseDate,
          p_paid_by: expense.paidBy,
          p_participant_ids: expense.participantIds,
          p_notes: expense.notes,
        },
      )

      if (error) {
        console.error(
          'Unable to create expense:',
          error,
        )

        setErrorMessage(
          rpcErrorMessage(
            error,
            'Unable to create this expense. Please try again.',
          ),
        )
        return
      }

      setDescription('')
      setAmount('')
      setNotes('')

      setSuccessMessage(
        `Expense created successfully and split between ${participantIds.length} ${
          participantIds.length === 1
            ? 'person'
            : 'people'
        }.`,
      )
    } catch (error) {
      console.error(
        'Unexpected create expense error:',
        error,
      )

      setErrorMessage(
        'Unable to create this expense. Please check your connection and try again.',
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  if (isLoading) {
    return (
      <section className={styles.stateCard}>
        <div className={styles.stateIcon}>…</div>
        <h2>Loading expense form</h2>
        <p>
          Getting the group and member information.
        </p>
      </section>
    )
  }

  if (!group) {
    return (
      <section className={styles.stateCard}>
        <div className={styles.stateIcon}>!</div>

        <h2>Group unavailable</h2>

        <p>
          {errorMessage ||
            'This group does not exist or you cannot access it.'}
        </p>

        <Link
          to="/groups"
          className={styles.backLink}
        >
          ← Back to groups
        </Link>
      </section>
    )
  }

  return (
    <>
      <header className="topbar">
        <div>
          <Link
            to={`/groups/${group.id}`}
            className={styles.breadcrumb}
          >
            ← {group.name}
          </Link>

          <p className="eyebrow">NEW EXPENSE</p>

          <h2>Add an expense</h2>

          <p className="subtitle">
            Record a shared cost and choose exactly who
            should be included in the split.
          </p>
        </div>

        <div className={styles.splitBadge}>
          Equal split
        </div>
      </header>

      {successMessage && (
        <div className={styles.successMessage}>
          {successMessage}
        </div>
      )}

      {errorMessage && (
        <div className={styles.errorMessage}>
          {errorMessage}
        </div>
      )}

      <form
        className={styles.formGrid}
        onSubmit={handleSubmit}
      >
        <section className={styles.mainColumn}>
          <article className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <p className="eyebrow">
                  EXPENSE DETAILS
                </p>
                <h3>What was paid for?</h3>
              </div>
            </div>

            <div className={styles.fieldsGrid}>
              <label
                className={`${styles.field} ${styles.fullWidth}`}
              >
                <span>Description</span>

                <input
                  type="text"
                  value={description}
                  onChange={(event) =>
                    setDescription(event.target.value)
                  }
                  placeholder="e.g. Dinner, groceries, fuel"
                  maxLength={120}
                  disabled={isSubmitting}
                />
              </label>

              <label className={styles.field}>
                <span>Amount</span>

                <div className={styles.amountInput}>
                  <span>$</span>

                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) =>
                      setAmount(event.target.value)
                    }
                    placeholder="0.00"
                    disabled={isSubmitting}
                  />
                </div>
              </label>

              <label className={styles.field}>
                <span>Date</span>

                <input
                  type="date"
                  value={expenseDate}
                  onChange={(event) =>
                    setExpenseDate(event.target.value)
                  }
                  disabled={isSubmitting}
                />
              </label>

              <label
                className={`${styles.field} ${styles.fullWidth}`}
              >
                <span>Paid by</span>

                <select
                  value={paidBy}
                  onChange={(event) =>
                    setPaidBy(event.target.value)
                  }
                  disabled={isSubmitting}
                >
                  {members.map((member) => (
                    <option
                      key={member.userId}
                      value={member.userId}
                    >
                      {member.fullName}
                      {member.userId ===
                      session?.user.id
                        ? ' (You)'
                        : ''}
                    </option>
                  ))}
                </select>
              </label>

              <label
                className={`${styles.field} ${styles.fullWidth}`}
              >
                <span>
                  Notes{' '}
                  <small>Optional</small>
                </span>

                <textarea
                  value={notes}
                  onChange={(event) =>
                    setNotes(event.target.value)
                  }
                  placeholder="Add any extra details about this expense..."
                  maxLength={500}
                  rows={4}
                  disabled={isSubmitting}
                />

                <small className={styles.characterCount}>
                  {notes.length}/500
                </small>
              </label>
            </div>
          </article>

          <article className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <p className="eyebrow">
                  PARTICIPANTS
                </p>

                <h3>Who is this for?</h3>
              </div>

              <span className={styles.memberCount}>
                {participantIds.length}/
                {members.length}
              </span>
            </div>

            <div className={styles.participantActions}>
              <button
                type="button"
                onClick={selectEveryone}
                disabled={isSubmitting}
              >
                Select everyone
              </button>

              <button
                type="button"
                onClick={clearParticipants}
                disabled={isSubmitting}
              >
                Clear
              </button>
            </div>

            <div className={styles.participantList}>
              {members.map((member) => {
                const isSelected =
                  participantIds.includes(
                    member.userId,
                  )

                return (
                  <label
                    key={member.userId}
                    className={`${styles.participantRow} ${
                      isSelected
                        ? styles.participantSelected
                        : ''
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() =>
                        toggleParticipant(
                          member.userId,
                        )
                      }
                      disabled={isSubmitting}
                    />

                    <div
                      className={styles.memberAvatar}
                    >
                      {getInitials(
                        member.fullName,
                      )}
                    </div>

                    <div className={styles.memberInfo}>
                      <strong>
                        {member.fullName}
                      </strong>

                      <span>
                        {member.userId ===
                        session?.user.id
                          ? 'You'
                          : member.role === 'owner'
                            ? 'Group owner'
                            : 'Group member'}
                      </span>
                    </div>

                    <span
                      className={
                        isSelected
                          ? styles.selectedIndicator
                          : styles.unselectedIndicator
                      }
                    >
                      {isSelected ? '✓' : ''}
                    </span>
                  </label>
                )
              })}
            </div>
          </article>
        </section>

        <aside className={styles.sideColumn}>
          <article
            className={`${styles.panel} ${styles.previewPanel}`}
          >
            <div className={styles.panelHeader}>
              <div>
                <p className="eyebrow">
                  SPLIT PREVIEW
                </p>
                <h3>Equal split</h3>
              </div>
            </div>

            {splitPreview ? (
              <>
                <div className={styles.totalSummary}>
                  <span>Total expense</span>

                  <strong>
                    {formatCents(splitPreview.totalCents)}
                  </strong>

                  <p>
                    Shared between{' '}
                    {splitPreview.shares.length}{' '}
                    {splitPreview.shares.length === 1
                      ? 'person'
                      : 'people'}
                  </p>
                </div>

                <div className={styles.splitList}>
                  {splitPreview.shares.map((split) => (
                    <div
                      key={split.userId}
                      className={styles.splitRow}
                    >
                      <div>
                        <strong>
                          {split.fullName}
                        </strong>

                        {split.userId ===
                          session?.user.id && (
                          <span>You</span>
                        )}
                      </div>

                      <strong>
                        {formatCents(split.shareCents)}
                      </strong>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className={styles.emptyPreview}>
                <div>÷</div>

                <h4>Your split will appear here</h4>

                <p>
                  Enter an amount and select at least
                  one participant.
                </p>
              </div>
            )}
          </article>

          <article className={styles.summaryCard}>
            <div>
              <span>Paid by</span>

              <strong>
                {members.find(
                  (member) =>
                    member.userId === paidBy,
                )?.fullName || 'Not selected'}
              </strong>
            </div>

            <div>
              <span>Split method</span>
              <strong>Equally</strong>
            </div>

            <div>
              <span>Participants</span>
              <strong>
                {participantIds.length}
              </strong>
            </div>
          </article>

          <button
            type="submit"
            className="primary-button"
            disabled={
              isSubmitting ||
              members.length === 0
            }
          >
            {isSubmitting
              ? 'Creating expense...'
              : 'Create expense'}
          </button>

          <p className={styles.submitHint}>
            The expense and every participant split
            are saved together.
          </p>
        </aside>
      </form>
    </>
  )
}

export default AddExpensePage