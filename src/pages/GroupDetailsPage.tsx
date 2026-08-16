import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from 'react'
import {
  Link,
  useNavigate,
  useParams,
} from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { supabase } from '../lib/supabase'
import styles from './GroupDetailsPage.module.css'

type Group = {
  id: string
  name: string
  description: string | null
  created_by: string
  created_at: string
  updated_at: string
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
  joinedAt: string
}

function GroupDetailsPage() {
  const navigate = useNavigate()
  const { groupId } = useParams<{ groupId: string }>()
  const { session } = useAuth()

  const [group, setGroup] = useState<Group | null>(null)
  const [members, setMembers] = useState<DisplayMember[]>([])

  const [memberEmail, setMemberEmail] = useState('')

  const [isLoading, setIsLoading] = useState(true)
  const [isAddingMember, setIsAddingMember] = useState(false)
  const [isRemovingMember, setIsRemovingMember] =
    useState(false)
  const [isLeavingGroup, setIsLeavingGroup] =
    useState(false)

  const [pendingRemovalUserId, setPendingRemovalUserId] =
    useState<string | null>(null)

  const [showLeaveConfirm, setShowLeaveConfirm] =
    useState(false)

  const [errorMessage, setErrorMessage] = useState('')
  const [successMessage, setSuccessMessage] = useState('')

  const loadGroup = useCallback(async () => {
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
        .select(
          'id, name, description, created_by, created_at, updated_at',
        )
        .eq('id', groupId)
        .limit(1)

    if (groupError) {
      console.error('Unable to load group:', groupError)
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

    if (membershipError) {
      console.error(
        'Unable to load group members:',
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
      const {
        data: profileData,
        error: profileError,
      } = await supabase
        .from('profiles')
        .select('id, full_name, avatar_url')
        .in('id', memberIds)

      if (profileError) {
        console.error(
          'Unable to load member profiles:',
          profileError,
        )

        setGroup(loadedGroup)
        setMembers([])
        setErrorMessage('Unable to load member profiles.')
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
          joinedAt: membership.joined_at,
        }
      })

    setGroup(loadedGroup)
    setMembers(displayMembers)
    setIsLoading(false)
  }, [groupId])

  useEffect(() => {
    void loadGroup()
  }, [loadGroup])

  const handleAddMember = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault()

    setErrorMessage('')
    setSuccessMessage('')

    const cleanEmail =
      memberEmail.trim().toLowerCase()

    if (!groupId) {
      setErrorMessage('Group ID is unavailable.')
      return
    }

    if (!cleanEmail) {
      setErrorMessage(
        'Please enter the member email address.',
      )
      return
    }

    try {
      setIsAddingMember(true)

      const { error } = await supabase.rpc(
        'add_group_member_by_email',
        {
          target_group_id: groupId,
          target_email: cleanEmail,
        },
      )

      if (error) {
        console.error(
          'Unable to add member:',
          error,
        )
        setErrorMessage(error.message)
        return
      }

      setMemberEmail('')

      await loadGroup()

      setSuccessMessage(
        'Member added successfully. They can now access this group.',
      )
    } catch (error) {
      console.error(
        'Unexpected add member error:',
        error,
      )

      if (
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof error.message === 'string'
      ) {
        setErrorMessage(error.message)
      } else {
        setErrorMessage(
          'Unable to add this member.',
        )
      }
    } finally {
      setIsAddingMember(false)
    }
  }

  const handleRemoveMember = async (
    member: DisplayMember,
  ) => {
    setErrorMessage('')
    setSuccessMessage('')

    if (!groupId) {
      setErrorMessage('Group ID is unavailable.')
      return
    }

    if (
      group?.created_by !== session?.user.id
    ) {
      setErrorMessage(
        'Only the group owner can remove members.',
      )
      return
    }

    if (member.role === 'owner') {
      setErrorMessage(
        'The group owner cannot be removed.',
      )
      return
    }

    try {
      setIsRemovingMember(true)

      const { error } = await supabase
        .from('group_members')
        .delete()
        .eq('group_id', groupId)
        .eq('user_id', member.userId)

      if (error) {
        console.error(
          'Unable to remove member:',
          error,
        )
        setErrorMessage(error.message)
        return
      }

      setPendingRemovalUserId(null)

      await loadGroup()

      setSuccessMessage(
        `${member.fullName} was removed from the group.`,
      )
    } catch (error) {
      console.error(
        'Unexpected remove member error:',
        error,
      )

      if (
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof error.message === 'string'
      ) {
        setErrorMessage(error.message)
      } else {
        setErrorMessage(
          'Unable to remove this member.',
        )
      }
    } finally {
      setIsRemovingMember(false)
    }
  }

  const handleLeaveGroup = async () => {
    setErrorMessage('')
    setSuccessMessage('')

    const userId = session?.user.id

    if (!groupId || !userId) {
      setErrorMessage(
        'Your group or session information is unavailable.',
      )
      return
    }

    if (group?.created_by === userId) {
      setErrorMessage(
        'The group owner cannot leave the group.',
      )
      return
    }

    try {
      setIsLeavingGroup(true)

      const { error } = await supabase
        .from('group_members')
        .delete()
        .eq('group_id', groupId)
        .eq('user_id', userId)

      if (error) {
        console.error(
          'Unable to leave group:',
          error,
        )
        setErrorMessage(error.message)
        return
      }

      navigate('/groups', {
        replace: true,
      })
    } catch (error) {
      console.error(
        'Unexpected leave group error:',
        error,
      )

      if (
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof error.message === 'string'
      ) {
        setErrorMessage(error.message)
      } else {
        setErrorMessage(
          'Unable to leave this group.',
        )
      }
    } finally {
      setIsLeavingGroup(false)
    }
  }

  if (isLoading) {
    return (
      <section className={styles.stateCard}>
        <div className={styles.stateIcon}>◎</div>
        <h2>Loading group...</h2>
        <p>Getting the latest group information.</p>
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

  const isOwner =
    group.created_by === session?.user.id

  return (
    <>
      <header className="topbar">
        <div>
          <Link
            to="/groups"
            className={styles.breadcrumb}
          >
            ← Groups
          </Link>

          <p className="eyebrow">
            GROUP DETAILS
          </p>

          <h2>{group.name}</h2>

          <p className="subtitle">
            {group.description ||
              'No description has been added to this group.'}
          </p>
        </div>

        <div className={styles.groupRole}>
          {isOwner ? 'Owner' : 'Member'}
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

      <section className={styles.overviewGrid}>
        <article className={styles.statCard}>
          <span>Members</span>
          <strong>{members.length}</strong>
          <p>
            People currently sharing this group
          </p>
        </article>

        <article className={styles.statCard}>
          <span>Your role</span>
          <strong>
            {isOwner ? 'Owner' : 'Member'}
          </strong>

          <p>
            {isOwner
              ? 'You manage this group'
              : 'You are part of this group'}
          </p>
        </article>

        <article className={styles.statCard}>
          <span>Created</span>

          <strong>
            {new Intl.DateTimeFormat('en-AU', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            }).format(
              new Date(group.created_at),
            )}
          </strong>

          <p>Group creation date</p>
        </article>
      </section>

      <section className={styles.contentGrid}>
        <article className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <p className="eyebrow">
                MEMBERS
              </p>
              <h3>Group members</h3>
            </div>

            <span className={styles.memberCount}>
              {members.length}
            </span>
          </div>

          <div className={styles.memberList}>
            {members.map((member) => {
              const initials =
                member.fullName
                  .split(/\s+/)
                  .filter(Boolean)
                  .slice(0, 2)
                  .map((part) =>
                    part
                      .charAt(0)
                      .toUpperCase(),
                  )
                  .join('') || 'SC'

              const isConfirmingRemoval =
                pendingRemovalUserId ===
                member.userId

              return (
                <div
                  key={member.userId}
                  className={styles.memberRow}
                >
                  <div
                    className={
                      styles.memberAvatar
                    }
                  >
                    {initials}
                  </div>

                  <div
                    className={
                      styles.memberInfo
                    }
                  >
                    <strong>
                      {member.fullName}
                    </strong>

                    <span>
                      Joined{' '}
                      {new Intl.DateTimeFormat(
                        'en-AU',
                        {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        },
                      ).format(
                        new Date(
                          member.joinedAt,
                        ),
                      )}
                    </span>
                  </div>

                  <div
                    className={
                      styles.memberControls
                    }
                  >
                    <span
                      className={
                        member.role ===
                        'owner'
                          ? styles.ownerBadge
                          : styles.memberBadge
                      }
                    >
                      {member.role}
                    </span>

                    {isOwner &&
                      member.role !==
                        'owner' && (
                        <>
                          {isConfirmingRemoval ? (
                            <div
                              className={
                                styles.confirmActions
                              }
                            >
                              <button
                                type="button"
                                className={
                                  styles.confirmRemoveButton
                                }
                                onClick={() =>
                                  void handleRemoveMember(
                                    member,
                                  )
                                }
                                disabled={
                                  isRemovingMember
                                }
                              >
                                {isRemovingMember
                                  ? 'Removing...'
                                  : 'Confirm'}
                              </button>

                              <button
                                type="button"
                                className={
                                  styles.cancelActionButton
                                }
                                onClick={() =>
                                  setPendingRemovalUserId(
                                    null,
                                  )
                                }
                                disabled={
                                  isRemovingMember
                                }
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className={
                                styles.removeButton
                              }
                              onClick={() => {
                                setErrorMessage(
                                  '',
                                )
                                setSuccessMessage(
                                  '',
                                )
                                setPendingRemovalUserId(
                                  member.userId,
                                )
                              }}
                            >
                              Remove
                            </button>
                          )}
                        </>
                      )}
                  </div>
                </div>
              )
            })}
          </div>
        </article>

        <article className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <p className="eyebrow">
                {isOwner
                  ? 'ADD MEMBER'
                  : 'MEMBERSHIP'}
              </p>

              <h3>
                {isOwner
                  ? 'Add someone'
                  : 'Group access'}
              </h3>
            </div>
          </div>

          {isOwner ? (
            <>
              <p
                className={
                  styles.panelDescription
                }
              >
                Add an existing SplitChat user
                using the email address
                connected to their account.
              </p>

              <form
                className={
                  styles.addMemberForm
                }
                onSubmit={handleAddMember}
              >
                <label
                  className={styles.field}
                >
                  <span>
                    Email address
                  </span>

                  <input
                    type="email"
                    value={memberEmail}
                    onChange={(event) =>
                      setMemberEmail(
                        event.target.value,
                      )
                    }
                    placeholder="member@example.com"
                    autoComplete="email"
                    disabled={
                      isAddingMember
                    }
                  />
                </label>

                <button
                  type="submit"
                  className="primary-button"
                  disabled={
                    isAddingMember
                  }
                >
                  {isAddingMember
                    ? 'Adding member...'
                    : '+ Add member'}
                </button>
              </form>

              <div
                className={styles.infoBox}
              >
                <strong>
                  Existing accounts only
                </strong>

                <p>
                  For this version, the
                  person must already have a
                  SplitChat account. Email
                  invitations will be added
                  later.
                </p>
              </div>
            </>
          ) : (
            <>
              <div
                className={
                  styles.memberNotice
                }
              >
                <div
                  className={
                    styles.stateIcon
                  }
                >
                  ✓
                </div>

                <h4>
                  You are a member of this
                  group
                </h4>

                <p>
                  You can view this group and
                  participate in its shared
                  activity.
                </p>
              </div>

              <div
                className={
                  styles.leaveSection
                }
              >
                {!showLeaveConfirm ? (
                  <button
                    type="button"
                    className={
                      styles.leaveButton
                    }
                    onClick={() => {
                      setErrorMessage('')
                      setSuccessMessage('')
                      setShowLeaveConfirm(
                        true,
                      )
                    }}
                  >
                    Leave group
                  </button>
                ) : (
                  <div
                    className={
                      styles.leaveConfirmation
                    }
                  >
                    <strong>
                      Leave this group?
                    </strong>

                    <p>
                      You will lose access to
                      this group and its
                      shared information.
                    </p>

                    <div
                      className={
                        styles.leaveActions
                      }
                    >
                      <button
                        type="button"
                        className={
                          styles.confirmLeaveButton
                        }
                        onClick={() =>
                          void handleLeaveGroup()
                        }
                        disabled={
                          isLeavingGroup
                        }
                      >
                        {isLeavingGroup
                          ? 'Leaving...'
                          : 'Yes, leave'}
                      </button>

                      <button
                        type="button"
                        className={
                          styles.cancelActionButton
                        }
                        onClick={() =>
                          setShowLeaveConfirm(
                            false,
                          )
                        }
                        disabled={
                          isLeavingGroup
                        }
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </article>
      </section>
    </>
  )
}

export default GroupDetailsPage