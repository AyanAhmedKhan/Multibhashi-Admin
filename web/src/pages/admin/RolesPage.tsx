import { Fragment, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Minus, Plus } from 'lucide-react'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { useReason } from '../../components/dialogs'
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, PageHeader, Spinner, Tabs, Textarea, type Tone } from '../../components/ui'
import type { RoleOption } from './StaffPage'

interface Permission {
  key: string
  label: string
  risk: 'read' | 'sensitive' | 'write' | 'critical'
  available: boolean
  scoped?: boolean
}
interface Module {
  key: string
  label: string
  phase: number
  permissions: Permission[]
}

const RISK: Record<Permission['risk'], Tone> = { read: 'neutral', sensitive: 'violet', write: 'blue', critical: 'red' }

export function RolesPage() {
  const { can } = useAuth()
  const ask = useReason()
  const queryClient = useQueryClient()
  const data = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ roles: (RoleOption & { legacy?: string[] })[]; modules: Module[] }>('roles') })
  const [view, setView] = useState<'roles' | 'matrix'>('roles')
  const [editing, setEditing] = useState<{ id?: number; slug: string; name: string; description: string; permissions: string[] } | null>(null)

  if (data.isLoading) return <Spinner />
  if (data.error || !data.data) return <ErrorNote error={data.error} />
  const { roles, modules } = data.data
  const manage = can('console.roles.manage')

  const save = () =>
    ask({
      title: editing?.id ? 'Save role' : 'Create role',
      description: 'You can only include permissions you hold yourself.',
      confirmLabel: 'Save',
      run: async (reason) => {
        const body = { slug: editing!.slug, name: editing!.name, description: editing!.description, permissions: editing!.permissions, reason }
        if (editing!.id) await api.put(`roles/${editing!.id}`, body)
        else await api.post('roles', body)
        setEditing(null)
        await queryClient.invalidateQueries({ queryKey: ['roles'] })
      },
    })

  return (
    <>
      <PageHeader
        title="Roles & permissions"
        subtitle="13 built-in roles cover every team; they are defined in code and change only with a release. Need something different? Make a custom role."
        actions={
          manage && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({ slug: '', name: '', description: '', permissions: [] })}>
              Custom role
            </Button>
          )
        }
      />
      <Tabs value={view} onChange={setView} items={[{ value: 'roles', label: 'Roles' }, { value: 'matrix', label: 'Permission matrix' }]} />
      {view === 'roles' ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {roles.map((r) => (
            <Card key={r.id}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold text-ink">{r.name}</div>
                  <div className="text-xs text-ink-3">{r.slug}</div>
                </div>
                {r.isSystem ? <Badge>built-in</Badge> : <Badge tone="blue">custom</Badge>}
              </div>
              <p className="mt-2 text-sm text-ink-2">{r.description}</p>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
                <span>{r.permissions.length} permissions</span>
                <span>{r.members} people</span>
                {r.seats && <span>suggested: {r.seats}</span>}
              </div>
              {!!r.legacy?.length && <p className="mt-1 text-xs text-ink-3">Replaces old roles: {r.legacy.join(', ')}</p>}
              {!r.isSystem && manage && (
                <Button
                  size="sm"
                  className="mt-3"
                  onClick={() => setEditing({ id: r.id, slug: r.slug, name: r.name, description: r.description ?? '', permissions: r.permissions })}
                >
                  Edit
                </Button>
              )}
            </Card>
          ))}
        </div>
      ) : (
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-line">
                  <th className="sticky left-0 z-10 min-w-64 bg-surface px-3 py-2 text-left font-medium text-ink-3">Permission</th>
                  {roles.map((r) => (
                    <th key={r.id} className="whitespace-nowrap px-2 py-2 font-medium text-ink-2" style={{ writingMode: 'vertical-rl' }}>
                      {r.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {modules.map((m) => (
                  <Fragment key={m.key}>
                    <tr className="bg-surface-2">
                      <td colSpan={roles.length + 1} className="sticky left-0 px-3 py-1.5 font-semibold text-ink">
                        {m.label} {m.phase > 1 && <Badge>phase {m.phase}</Badge>}
                      </td>
                    </tr>
                    {m.permissions.map((p) => (
                      <tr key={p.key} className="border-b border-line">
                        <td className={`sticky left-0 bg-surface px-3 py-1.5 ${p.available ? 'text-ink' : 'text-ink-3'}`}>
                          <div className="flex items-center gap-1.5">
                            {p.label} <Badge tone={RISK[p.risk]}>{p.risk}</Badge>
                          </div>
                          <code className="text-[10px] text-ink-3">{p.key}</code>
                        </td>
                        {roles.map((r) => (
                          <td key={r.id} className="px-2 text-center">
                            {r.permissions.includes(p.key) ? (
                              <Check className="mx-auto size-4 text-success" aria-label="granted" />
                            ) : (
                              <Minus className="mx-auto size-3 text-line" aria-label="not granted" />
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-4 py-3 text-xs text-ink-3">
            Risk: <b>sensitive</b> reads are audited with a reason; <b>critical</b> actions also need a fresh authenticator code, and some need a second approver.
          </p>
        </Card>
      )}

      {editing && (
        <Modal
          open
          wide
          title={editing.id ? `Edit ${editing.name}` : 'New custom role'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" disabled={editing.name.length < 2 || (!editing.id && editing.slug.length < 3) || !editing.permissions.length} onClick={save}>
                Save
              </Button>
            </>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">{(id) => <Input id={id} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />}</Field>
            <Field label="Slug" hint="lower_case, can’t change later">
              {(id) => <Input id={id} disabled={!!editing.id} value={editing.slug} onChange={(e) => setEditing({ ...editing, slug: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} />}
            </Field>
          </div>
          <Field label="What this role is for">{(id) => <Textarea id={id} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />}</Field>
          <div className="space-y-3">
            {modules.map((m) => (
              <div key={m.key}>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">{m.label}</div>
                <div className="grid gap-1 sm:grid-cols-2">
                  {m.permissions.map((p) => {
                    const mine = can(p.key)
                    return (
                      <label key={p.key} className={`flex items-start gap-2 text-sm ${mine ? '' : 'opacity-40'}`} title={mine ? '' : 'You don’t hold this permission'}>
                        <input
                          type="checkbox"
                          className="mt-1"
                          disabled={!mine}
                          checked={editing.permissions.includes(p.key)}
                          onChange={(e) =>
                            setEditing({ ...editing, permissions: e.target.checked ? [...editing.permissions, p.key] : editing.permissions.filter((x) => x !== p.key) })
                          }
                        />
                        <span>
                          {p.label} <Badge tone={RISK[p.risk]}>{p.risk}</Badge>
                        </span>
                      </label>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </>
  )
}
