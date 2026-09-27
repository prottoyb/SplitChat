import {
  useEffect,
  useState,
  type FormEvent,
} from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/useAuth'
import { supabase } from '../../../shared/api/supabase'
import styles from './GroupsPage.module.css'

type Group = {
  id: string
  name: string
  description: string | null
  created_by: string
  created_at: string
  updated_at: string
}

function GroupsPage() {
  const { session } = useAuth()
  const userId = session?.user.id

  const [groups, setGroups] = useState<Group[]>([])
  const [ownedGroupIds, setOwnedGroupIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [showCreateForm, setShowCreateForm] = useState(false)

  const [errorMessage, setErrorMessage] = useState('')
  const [successMessage, setSuccessMessage] = useState('')

  const [reloadKey, setReloadKey] = useState(0)

  const reload = () => {
    setReloadKey((key) => key + 1)
  }

  useEffect(() => {
    let cancelled = false

    const loadGroups = async () => {
      setIsLoading(true)
      setErrorMessage('')

      const { data, error } = await supabase
        .from('groups')
        .select('id, name, description, created_by, created_at, updated_at')
        .order('created_at', { ascending: false })

      if (cancelled) {
        return
      }

      if (error) {
        console.error('Unable to load groups:', error)
        setErrorMessage('Unable to load your groups.')
        setGroups([])
        setIsLoading(false)
        return
      }

      // Ownership comes from the caller's membership role (M7), not from
      // groups.created_by, which only records who created the group.
      const { data: roleData, error: roleError } = userId
        ? await supabase
            .from('group_members')
            .select('group_id, role')
            .eq('user_id', userId)
        : { data: [], error: null }

      if (cancelled) {
        return
      }

      if (roleError) {
        console.error('Unable to load your group roles:', roleError)
      }

      setOwnedGroupIds(
        new Set(
          ((roleData ?? []) as { group_id: string; role: string }[])
            .filter((membership) => membership.role === 'owner')
            .map((membership) => membership.group_id),
        ),
      )
      setGroups(data ?? [])
      setIsLoading(false)
    }

    void loadGroups()

    return () => {
      cancelled = true
    }
  }, [reloadKey, userId])

  const resetForm = () => {
    setName('')
    setDescription('')
    setErrorMessage('')
  }

  const closeCreateForm = () => {
    resetForm()
    setShowCreateForm(false)
  }

  const handleCreateGroup = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault()

    setErrorMessage('')
    setSuccessMessage('')

    const cleanName = name.trim()
    const cleanDescription = description.trim()

    if (!userId) {
      setErrorMessage('Your session is unavailable. Please sign in again.')
      return
    }

    if (!cleanName) {
      setErrorMessage('Please enter a group name.')
      return
    }

    if (cleanName.length > 80) {
      setErrorMessage('Group names must be 80 characters or fewer.')
      return
    }

    if (cleanDescription.length > 300) {
      setErrorMessage('Descriptions must be 300 characters or fewer.')
      return
    }

    try {
      setIsCreating(true)

      const { error } = await supabase
        .from('groups')
        .insert({
          name: cleanName,
          description: cleanDescription || null,
          created_by: userId,
        })

      if (error) {
        throw error
      }

      reload()

      resetForm()
      setShowCreateForm(false)
      setSuccessMessage('Group created successfully.')
    } catch (error) {
      console.error('Unable to create group:', error)

      if (error instanceof Error) {
        setErrorMessage(error.message)
      } else {
        setErrorMessage('Unable to create the group.')
      }
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">GROUPS</p>
          <h2>Your groups</h2>
          <p className="subtitle">
            Organise shared expenses by trip, household, event or anything
            else you share with others.
          </p>
        </div>

        <button
          type="button"
          className="primary-button"
          onClick={() => {
            setErrorMessage('')
            setSuccessMessage('')
            setShowCreateForm(true)
          }}
        >
          + Create group
        </button>
      </header>

      {successMessage && (
        <div className={styles.successMessage}>
          {successMessage}
        </div>
      )}

      {errorMessage && !showCreateForm && (
        <div className={styles.errorMessage}>
          {errorMessage}
        </div>
      )}

      {showCreateForm && (
        <section className={styles.createPanel}>
          <div className={styles.createHeader}>
            <div>
              <p className="eyebrow">NEW GROUP</p>
              <h3>Create a group</h3>
              <p>
                Give the group a clear name and an optional description.
              </p>
            </div>

            <button
              type="button"
              className={styles.closeButton}
              onClick={closeCreateForm}
              disabled={isCreating}
              aria-label="Close create group form"
            >
              ×
            </button>
          </div>

          <form
            className={styles.createForm}
            onSubmit={handleCreateGroup}
          >
            <label className={styles.field}>
              <span>Group name</span>

              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Bali Trip 2026"
                maxLength={80}
                disabled={isCreating}
                autoFocus
              />

              <small>{name.length}/80</small>
            </label>

            <label className={styles.field}>
              <span>Description</span>

              <textarea
                value={description}
                onChange={(event) =>
                  setDescription(event.target.value)
                }
                placeholder="Optional — what is this group for?"
                maxLength={300}
                disabled={isCreating}
              />

              <small>{description.length}/300</small>
            </label>

            {errorMessage && (
              <div className={styles.errorMessage}>
                {errorMessage}
              </div>
            )}

            <div className={styles.formActions}>
              <button
                type="button"
                className="secondary-button"
                onClick={closeCreateForm}
                disabled={isCreating}
              >
                Cancel
              </button>

              <button
                type="submit"
                className="primary-button"
                disabled={isCreating}
              >
                {isCreating ? 'Creating...' : 'Create group'}
              </button>
            </div>
          </form>
        </section>
      )}

      <section className={styles.groupsSection}>
        {isLoading ? (
          <div className={styles.stateCard}>
            <div className={styles.stateIcon}>◎</div>
            <h3>Loading groups...</h3>
            <p>Getting your SplitChat groups.</p>
          </div>
        ) : groups.length === 0 ? (
          <div className={styles.stateCard}>
            <div className={styles.stateIcon}>◎</div>

            <h3>No groups yet</h3>

            <p>
              Create your first group to start organising shared expenses.
            </p>

            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setErrorMessage('')
                setSuccessMessage('')
                setShowCreateForm(true)
              }}
            >
              Create your first group
            </button>
          </div>
        ) : (
          <div className={styles.groupGrid}>
            {groups.map((group) => (
              <Link
                key={group.id}
                to={`/groups/${group.id}`}
                className={styles.groupCardLink}
              >
                <article className={styles.groupCard}>
                  <div className={styles.groupCardTop}>
                    <div className={styles.groupIcon}>◎</div>

                    <span className={styles.ownerBadge}>
                      {ownedGroupIds.has(group.id)
                        ? 'Owner'
                        : 'Member'}
                    </span>
                  </div>

                  <h3>{group.name}</h3>

                  <p>
                    {group.description ||
                      'No description has been added yet.'}
                  </p>

                  <div className={styles.groupMeta}>
                    Created{' '}
                    {new Intl.DateTimeFormat('en-AU', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    }).format(new Date(group.created_at))}
                  </div>
                </article>
              </Link>
            ))}
          </div>
        )}
      </section>
    </>
  )
}

export default GroupsPage