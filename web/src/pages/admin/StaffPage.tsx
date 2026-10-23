import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Crown, Mail, Search, Send, UserPlus, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Checkbox } from '@/components/ui/checkbox'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { fmtAgo, fmtDateTime } from '../../lib/format'
import { ShareInvite } from '../../components/share-invite'
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Modal, PageHeader, Spinner, Table, Td, Textarea, type Tone } from '../../components/ui'

export interface StaffRow {
  id: number
  email: string
  name: string
  status: 'invited' | 'active' | 'disabled'
  mfaEnabled: boolean
  lockedUntil: string | null
  lastLoginAt: string | null
  setupExpiresAt: string | null
  roles: { id: number; slug: string; name: string }[]
}

export interface RoleOption {
  id: number
  slug: string
  name: string
  description: string | null
  isSystem: boolean
  permissions: string[]
  members: number
  seats?: string
}

export interface Invite {
  link: string
  name: string
  email: string
  expiresAt?: string | null
  superAdmin?: 'granted' | 'pending_approval' | null
  emailed?: boolean
  emailError?: string | null
}

export const STATUS_TONE: Record<string, Tone> = { active: 'green', invited: 'amber', disabled: 'neutral' }

/** The second sign-in step this person gets under the current policy (mirrors authService.methodFor). */
export function SignInStep({ hasApp }: { hasApp: boolean }) {
  const { me } = useAuth()
  const method = me?.policy.mfaMethod
  if (method === 'off') return <Badge tone="red">password only</Badge>
  if (method === 'email') return <Badge tone="green">email code</Badge>
  if (hasApp) return <Badge tone="green">authenticator app</Badge>
  return me?.policy.mailConfigured ? <Badge tone="amber">email code (no app yet)</Badge> : <Badge tone="amber">not set up</Badge>
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

/** Roles a person can hand out: only those whose every permission they hold themselves. */
export function RolePicker({ roles, value, onChange, can }: { roles: RoleOption[]; value: number[]; onChange: (v: number[]) => void; can: (p: string) => boolean }) {
  return (
    <div className="max-h-80 space-y-1 overflow-y-auto rounded-lg border p-1.5">
      {roles.map((r) => {
        const grantable = r.permissions.every((p) => can(p))
        const checked = value.includes(r.id)
        const isSuper = r.slug === 'super_admin'
        return (
          <label
            key={r.id}
            className={`flex cursor-pointer items-start gap-3 rounded-md p-2.5 text-sm transition-colors ${grantable ? 'hover:bg-muted' : 'cursor-not-allowed opacity-50'} ${checked ? 'bg-accent' : ''}`}
          >
            <Checkbox
              className="mt-0.5"
              disabled={!grantable}
              checked={checked}
              onCheckedChange={(next) => onChange(next ? [...value, r.id] : value.filter((id) => id !== r.id))}
            />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 font-medium">
                {isSuper && <Crown className="size-3.5 text-violet" aria-hidden />}
                {r.name}
                {!r.isSystem && <Badge tone="blue">custom</Badge>}
              </span>
              <span className="block text-xs text-muted-foreground">{r.description}</span>
              {isSuper && checked && <span className="mt-1 block text-xs text-warning">Can do everything, including managing other admins. Keep exactly two.</span>}
            </span>
          </label>
        )
      })}
    </div>
  )
}

export function StaffPage() {
  const { can, me } = useAuth()
  const queryClient = useQueryClient()
  const staff = useQuery({ queryKey: ['staff'], queryFn: () => api.get<StaffRow[]>('staff') })
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ roles: RoleOption[] }>('roles'), enabled: can('console.roles.read') })
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<number[]>([])
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [invite, setInvite] = useState<Invite | null>(null)
  const [sendEmail, setSendEmail] = useState(true)
  const manage = can('console.staff.manage')

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ setupLink: string; expiresAt: string; superAdmin: Invite['superAdmin']; emailed: boolean; emailError: string | null; user: { name: string; email: string } }>('staff', {
        email,
        name,
        roles: picked,
        reason,
        send_email: sendEmail,
      })
      setInvite({ link: res.setupLink, name: res.user.name, email: res.user.email, expiresAt: res.expiresAt, superAdmin: res.superAdmin, emailed: res.emailed, emailError: res.emailError })
      toast.success(res.emailed ? `Invite emailed to ${res.user.email}` : `Invite created for ${res.user.name}`)
      await queryClient.invalidateQueries({ queryKey: ['staff'] })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const reissue = async (s: StaffRow) => {
    try {
      const res = await api.post<{ setupLink: string; expiresAt: string; emailed: boolean; emailError: string | null }>(`staff/${s.id}/invite-link`, { send_email: !!me?.policy.mailConfigured })
      setInvite({ link: res.setupLink, name: s.name, email: s.email, expiresAt: res.expiresAt, emailed: res.emailed, emailError: res.emailError })
      setOpen(true)
      toast.success('New invite link: the previous one no longer works')
      await queryClient.invalidateQueries({ queryKey: ['staff'] })
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const close = () => {
    setOpen(false)
    setInvite(null)
    setEmail('')
    setName('')
    setPicked([])
    setReason('')
    setError(null)
  }

  const rows = (staff.data ?? []).filter((s) => !filter || `${s.name} ${s.email} ${s.roles.map((r) => r.name).join(' ')}`.toLowerCase().includes(filter.toLowerCase()))
  const counts = {
    active: staff.data?.filter((s) => s.status === 'active').length ?? 0,
    invited: staff.data?.filter((s) => s.status === 'invited').length ?? 0,
    supers: staff.data?.filter((s) => s.status === 'active' && s.roles.some((r) => r.slug === 'super_admin')).length ?? 0,
  }

  return (
    <>
      <PageHeader
        title="Staff"
        subtitle="One account per person, never shared. Everyone signs in with their own password and a one-time code."
        actions={
          manage && (
            <Button variant="primary" icon={<UserPlus />} onClick={() => setOpen(true)}>
              Invite staff
            </Button>
          )
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="green">{counts.active} active</Badge>
        <Badge tone="amber">{counts.invited} invited</Badge>
        <Badge tone={counts.supers === 2 ? 'violet' : 'red'}>
          <Crown className="size-3" /> {counts.supers} Super Admin{counts.supers === 1 ? '' : 's'}
          {counts.supers !== 2 && ' (keep 2)'}
        </Badge>
      </div>
      <ErrorNote error={staff.error} />
      <Card padded={false}>
        <div className="border-b p-3">
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" aria-hidden />
            <Input aria-label="Filter staff" className="pl-9" placeholder="Filter by name, email or role" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
        </div>
        {staff.isLoading ? (
          <Spinner />
        ) : !rows.length ? (
          <Empty title="No staff match" icon={<Users />} />
        ) : (
          <Table head={['Person', 'Roles', 'Status', 'Sign-in step', 'Last sign-in', '']}>
            {rows.map((s) => (
              <tr key={s.id} className="border-b transition-colors hover:bg-muted/50">
                <Td>
                  <Link to={`/staff/${s.id}`} className="flex items-center gap-3">
                    <Avatar className="size-8">
                      <AvatarFallback className="bg-accent text-xs font-semibold text-accent-foreground">{initials(s.name)}</AvatarFallback>
                    </Avatar>
                    <span className="min-w-0">
                      <span className="block font-medium hover:underline">{s.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{s.email}</span>
                    </span>
                  </Link>
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {s.roles.map((r) => (
                      <Badge key={r.id} tone={r.slug === 'super_admin' ? 'violet' : 'blue'}>
                        {r.slug === 'super_admin' && <Crown className="size-3" />}
                        {r.name}
                      </Badge>
                    ))}
                  </div>
                </Td>
                <Td>
                  <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge> {s.lockedUntil && <Badge tone="red">locked</Badge>}
                </Td>
                <Td>
                  <SignInStep hasApp={s.mfaEnabled} />
                </Td>
                <Td className="whitespace-nowrap text-muted-foreground">{s.status === 'invited' ? (s.setupExpiresAt && new Date(s.setupExpiresAt) > new Date() ? `invite valid until ${fmtDateTime(s.setupExpiresAt)}` : 'invite expired') : fmtAgo(s.lastLoginAt)}</Td>
                <Td>
                  {s.status === 'invited' && manage && (
                    <Button size="sm" variant="outline" icon={<Send />} onClick={() => reissue(s)}>
                      Share invite
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal
        open={open}
        wide={!invite}
        title={invite ? `Share ${invite.name.split(/\s+/)[0]}’s invite` : 'Invite a staff member'}
        description={invite ? 'They choose their own password. Nobody else ever sees it.' : 'They get a one-time link to choose their own password.'}
        onClose={close}
        footer={
          invite ? (
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button variant="primary" loading={busy} icon={<Send />} disabled={!email || name.length < 2 || !picked.length || reason.trim().length < 5} onClick={create}>
                Create invite
              </Button>
            </>
          )
        }
      >
        {invite ? (
          <ShareInvite {...invite} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-4">
              <Field label="Work email">{(id) => <Input id={id} type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@multibhashi.com" />}</Field>
              <Field label="Full name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
              <Field label="Reason">{(id) => <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. New support hire, starts Monday" />}</Field>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox className="mt-0.5" checked={sendEmail} onCheckedChange={(v) => setSendEmail(!!v)} />
                <span>
                  <span className="flex items-center gap-1.5 font-medium"><Mail className="size-3.5" /> Email the invite to them</span>
                  <span className="block text-xs text-muted-foreground">{me?.policy.mailConfigured ? 'Sent from the console’s Gmail. You also get the link to share.' : 'Email isn’t set up on this server: you’ll get the link to share yourself.'}</span>
                </span>
              </label>
              <ErrorNote error={error} />
            </div>
            <Field label="Roles" hint="Start with the least access the job needs. Roles you don’t fully hold are greyed out.">
              {() => <RolePicker roles={roles.data?.roles ?? []} value={picked} onChange={setPicked} can={can} />}
            </Field>
          </div>
        )}
      </Modal>
    </>
  )
}
