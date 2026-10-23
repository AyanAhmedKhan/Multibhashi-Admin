import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, onUnauthenticated, setCsrfToken } from './api'

export interface Me {
  user: {
    id: number
    email: string
    name: string
    status: string
    mfaEnabled: boolean
    lastLoginAt: string | null
    recoveryCodesLeft: number
  }
  roles: { id: number; slug: string; name: string }[]
  permissions: string[]
  csrfToken: string
  session: { id: number; expiresAt: string; mfaAt: string | null }
  policy: {
    stepUpMinutes: number
    idleMinutes: number
    grantDirectLimit: number
    grantMax: number
    aiProMaxDays: number
    aiProMaxMinutes: number
    /** Second sign-in step in force: email code, authenticator app, or none. */
    mfaMethod: 'email' | 'totp' | 'off'
    codeSentTo: string
    mailConfigured: boolean
  }
  modules: { key: string; label: string; phase: number }[]
  pendingApprovals: number
}

interface AuthState {
  me: Me | null
  loading: boolean
  can: (...permissions: string[]) => boolean
  refresh: () => Promise<unknown>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [signedOut, setSignedOut] = useState(false)
  const loadedOnce = useRef(false)
  const query = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        // Only the first load counts as activity; the minute-by-minute refresh doesn't.
        const background = loadedOnce.current
        loadedOnce.current = true
        return await api.get<Me>('auth/me', undefined, { background })
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return null
        throw error
      }
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
  })

  const me = signedOut ? null : (query.data ?? null)
  useEffect(() => {
    if (me) setCsrfToken(me.csrfToken)
  }, [me])

  useEffect(() => {
    onUnauthenticated(() => {
      queryClient.setQueryData(['me'], null)
    })
  }, [queryClient])

  const can = useCallback(
    (...permissions: string[]) => !!me && permissions.every((p) => me.permissions.includes(p)),
    [me]
  )

  const value = useMemo<AuthState>(
    () => ({
      me,
      loading: query.isLoading,
      can,
      refresh: async () => {
        setSignedOut(false)
        return query.refetch()
      },
      signOut: async () => {
        try {
          await api.post('auth/logout')
        } finally {
          setSignedOut(true)
          queryClient.clear()
          queryClient.setQueryData(['me'], null)
        }
      },
    }),
    [me, query, can, queryClient]
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth outside AuthProvider')
  return ctx
}
