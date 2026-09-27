import {
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { AuthContext, type Profile } from './authState'

type AuthProviderProps = {
  children: ReactNode
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)

  const [isLoading, setIsLoading] = useState(true)
  const [isProfileLoading, setIsProfileLoading] = useState(false)

  useEffect(() => {
    let isMounted = true

    const loadSession = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (isMounted) {
        setSession(session)
        setIsLoading(false)
      }
    }

    void loadSession()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (isMounted) {
        setSession(session)
        setIsLoading(false)
      }
    })

    return () => {
      isMounted = false
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    let isCancelled = false

    const loadProfile = async () => {
      const userId = session?.user.id

      if (!userId) {
        setProfile(null)
        setIsProfileLoading(false)
        return
      }

      setIsProfileLoading(true)

      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, avatar_url, created_at, updated_at')
        .eq('id', userId)
        .single()

      if (isCancelled) {
        return
      }

      if (error) {
        console.error('Unable to load profile:', error)
        setProfile(null)
        setIsProfileLoading(false)
        return
      }

      setProfile(data)
      setIsProfileLoading(false)
    }

    void loadProfile()

    return () => {
      isCancelled = true
    }
  }, [session?.user.id])

  return (
    <AuthContext.Provider
      value={{
        session,
        profile,
        isLoading,
        isProfileLoading,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}
