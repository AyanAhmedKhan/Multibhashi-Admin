import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, LogOut, Send, ShieldOff, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { ShareInvite } from '../../components/share-invite'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { fmtAgo, fmtDateTime } from '../../lib/format'
import { useReason } from '../../components/dialogs'
import { Badge, Button, Card, ErrorNote, KeyValue, Modal, PageHeader, Spinner, Table, Td } from '../../components/ui'
import { RolePicker, SignInStep, STATUS_TONE, type Invite, type RoleOption } from './StaffPage'

interface StaffDetail {
  id: number
  email: string
  name: string
  status: string
  mfaEnabled: boolean
  lockedUntil: string | null
  lastLoginAt: string | null
  lastLoginIp: string | null
  setupExpiresAt: string | null
  disabledReason: string | null
  recoveryCodesLeft: number
  createdAt: string
  roles: { id: number; slug: string; name: string }[]
  permissions: string[]
  sessions: { id: number; ip: string | null; userAgent: string | null; createdAt: string; lastSeenAt: string | null }[]
}

export function StaffMemberPage() {
  const { id } = useParams()
  const { me, can } = useAuth()
  const ask = useReason()
  const queryClient = useQueryClient()
  const detail = useQuery({ queryKey: ['staff', id], queryFn: () => api.get<StaffDetail>(`staff/${id}`) })
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ roles: RoleOption[] }>('roles'), enabled: can('console.roles.read') })
  const [picked, setPicked] = useState<number[]>([])
  const [invite, setInvite] = useState<Invite | null>(null)

  useEffect(() => {
    if (detail.data) setPicked(detail.data.roles.map((r) => r.id))
  }, [detail.data])

  if (detail.isLoading) return <Spinner />
  if (detail.error || !detail.data) return <ErrorNote error={detail.error} />
  const s = detail.data
  const self = s.id === me?.user.id
  const manage = can('console.staff.manage')
  const reload = () => queryClient.invalidateQueries({ queryKey: ['staff'] })
  const changed = picked.length !== s.roles.length || picked.some((r) => !s.roles.some((x) => x.id === r))

  const act = (path: string, title: string, description: string, opts: { danger?: boolean; confirmText?: string } = {}) =>
    ask({
      title,
      description,
      danger: opts.danger,
      confirmText: opts.confirmText,
      confirmLabel: title,
      run: async (reason) => {
        const res = await api.post<{ setupLink?: string; expiresAt?: string }>(`staff/${s.id}/${path}`, { reason })
        if (res.setupLink) setInvite({ link: res.setupLink, name: s.name, email: s.email, expiresAt: res.expiresAt })
        else toast.success(`${title}: done`)
        await reload()
      },
    })

  const saveRoles = () =>
    ask({
      title: 'Change roles',
      description: 'Takes effect on their next request. Adding Super Admin takes effect right away (it is in the audit log).',
      confirmLabel: 'Save roles',
      run: async (reason) => {
        await api.put<{ status: string }>(`staff/${s.id}/roles`, { roles: picked, reason })
        toast.success('Roles saved')
        await reload()
      },
    })

  return (
    <>
      <PageHeader
        title={s.name}
        subtitle={s.email}
        actions={
          manage &&
          !self && (
            <>
              {s.status === 'invited' && (
                <Button
                  variant="primary"
                  icon={<Send />}
                  onClick={async () => {
                    try {
                      const res = await api.post<{ setupLink: string; expiresAt: string }>(`staff/${s.id}/invite-link`)
                      setInvite({ link: res.setupLink, name: s.name, email: s.email, expiresAt: res.expiresAt })
                      await reload()
                    } catch (err) {
                      toast.error((err as Error).message)
                    }
                  }}
                >
                  Share new invite link
                </Button>
              )}
              {s.status === 'active' && (
                <Button icon={<ShieldOff className="size-4" />} onClick={() => act('disable', 'Disable account', 'Signs them out everywhere and blocks sign-in. Do this the day someone leaves.', { danger: true })}>
                  Disable
                </Button>
              )}
              {s.status === 'disabled' && (
                <Button icon={<ShieldCheck className="size-4" />} onClick={() => act('enable', 'Enable account', 'They can sign in again with their existing password.')}>
                  Enable
                </Button>
              )}
              <Button icon={<KeyRound className="size-4" />} onClick={() => act('reset-access', 'Reset access', 'Wipes their password, authenticator and recovery codes and makes a new setup link. Use for a lost phone or forgotten password.', { danger: true, confirmText: 'RESET' })}>
                Reset access
              </Button>
              <Button icon={<LogOut className="size-4" />} onClick={() => act('revoke-sessions', 'Sign out everywhere', 'Ends all their sessions now.')}>
                Sign out everywhere
              </Button>
            </>
          )
        }
      />
      <Modal open={!!invite} title={`Share ${s.name.split(/\s+/)[0]}’s setup link`} onClose={() => setInvite(null)} footer={<Button variant="primary" onClick={() => setInvite(null)}>Done</Button>}>
        {invite && <ShareInvite {...invite} />}
      </Modal>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Account">
          <KeyValue
            items={[
              ['Status', <><Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge> {s.lockedUntil && <Badge tone="red">locked until {fmtDateTime(s.lockedUntil)}</Badge>}</>],
              ['Second sign-in step', <SignInStep hasApp={s.mfaEnabled} />],
              ...(s.mfaEnabled ? ([['Recovery codes left', s.recoveryCodesLeft]] as [string, number][]) : []),
              ['Last sign-in', `${fmtDateTime(s.lastLoginAt)}${s.lastLoginIp ? ` from ${s.lastLoginIp}` : ''}`],
              ['Created', fmtDateTime(s.createdAt)],
              ...(s.setupExpiresAt ? ([['Setup link expires', fmtDateTime(s.setupExpiresAt)]] as [string, string][]) : []),
              ...(s.disabledReason ? ([['Disabled because', s.disabledReason]] as [string, string][]) : []),
              ['Permissions', `${s.permissions.length} effective`],
            ]}
          />
        </Card>
        <Card
          title="Roles"
          actions={manage && !self && changed && <Button size="sm" variant="primary" onClick={saveRoles}>Save roles</Button>}
        >
          {manage && !self && roles.data ? (
            <RolePicker roles={roles.data.roles} value={picked} onChange={setPicked} can={can} />
          ) : (
            <div className="flex flex-wrap gap-1">{s.roles.map((r) => <Badge key={r.id} tone="blue">{r.name}</Badge>)}</div>
          )}
          {self && <p className="mt-2 text-xs text-muted-foreground">You can’t change your own roles; another admin can.</p>}
        </Card>
        <Card title="Signed in on" className="lg:col-span-2" padded={false}>
          <Table head={['Device', 'IP', 'Since', 'Last active']}>
            {s.sessions.map((x) => (
              <tr key={x.id}>
                <Td className="max-w-xs truncate text-ink-2">{x.userAgent ?? '—'}</Td>
                <Td className="tabular">{x.ip ?? '—'}</Td>
                <Td>{fmtDateTime(x.createdAt)}</Td>
                <Td>{fmtAgo(x.lastSeenAt)}</Td>
              </tr>
            ))}
            {!s.sessions.length && <tr><Td className="text-muted-foreground">No active sessions.</Td></tr>}
          </Table>
        </Card>
      </div>
    </>
  )
}
