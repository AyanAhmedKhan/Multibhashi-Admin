import { useState, type FormEvent, type ReactNode } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, BarChart3, KeyRound, ScrollText, ShieldCheck } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api, setCsrfToken } from '../lib/api'
import { useAuth } from '../lib/auth'
import { Button, ErrorNote, Field, Input } from '../components/ui'
import { CodeInput, codeReady } from '../components/code-input'
import { ResendCode } from '../components/resend-code'

const POINTS: [ReactNode, string, string][] = [
  [<BarChart3 />, 'One console for every team', 'AI tutor, learners, insights and cost, with CRM, bookings and trainers next.'],
  [<ShieldCheck />, 'Two-step sign-in for everyone', 'A password plus a one-time code, every time.'],
  [<KeyRound />, 'Only what your role needs', 'Permissions are checked on every request, and big changes need a second approver.'],
  [<ScrollText />, 'Every action is recorded', 'Who, when, from where and why, in a tamper-evident audit log.'],
]

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-h-full lg:grid-cols-[1.1fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-primary p-10 text-primary-foreground lg:flex lg:flex-col">
        <div className="absolute -top-24 -right-24 size-96 rounded-full bg-white/10 blur-3xl" aria-hidden />
        <div className="absolute -bottom-32 -left-16 size-96 rounded-full bg-black/10 blur-3xl" aria-hidden />
        <div className="relative flex items-center gap-3">
          {/* the blue mark sits on a white tile: the panel behind it is the brand blue */}
          <div className="grid size-10 place-items-center rounded-xl bg-white p-1 shadow-sm">
            <img src="/brand/multibhashi-mark.png" alt="" className="size-full object-contain" />
          </div>
          <div className="leading-tight">
            <div className="font-semibold">Multibhashi</div>
            <div className="text-sm opacity-80">Admin Console</div>
          </div>
        </div>
        <div className="relative mt-auto max-w-md space-y-6">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">Run MultiBhashi with confidence.</h2>
          <ul className="space-y-4">
            {POINTS.map(([icon, head, body]) => (
              <li key={head} className="flex gap-3">
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-white/15 [&_svg]:size-4">{icon}</span>
                <span>
                  <span className="block font-medium">{head}</span>
                  <span className="block text-sm opacity-80">{body}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative mt-10 text-xs opacity-70">Staff only. Every action is recorded in the audit log.</p>
      </aside>
      <main className="flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex items-center gap-2 lg:hidden">
            <img src="/brand/multibhashi-mark.png" alt="" className="size-9 object-contain" />
            <div className="leading-tight">
              <div className="font-semibold">Multibhashi</div>
              <div className="text-xs text-muted-foreground">Admin Console</div>
            </div>
          </div>
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle className="text-xl">{title}</CardTitle>
              {subtitle && <CardDescription>{subtitle}</CardDescription>}
            </CardHeader>
            <CardContent>{children}</CardContent>
          </Card>
        </div>
      </main>
    </div>
  )
}

export function LoginPage() {
  const { me, refresh } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [step, setStep] = useState<'password' | 'mfa'>('password')
  const [method, setMethod] = useState<'email' | 'totp'>('totp')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const target = (location.state as { from?: string })?.from ?? '/'

  if (me) return <Navigate to={target} replace />

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ csrfToken: string; next: 'mfa' | 'app'; method: 'email' | 'totp' | 'off'; sentTo: string | null }>('auth/login', { email, password })
      setCsrfToken(res.csrfToken)
      setPassword('')
      if (res.next === 'app') {
        // Password-only sign-in (Security policy): already in.
        await refresh()
        navigate(target, { replace: true })
        return
      }
      setMethod(res.method === 'email' ? 'email' : 'totp')
      setSentTo(res.sentTo)
      setCode('')
      setStep('mfa')
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const submitCode = async (value = code) => {
    if (!codeReady(value) || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.post('auth/mfa', { code: value })
      await refresh()
      navigate(target, { replace: true })
    } catch (err) {
      setError(err)
      setCode('')
      if ((err as { code?: string }).code === 'MFA_RESTART') setStep('password')
    } finally {
      setBusy(false)
    }
  }

  if (step === 'mfa') {
    return (
      <AuthLayout
        title={method === 'email' ? 'Check your email' : 'Two-step verification'}
        subtitle={
          method === 'email' ? (
            <>
              We sent a 6-digit code to <b className="text-foreground">{sentTo}</b>. It works once, for 10 minutes.
            </>
          ) : (
            'Enter the 6-digit code from your authenticator app.'
          )
        }
      >
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault()
            submitCode()
          }}
        >
          <CodeInput value={code} onChange={setCode} onComplete={(v) => submitCode(v)} allowRecovery={method === 'totp'} />
          {method === 'email' && <ResendCode onResend={() => api.post<{ sentTo: string }>('auth/mfa/resend')} />}
          <ErrorNote error={error} />
          <Button variant="primary" className="w-full" loading={busy} disabled={!codeReady(code)} icon={<ShieldCheck />}>
            Verify
          </Button>
          <button type="button" className="flex w-full items-center justify-center gap-1 text-sm text-muted-foreground hover:text-foreground" onClick={() => setStep('password')}>
            <ArrowLeft className="size-3.5" /> Use a different account
          </button>
        </form>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout title="Sign in" subtitle="Use your work email. New here? Ask a Super Admin for an invite link.">
      <form onSubmit={submitPassword} className="space-y-4">
        <Field label="Work email">
          {(id) => <Input id={id} type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@multibhashi.com" />}
        </Field>
        <Field label="Password">
          {(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <ErrorNote error={error} />
        <Button variant="primary" className="w-full" loading={busy} disabled={!email || !password}>
          Continue
        </Button>
        <p className="text-center text-xs text-muted-foreground">Forgot your password or lost your phone? Ask an admin to reset your access.</p>
      </form>
    </AuthLayout>
  )
}
