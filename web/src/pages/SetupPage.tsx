import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import { Check, Copy } from 'lucide-react'
import { api } from '../lib/api'
import { Button, ErrorNote, Field, Input, Spinner } from '../components/ui'
import { AuthCard } from './LoginPage'

interface SetupInfo {
  email: string
  name: string
  secret: string
  otpauthUri: string
  passwordMin: number
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
  const [copied, setCopied] = useState(false)

  if (info.isLoading) return <Spinner />
  if (info.error) {
    return (
      <AuthCard title="This link can’t be used">
        <ErrorNote error={info.error} />
        <p className="mt-4 text-sm text-ink-3">Ask the admin who invited you to send a new link.</p>
      </AuthCard>
    )
  }
  const data = info.data!

  if (codes) {
    return (
      <AuthCard title="Save your recovery codes" subtitle="Each code signs you in once if you lose your phone. They won’t be shown again.">
        <ul className="tabular grid grid-cols-2 gap-2 rounded-lg bg-surface-2 p-4 font-mono text-sm">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            onClick={() => {
              navigator.clipboard?.writeText(codes.join('\n'))
              setCopied(true)
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <label className="mt-4 flex items-start gap-2 text-sm text-ink-2">
          <input type="checkbox" className="mt-1" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          I stored them in my password manager (not in chat or email).
        </label>
        <Link to="/login" aria-disabled={!saved} className={saved ? '' : 'pointer-events-none opacity-50'}>
          <Button variant="primary" className="mt-4 w-full" disabled={!saved}>
            Go to sign in
          </Button>
        </Link>
      </AuthCard>
    )
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ recoveryCodes: string[] }>(`auth/setup/${token}`, { password, code })
      setCodes(res.recoveryCodes)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const mismatch = confirm.length > 0 && confirm !== password
  return (
    <AuthCard title={`Welcome, ${data.name}`} subtitle={`Set up ${data.email}. It takes two minutes.`}>
      <form onSubmit={submit} className="space-y-5">
        <div className="space-y-3">
          <div className="text-sm font-medium">1. Choose a password</div>
          <Field label="Password" hint={`At least ${data.passwordMin} characters. A short sentence is easy to remember and hard to guess.`}>
            {(id) => <Input id={id} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <Field label="Repeat it" error={mismatch ? 'The two passwords don’t match' : undefined}>
            {(id) => <Input id={id} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
          </Field>
        </div>
        <div className="space-y-3">
          <div className="text-sm font-medium">2. Add the console to your authenticator app</div>
          <p className="text-xs text-ink-3">Google Authenticator, Microsoft Authenticator or 1Password: scan the code, or type the key.</p>
          <div className="flex justify-center rounded-lg bg-white p-3">
            <QRCodeSVG value={data.otpauthUri} size={168} />
          </div>
          <code className="block break-all rounded-lg bg-surface-2 px-3 py-2 text-xs">{data.secret}</code>
          <Field label="Code shown in the app">
            {(id) => <Input id={id} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />}
          </Field>
        </div>
        <ErrorNote error={error} />
        <Button variant="primary" className="w-full" loading={busy} disabled={!password || mismatch || confirm !== password || code.trim().length < 6}>
          Finish setup
        </Button>
      </form>
    </AuthCard>
  )
}
