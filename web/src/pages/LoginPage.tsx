import { useState, type FormEvent, type ReactNode } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { ShieldCheck } from 'lucide-react'
import { api, setCsrfToken } from '../lib/api'
import { useAuth } from '../lib/auth'
import { Button, ErrorNote, Field, Input } from '../components/ui'

export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <div className="grid size-9 place-items-center rounded-lg bg-primary font-bold text-white dark:text-[#0b1220]">M</div>
          <div className="leading-tight">
            <div className="font-semibold">MultiBhashi</div>
            <div className="text-xs text-ink-3">Admin Console</div>
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm">
          <h1 className="text-lg font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-ink-3">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>
        <p className="mt-4 text-center text-xs text-ink-3">Staff only. Every action is recorded in the audit log.</p>
      </div>
    </div>
  )
}

export function LoginPage() {
  const { me, refresh } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [step, setStep] = useState<'password' | 'mfa'>('password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  if (me) return <Navigate to={(location.state as { from?: string })?.from ?? '/'} replace />

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ csrfToken: string }>('auth/login', { email, password })
      setCsrfToken(res.csrfToken)
      setPassword('')
      setStep('mfa')
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const submitCode = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('auth/mfa', { code })
      await refresh()
      navigate((location.state as { from?: string })?.from ?? '/', { replace: true })
    } catch (err) {
      setError(err)
      if ((err as { code?: string }).code === 'MFA_RESTART') {
        setStep('password')
        setCode('')
      }
    } finally {
      setBusy(false)
    }
  }

  if (step === 'mfa') {
    return (
      <AuthCard title="Two-step verification" subtitle="Enter the 6-digit code from your authenticator app. Lost your phone? Use one of your recovery codes.">
        <form onSubmit={submitCode} className="space-y-4">
          <Field label="Code">
            {(id) => (
              <Input id={id} inputMode="numeric" autoComplete="one-time-code" autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
            )}
          </Field>
          <ErrorNote error={error} />
          <Button variant="primary" className="w-full" loading={busy} disabled={code.trim().length < 6} icon={<ShieldCheck className="size-4" />}>
            Verify
          </Button>
          <button type="button" className="w-full text-center text-sm text-ink-3 hover:text-ink" onClick={() => setStep('password')}>
            Use a different account
          </button>
        </form>
      </AuthCard>
    )
  }

  return (
    <AuthCard title="Sign in" subtitle="Use your work email. New here? Ask a Super Admin for an invite link.">
      <form onSubmit={submitPassword} className="space-y-4">
        <Field label="Work email">
          {(id) => <Input id={id} type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field label="Password">
          {(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <ErrorNote error={error} />
        <Button variant="primary" className="w-full" loading={busy} disabled={!email || !password}>
          Continue
        </Button>
      </form>
    </AuthCard>
  )
}
