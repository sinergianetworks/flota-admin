import { createContext, useContext, useEffect, useState } from 'react'
import type { User, Session, AuthError } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { Profile } from '../types'

interface AuthState {
  user: User | null
  session: Session | null
  profile: Profile | null
  loading: boolean
  isAdmin: boolean
  signIn: (email: string, password: string) => Promise<AuthError | null>
  signOut: () => Promise<void>
  resetPassword: (email: string) => Promise<AuthError | null>
}

export const AuthContext = createContext<AuthState>({
  user: null,
  session: null,
  profile: null,
  loading: true,
  isAdmin: false,
  signIn: async () => null,
  signOut: async () => {},
  resetPassword: async () => null,
})

type SessionState = Pick<AuthState, 'user' | 'session' | 'profile' | 'loading'>

const SIGNED_OUT: SessionState = { user: null, session: null, profile: null, loading: false }

export function useAuthProvider(): AuthState {
  const [state, setState] = useState<SessionState>({ ...SIGNED_OUT, loading: true })

  useEffect(() => {
    async function loadProfile(session: Session) {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, email, full_name, phone, role, active, created_at')
        .eq('id', session.user.id)
        .single()

      if (error || !data) {
        setState(SIGNED_OUT)
        return
      }
      if (!data.active) {
        await supabase.auth.signOut()
        setState(SIGNED_OUT)
        return
      }
      setState({ user: session.user, session, profile: data as Profile, loading: false })
    }

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) loadProfile(session)
      else setState(SIGNED_OUT)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      // Se difiere para no llamar a Supabase dentro del callback (puede bloquearse).
      if (session?.user) setTimeout(() => loadProfile(session), 0)
      else setState(SIGNED_OUT)
    })

    return () => subscription.unsubscribe()
  }, [])

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return error
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  async function resetPassword(email: string) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/nueva-contrasena`,
    })
    return error
  }

  return { ...state, isAdmin: state.profile?.role === 'admin', signIn, signOut, resetPassword }
}

export function useAuth(): AuthState {
  return useContext(AuthContext)
}
