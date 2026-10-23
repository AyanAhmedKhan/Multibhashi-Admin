import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { useReason } from '../../components/dialogs'
import { Button, Card, ErrorNote, Field, Input, PageHeader, Spinner, Textarea } from '../../components/ui'

type Settings = Record<string, number | string[]>

const FIELDS: { key: string; label: string; hint: string; group: string }[] = [
  { key: 'session_idle_minutes', label: 'Sign out after inactivity (minutes)', hint: '5–240. Auto-refreshing pages don’t count as activity.', group: 'Sessions' },
  { key: 'session_absolute_hours', label: 'Maximum session length (hours)', hint: '1–24. After this everyone signs in again.', group: 'Sessions' },
  { key: 'step_up_minutes', label: 'Re-ask for the authenticator code after (minutes)', hint: 'For critical actions: money, access, personal data.', group: 'Sessions' },
  { key: 'login_max_failures', label: 'Lock an account after this many wrong attempts', hint: '3–20', group: 'Sign-in' },
  { key: 'lockout_minutes', label: 'Lock for (minutes)', hint: '1–1440', group: 'Sign-in' },
  { key: 'grant_minutes_direct_limit', label: 'Minutes grant without approval (per grant)', hint: 'Above this a second person approves.', group: 'Approvals' },
  { key: 'grant_minutes_max', label: 'Largest minutes change allowed', hint: 'Hard cap per grant or removal.', group: 'Approvals' },
  { key: 'ai_pro_direct_max_days', label: 'AI Pro without approval: max days', hint: 'Longer complimentary plans need approval.', group: 'Approvals' },
  { key: 'ai_pro_direct_max_minutes', label: 'AI Pro without approval: max minutes', hint: 'Bigger grants need approval.', group: 'Approvals' },
]

export function SecurityPage() {
  const { can, refresh } = useAuth()
  const ask = useReason()
  const queryClient = useQueryClient()
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('settings') })
  const [draft, setDraft] = useState<Settings>({})
  const [allowlist, setAllowlist] = useState('')
  const manage = can('console.settings.manage')

  useEffect(() => {
    if (settings.data) {
      setDraft(settings.data)
      setAllowlist((settings.data.ip_allowlist as string[]).join('\n'))
    }
  }, [settings.data])

  if (settings.isLoading) return <Spinner />
  if (settings.error || !settings.data) return <ErrorNote error={settings.error} />

  const changes: Settings = {}
  for (const f of FIELDS) if (Number(draft[f.key]) !== settings.data[f.key]) changes[f.key] = Number(draft[f.key])
  const list = allowlist.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
  if (list.join() !== (settings.data.ip_allowlist as string[]).join()) changes.ip_allowlist = list

  const save = () =>
    ask({
      title: 'Change security policy',
      description: `${Object.keys(changes).length} setting(s) change for every staff member. Old and new values are audited.`,
      confirmLabel: 'Save policy',
      run: async (reason) => {
        await api.put('settings', { changes, reason })
        await queryClient.invalidateQueries({ queryKey: ['settings'] })
        await refresh()
      },
    })

  return (
    <>
      <PageHeader
        title="Security policy"
        subtitle={manage ? 'Applies to everyone at once. Changes are audited.' : 'Read-only: only Super Admins change the policy.'}
        actions={manage && Object.keys(changes).length > 0 && <Button variant="primary" onClick={save}>Save changes</Button>}
      />
      <div className="grid gap-6 lg:grid-cols-2">
        {['Sessions', 'Sign-in', 'Approvals'].map((group) => (
          <Card key={group} title={group}>
            <div className="space-y-4">
              {FIELDS.filter((f) => f.group === group).map((f) => (
                <Field key={f.key} label={f.label} hint={f.hint}>
                  {(id) => (
                    <Input id={id} type="number" disabled={!manage} value={String(draft[f.key] ?? '')} onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })} />
                  )}
                </Field>
              ))}
            </div>
          </Card>
        ))}
        <Card title="Network">
          <Field label="Allow sign-in only from these IPs / ranges" hint="One per line, e.g. 203.0.113.0/24 (office) or a VPN exit IP. Empty = any network (MFA still required).">
            {(id) => <Textarea id={id} disabled={!manage} className="font-mono" value={allowlist} onChange={(e) => setAllowlist(e.target.value)} />}
          </Field>
        </Card>
        <Card title="Always on (not configurable)" className="lg:col-span-2">
          <ul className="grid gap-2 text-sm text-ink-2 sm:grid-cols-2">
            <li>• Two-step verification (TOTP) for every account, with single-use recovery codes</li>
            <li>• Passwords: 12+ characters, common and personal ones refused, hashed with scrypt</li>
            <li>• Server-side sessions, revocable at once; token rotated after sign-in</li>
            <li>• Cookies: HttpOnly, SameSite=Strict, Secure in production</li>
            <li>• CSRF: same-origin check + per-session token on every change</li>
            <li>• Every API route checks permissions on the server</li>
            <li>• Reasons on every write and sensitive read; hash-chained audit log</li>
            <li>• Four-eyes approval for big grants, comps and new Super Admins</li>
            <li>• No one can change their own roles or grant what they don’t hold</li>
            <li>• At least one active Super Admin, always</li>
          </ul>
        </Card>
      </div>
    </>
  )
}
