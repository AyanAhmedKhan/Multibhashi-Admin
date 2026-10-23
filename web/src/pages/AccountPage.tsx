import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { fmtAgo, fmtDateTime } from '../lib/format'
import { Badge, Button, Card, ErrorNote, Field, Input, KeyValue, PageHeader, Table, Td } from '../components/ui'

interface SessionRow {
  id: number
  ip: string | null
  userAgent: string | null
  createdAt: string
  lastSeenAt: string | null
  current: boolean
}

export function AccountPage() {
  const { me } = useAuth()
  const queryClient = useQueryClient()
  const sessions = useQuery({ queryKey: ['my-sessions'], queryFn: () => api.get<SessionRow[]>('auth/sessions') })
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)

  const changePassword = useMutation({
    mutationFn: () => api.post('auth/password', { current, password: next }),
    onSuccess: () => {
      setCurrent('')
      setNext('')
      queryClient.invalidateQueries({ queryKey: ['my-sessions'] })
    },
  })
  const revokeOthers = useMutation({
    mutationFn: () => api.post('auth/sessions/revoke-others'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['my-sessions'] }),
  })
  const newCodes = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>('auth/recovery-codes'),
    onSuccess: (res) => {
      setCodes(res.recoveryCodes)
      queryClient.invalidateQueries({ queryKey: ['me'] })
    },
  })

  if (!me) return null
  return (
    <>
      <PageHeader title="My account" subtitle="Your sign-in, two-step verification and active sessions." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Profile">
          <KeyValue
            items={[
              ['Name', me.user.name],
              ['Email', me.user.email],
              ['Roles', <div className="flex flex-wrap gap-1">{me.roles.map((r) => <Badge key={r.id} tone="blue">{r.name}</Badge>)}</div>],
              ['Permissions', `${me.permissions.length} granted`],
              ['Last sign-in', fmtDateTime(me.user.lastLoginAt)],
              ['Two-step verification', <Badge tone="green">On</Badge>],
            ]}
          />
        </Card>

        <Card title="Change password">
          <div className="space-y-3">
            <Field label="Current password">
              {(id) => <Input id={id} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
            </Field>
            <Field label="New password" hint="At least 12 characters. Other sessions are signed out when it changes.">
              {(id) => <Input id={id} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}
            </Field>
            <ErrorNote error={changePassword.error} />
            {changePassword.isSuccess && <p className="text-sm text-success">Password changed.</p>}
            <Button variant="primary" loading={changePassword.isPending} disabled={!current || next.length < 12} onClick={() => changePassword.mutate()}>
              Change password
            </Button>
          </div>
        </Card>

        <Card title="Recovery codes" className="lg:col-span-2">
          <p className="text-sm text-ink-2">
            {me.user.recoveryCodesLeft} of 10 unused. New codes replace the old ones (you will be asked for an authenticator code).
          </p>
          {codes && (
            <ul className="tabular mt-3 grid grid-cols-2 gap-2 rounded-lg bg-surface-2 p-4 font-mono text-sm sm:grid-cols-5">
              {codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
          <ErrorNote error={newCodes.error} />
          <Button className="mt-3" loading={newCodes.isPending} onClick={() => newCodes.mutate()}>
            Generate new codes
          </Button>
        </Card>

        <Card
          title="Where you’re signed in"
          className="lg:col-span-2"
          padded={false}
          actions={
            <Button size="sm" loading={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>
              Sign out other sessions
            </Button>
          }
        >
          <Table head={['Device', 'IP', 'Signed in', 'Last active', '']}>
            {(sessions.data ?? []).map((s) => (
              <tr key={s.id}>
                <Td className="max-w-xs truncate text-ink-2">{s.userAgent ?? '—'}</Td>
                <Td className="tabular">{s.ip ?? '—'}</Td>
                <Td>{fmtDateTime(s.createdAt)}</Td>
                <Td>{fmtAgo(s.lastSeenAt)}</Td>
                <Td>{s.current && <Badge tone="green">This device</Badge>}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  )
}
