import { createContext } from 'react'
import type { Session } from '@supabase/supabase-js'

export type Profile = {
  id: string
  full_name: string
  avatar_url: string | null
  created_at: string
  updated_at: string
}

export type AuthContextValue = {
  session: Session | null
  profile: Profile | null
  isLoading: boolean
  isProfileLoading: boolean
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined)
