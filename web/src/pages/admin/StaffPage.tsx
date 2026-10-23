import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, UserPlus } from 'lucide-react'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { fmtAgo } from '../../lib/format'
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, PageHeader, Spinner, Table, Td, Textarea, type Tone } from '../../components/ui'

export interface StaffRow {
  id: number
  email: string
  name: string
  status: 'invited' | 'active' | 'disabled'
  mfaEnabled: boolean
  lockedUntil: string | null
  lastLoginAt: string | null
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

export const STATUS_TONE: Record<string, Tone> = { active: 'green', invited: 'amber', disabled: 'neutral' }

export function RolePicker({ roles, value, onChange, can }: { roles: RoleOption[]; value: number[]; onChange: (v: number[]) => void; can: (p: string) => boolean }) {
  return (
    <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-line p-2">
      {roles.map((r) => {
        // Roles holding permissions you don't have can't be handed out (no escalation).
        const grantable = r.permissions.every((p) => can(p))
        return (
          <label key={r.id} className={`flex items-start gap-2 rounded-md p-2 text-sm ${grantable ? 'hover:bg-surface-2' : 'opacity-50'}`}>
            <input
              type="checkbox"
              className="mt-1"
              disabled={!grantable}
              checked={value.includes(r.id)}
              onChange={(e) => onChange(e.target.checked ? [...value, r.id] : value.filter((id) => id !== r.id))}
            />
            <span>
              <span className="font-medium text-ink">{r.name}</span>
              {!r.isSystem && <Badge tone="blue">custom</Badge>}
              <span className="block text-xs text-ink-3">{r.description}</span>
            </span>
          </label>
        )
      })}
    </div>
  )
}

export function StaffPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const staff = useQuery({ queryKey: ['staff'], queryFn: () => api.get<StaffRow[]>('staff') })
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ roles: RoleOption[] }>('roles'), enabled: can('console.roles.read') })
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<number[]>([])
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [link, setLink] = useState<string | null>(null)

  const invite = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ setupLink: string }>('staff', { email, name, roles: picked, reason })
      setLink(res.setupLink)
      await queryClient.invalidateQueries({ queryKey: ['staff'] })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  const close = () => {
    setOpen(false)
    setLink(null)
    setEmail('')
    setName('')
    setPicked([])
    setReason('')
    setError(null)
  }

  return (
    <>
      <PageHeader
        title="Staff"
        subtitle="One account per person, never shared. Everyone signs in with a password and an authenticator app."
        actions={
          can('console.staff.manage') && (
            <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setOpen(true)}>
              Invite
            </Button>
          )
        }
      />
      <ErrorNote error={staff.error} />
      <Card padded={false}>
        {staff.isLoading ? (
          <Spinner />
        ) : (
          <Table head={['Name', 'Roles', 'Status', 'Two-step', 'Last sign-in']}>
            {(staff.data ?? []).map((s) => (
              <tr key={s.id} className="hover:bg-surface-2">
                <Td>
                  <Link to={`/staff/${s.id}`} className="font-medium text-primary">{s.name}</Link>
                  <div className="text-xs text-ink-3">{s.email}</div>
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">{s.roles.map((r) => <Badge key={r.id} tone="blue">{r.name}</Badge>)}</div>
                </Td>
                <Td>
                  <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge> {s.lockedUntil && <Badge tone="red">locked</Badge>}
                </Td>
                <Td>{s.mfaEnabled ? <Badge tone="green">on</Badge> : <Badge tone="amber">not set up</Badge>}</Td>
                <Td>{fmtAgo(s.lastLoginAt)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal
        open={open}
        title="Invite a staff member"
        onClose={close}
        footer={
          link ? (
            <Button variant="primary" onClick={close}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button variant="primary" loading={busy} disabled={!email || name.length < 2 || !picked.length || reason.trim().length < 5} onClick={invite}>
                Create invite
              </Button>
            </>
          )
        }
      >
        {link ? (
          <div className="space-y-3 text-sm">
            <p>Send this one-time setup link to {name} over a trusted channel (it expires in 48 hours and works once):</p>
            <code className="block break-all rounded-lg bg-surface-2 p-3 text-xs">{link}</code>
            <Button size="sm" icon={<Copy className="size-4" />} onClick={() => navigator.clipboard?.writeText(link)}>Copy link</Button>
          </div>
        ) : (
          <>
            <Field label="Work email">{(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
            <Field label="Full name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label="Roles" hint="Start with the least access the job needs. Super Admin is requested later and needs a second Super Admin.">
              {() => <RolePicker roles={(roles.data?.roles ?? []).filter((r) => r.slug !== 'super_admin')} value={picked} onChange={setPicked} can={can} />}
            </Field>
            <Field label="Reason">{(id) => <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. New support hire, starts Monday" />}</Field>
            <ErrorNote error={error} />
          </>
        )}
      </Modal>
    </>
  )
}
