import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import { Check, Copy, Download } from 'lucide-react'
import { toast } from 'sonner'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import { api } from '../lib/api'
import { Button, ErrorNote, Field, Input, Spinner } from '../components/ui'
import { CodeInput } from '../components/code-input'
import { AuthLayout } from './LoginPage'

interface SetupInfo {
  email: string
  name: string
  secret: string | null
  otpauthUri: string | null
  passwordMin: number
  mfaMethod: 'email' | 'totp' | 'off'
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <span className="grid size-6 place-items-center rounded-full bg-primary text-xs text-primary-foreground">{n}</span>
        {title}
      </div>
      {children}
    </section>
  )
}

/** Accept an invite (or an access reset): choose a password, add the authenticator, save recovery codes. */
export function SetupPage() {
  const { token = '' } = useParams()
  const info = useQuery({ queryKey: ['setup', token], queryFn: () => api.get<SetupInfo>(`auth/setup/${token}`), retry: false })
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [saved, setSaved] = useState(false)

  if (info.isLoading) return <Spinner />
  if (info.error) {
    return (
      <AuthLayout title="This link can’t be used">
        <ErrorNote error={info.error} />
        <p className="mt-4 text-sm text-muted-foreground">Ask the admin who invited you to send a new link.</p>
      </AuthLayout>
    )
  }
  const data = info.data!

  if (codes) {
    const text = codes.join('\n')
    return (
      <AuthLayout title="Save your recovery codes" subtitle="Each code signs you in once if you lose your phone. They won’t be shown again.">
        <ul className="tabular grid grid-cols-2 gap-2 rounded-lg bg-muted p-4 font-mono text-sm">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            icon={<Copy />}
            onClick={() => {
              navigator.clipboard?.writeText(text)
              toast.success('Recovery codes copied')
            }}
          >
            Copy
          </Button>
          <Button
            size="sm"
            icon={<Download />}
            onClick={() => {
              const url = URL.createObjectURL(new Blob([`MultiBhashi Console recovery codes for ${data.email}\n\n${text}\n`], { type: 'text/plain' }))
              const a = document.createElement('a')
              a.href = url
              a.download = 'multibhashi-console-recovery-codes.txt'
              a.click()
              URL.revokeObjectURL(url)
            }}
          >
            Download
          </Button>
        </div>
        <label className="mt-5 flex items-start gap-2 text-sm text-ink-2">
          <Checkbox className="mt-0.5" checked={saved} onCheckedChange={(v) => setSaved(!!v)} />
          I stored them in my password manager (not in chat or email).
        </label>
        <Button variant="primary" className="mt-4 w-full" disabled={!saved} icon={<Check />} onClick={() => (window.location.href = '/login')}>
          Go to sign in
        </Button>
      </AuthLayout>
    )
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ recoveryCodes: string[] }>(`auth/setup/${token}`, { password, ...(totp ? { code } : {}) })
      if (res.recoveryCodes.length) setCodes(res.recoveryCodes)
      else {
        toast.success('Your account is ready. Sign in with your email and password.')
        window.location.href = '/login'
      }
    } catch (err) {
      setError(err)
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  const totp = data.mfaMethod === 'totp'
  const strength = Math.min(100, Math.round((password.length / Math.max(data.passwordMin, 1)) * 70 + (new Set(password).size > 8 ? 30 : 0)))
  const mismatch = confirm.length > 0 && confirm !== password
  return (
    <AuthLayout title={`Welcome, ${data.name.split(/\s+/)[0]}`} subtitle={`Set up ${data.email}. It takes two minutes.`}>
      <form onSubmit={submit} className="space-y-6">
        <Step n={1} title="Choose a password">
          <Field label="Password" hint={`At least ${data.passwordMin} characters. A short sentence is easy to remember and hard to guess.`}>
            {(id) => <Input id={id} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          {password && <Progress value={strength} className="h-1.5" aria-label="Password length" />}
          <Field label="Repeat it" error={mismatch ? 'The two passwords don’t match' : undefined}>
            {(id) => <Input id={id} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
          </Field>
        </Step>
        {totp && data.otpauthUri && (
        <>
        <Step n={2} title="Add the console to your authenticator app">
          <p className="text-xs text-muted-foreground">Google Authenticator, Microsoft Authenticator or 1Password: scan the code, or type the key.</p>
          <div className="flex justify-center rounded-xl border bg-white p-3">
            <QRCodeSVG value={data.otpauthUri} size={164} />
          </div>
          <code className="block break-all rounded-lg bg-muted px-3 py-2 text-center text-xs tracking-wider">{data.secret}</code>
        </Step>
        <Step n={3} title="Enter the code the app shows">
          <CodeInput value={code} onChange={setCode} allowRecovery={false} autoFocus={false} />
        </Step>
        </>
        )}
        {data.mfaMethod === 'email' && (
          <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
            Each time you sign in, we’ll email a 6-digit code to <b className="text-foreground">{data.email}</b>.
          </p>
        )}
        <ErrorNote error={error} />
        <Button variant="primary" className="w-full" loading={busy} disabled={!password || mismatch || confirm !== password || (totp && code.length < 6)}>
          Finish setup
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          Already set up? <Link className="text-primary hover:underline" to="/login">Sign in</Link>
        </p>
      </form>
    </AuthLayout>
  )
}
