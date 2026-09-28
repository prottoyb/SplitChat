import { useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { getSession, loadProfile, onSessionChange } from './api/auth'
import { AuthContext, type Profile } from './authState'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  // The profile loaded for a user id; stale entries are ignored below.
  const [loaded, setLoaded] = useState<{ userId: string; profile: Profile | null } | null>(null)

  useEffect(() => {
    let isMounted = true

    void getSession().then((current) => {
      if (isMounted) {
        setSession(current)
        setIsLoading(false)
      }
    })

    const unsubscribe = onSessionChange((next) => {
      if (isMounted) {
        setSession(next)
        setIsLoading(false)
      }
    })

    return () => {
      isMounted = false
      unsubscribe()
    }
  }, [])

  const userId = session?.user.id ?? null

  useEffect(() => {
    if (!userId) return
    let isCancelled = false
    void loadProfile(userId).then((result) => {
      if (!isCancelled) setLoaded({ userId, profile: result.ok ? result.value : null })
    })
    return () => {
      isCancelled = true
    }
  }, [userId])

  const current = userId && loaded?.userId === userId ? loaded : null
  const value = {
    session,
    profile: current?.profile ?? null,
    isLoading,
    isProfileLoading: Boolean(userId) && current === null,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
