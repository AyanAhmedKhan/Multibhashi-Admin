import { useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Brain, CalendarDays, Clock, Download, Lock, PenLine, Smartphone, Timer, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { fmtAgo, fmtDateTime, fmtInt, fmtMinutes } from '../../lib/format'
import { useReason } from '../../components/dialogs'
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, KeyValue, Modal, Spinner, Stat, Table, Tabs, Td, Textarea } from '../../components/ui'
import { statusTone } from '../tutor/ClassesPage'
import { LearnerAvatar, LearnerName, type NameSource } from '../../components/learner-name'
import { AiProPanel } from './AiProPanel'

type Row = Record<string, unknown>

interface LearnerDetail {
  learner: { id: number; name: string | null; nameSource: NameSource; email: string | null; phone: string | null; createdAt: string | null; masked: boolean }
  profile: {
    account: Row | null
    details: Row | null
    languages: { speaks: Row[]; learns: Row[] }
    activity: {
      lastSeen: string | null
      sessions30d: number
      appMinutes30d: number
      devices: { device: string; appVersion: string | null; lastSeen: string | null }[]
      screens30d: { screen: string; visits: number; minutes: number }[]
    }
    bookings: Row[]
    subscriptions: Row[]
  } | null
  stats: { classes: number; minutesUsed: number; minutesLeft: number; freeGrantsLast24h: number }
  memory: { version: number; erasedAt: string | null; updatedAt: string | null } | null
  classes: { id: number; status: string | null; lesson_topic: string | null; total_minutes: number; remaining_minutes: number; time_spent: number; created_at: string }[]
}

interface Memory {
  profile: { memory: { facts?: string[]; preferences?: string[]; languages?: Record<string, { level?: string; strengths?: string[]; struggles?: string[]; mastered?: string[]; practice_next?: string[] }> }; version: number; erasedAt: string | null } | null
  summaries: { id: number; classId: number; language: string | null; summary: string; updatedAt: string }[]
}

const SCREEN: Record<string, string> = { pdf: 'PDF lesson', quiz: 'Quiz', quiz_feedback: 'Quiz feedback', video: 'Recording', learn_card_video: 'Learn-card video', lesson: 'Lesson list', ai_tutor: 'AI tutor' }

const label = (key: string) => key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

/** A database value as people read it: dates, booleans, epoch-ms, empty. */
function show(key: string, value: unknown): ReactNode {
  if (value === null || value === undefined || value === '') return <span className="text-muted-foreground">—</span>
  if (typeof value === 'boolean' || ((key.startsWith('is_') || key.startsWith('has_')) && (value === 0 || value === 1))) return value ? 'Yes' : 'No'
  if (typeof value === 'number' && /(_on|_at|_ms|expire|timestamp)$/.test(key) && value > 1e12) return fmtDateTime(new Date(value))
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) return fmtDateTime(value)
  if (typeof value === 'object') return <code className="text-xs">{JSON.stringify(value).slice(0, 200)}</code>
  const text = String(value)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

function Fields({ row, skip = [] }: { row: Row | null; skip?: string[] }) {
  if (!row) return <p className="text-sm text-muted-foreground">Not recorded.</p>
  const entries = Object.entries(row).filter(([k]) => !skip.includes(k))
  return <KeyValue items={entries.map(([k, v]) => [label(k), show(k, v)] as [ReactNode, ReactNode])} />
}

function RowsTable({ rows, empty }: { rows: Row[]; empty: string }) {
  if (!rows.length) return <Empty title={empty} />
  const keys = Object.keys(rows[0]).filter((k) => !['updated_at', 'deleted_at'].includes(k)).slice(0, 8)
  return (
    <Table head={keys.map(label)}>
      {rows.map((r, i) => (
        <tr key={i} className="border-b">
          {keys.map((k) => (
            <Td key={k} className="whitespace-nowrap text-sm">
              {show(k, r[k])}
            </Td>
          ))}
        </tr>
      ))}
    </Table>
  )
}

type TabKey = 'overview' | 'profile' | 'classes' | 'bookings' | 'memory'

/** Sets the account name: the column the app's profile screen writes, so the app and the tutor use it too. */
function RenameDialog({ learnerId, current, onClose, onDone }: { learnerId: number; current: string | null; onClose: () => void; onDone: () => Promise<void> }) {
  const [name, setName] = useState(current ?? '')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const ready = name.trim().length >= 2 && reason.trim().length >= 5
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.post(`learners/${learnerId}/name`, { name, reason })
      toast.success('Name saved')
      await onDone()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      title={current ? 'Edit learner name' : 'Set learner name'}
      description="Saved on the learner’s account: the app and the AI tutor show it from the next screen they open."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready || busy} onClick={save}>
            Save name
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Full name" hint="Letters, spaces, dots, apostrophes and hyphens.">
          {(fid) => <Input id={fid} value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} placeholder="e.g. Priya Sharma" />}
        </Field>
        <Field label="Reason">{(fid) => <Textarea id={fid} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Learner gave their name on the support call, ticket 4321" />}</Field>
        <ErrorNote error={error} />
      </div>
    </Modal>
  )
}

export function LearnerPage() {
  const { id } = useParams()
  const { can } = useAuth()
  const ask = useReason()
  const queryClient = useQueryClient()
  const detail = useQuery({ queryKey: ['learner', id], queryFn: () => api.get<LearnerDetail>(`learners/${id}`) })
  const [memory, setMemory] = useState<Memory | null>(null)
  const [tab, setTab] = useState<TabKey>('overview')
  const [renaming, setRenaming] = useState(false)

  if (detail.isLoading) return <Spinner rows={8} />
  if (detail.error || !detail.data) return <ErrorNote error={detail.error} />
  const { learner, stats, profile } = detail.data
  const canRename = can('learners.manage') && can('learners.pii.read') && !learner.masked

  const viewMemory = () =>
    ask({
      title: 'Read what the tutor remembers',
      description: 'The learner profile and class summaries the AI tutor uses to personalise classes.',
      confirmLabel: 'Open memory',
      run: async (reason) => setMemory(await api.post<Memory>(`learners/${id}/memory`, { reason })),
    })

  const eraseMemory = () =>
    ask({
      title: 'Erase AI tutor memory',
      description: 'Deletes the learner’s profile and every class summary, exactly like saying “forget everything” in class. A class in progress can’t write the old memory back. This can’t be undone.',
      confirmText: 'ERASE',
      confirmLabel: 'Erase memory',
      danger: true,
      run: async (reason) => {
        await api.post(`learners/${id}/memory/erase`, { reason })
        setMemory(null)
        toast.success('Tutor memory erased')
        await queryClient.invalidateQueries({ queryKey: ['learner', id] })
      },
    })

  const exportData = () =>
    ask({
      title: 'Export this learner’s data',
      description: 'A JSON file with everything the AI tutor holds about them, for a data access request (DPDP Act). Handle it as personal data.',
      confirmLabel: 'Download',
      run: async (reason) => {
        const data = await api.post(`learners/${id}/export`, { reason })
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
        const a = document.createElement('a')
        a.href = url
        a.download = `learner-${id}-ai-tutor-data.json`
        a.click()
        URL.revokeObjectURL(url)
        toast.success('Export downloaded')
      },
    })

  const tabs: { value: TabKey; label: string }[] = [
    { value: 'overview', label: 'Overview' },
    ...(profile ? [{ value: 'profile' as const, label: 'Profile' }] : []),
    { value: 'classes', label: `AI classes (${stats.classes})` },
    ...(profile ? [{ value: 'bookings' as const, label: 'Bookings & plans' }] : []),
    ...(can('tutor.memory.read') || can('tutor.memory.erase') ? [{ value: 'memory' as const, label: 'Tutor memory' }] : []),
  ]

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <LearnerAvatar name={learner.name} className="size-14" textClassName="text-lg" />
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
              <LearnerName name={learner.name} source={learner.nameSource} />
              {canRename && (
                <Button size="sm" variant="ghost" icon={<PenLine />} onClick={() => setRenaming(true)}>
                  {learner.nameSource === 'account' ? 'Edit name' : 'Set name'}
                </Button>
              )}
            </h1>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span>#{learner.id}</span>
              {learner.phone && <span className="tabular">{learner.phone}</span>}
              {learner.email && <span>{learner.email}</span>}
              <span>joined {fmtDateTime(learner.createdAt)}</span>
              {learner.masked && (
                <Badge tone="neutral">
                  <Lock className="size-3" /> contact masked for your role
                </Badge>
              )}
            </p>
          </div>
        </div>
        {can('learners.export') && (
          <Button icon={<Download />} onClick={exportData}>
            Export data
          </Button>
        )}
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="AI tutor classes" value={fmtInt(stats.classes)} icon={<Activity />} />
        <Stat label="Minutes used" value={fmtMinutes(stats.minutesUsed)} icon={<Timer />} />
        <Stat label="Minutes left" value={fmtMinutes(stats.minutesLeft)} icon={<Clock />} hint="across all classes" />
        <Stat
          label="Last seen in the app"
          value={profile?.activity.lastSeen ? fmtAgo(profile.activity.lastSeen) : '—'}
          icon={<Smartphone />}
          hint={profile ? `${fmtInt(profile.activity.sessions30d)} sessions in 30 days` : undefined}
        />
      </div>

      {renaming && (
        <RenameDialog
          learnerId={learner.id}
          current={learner.name}
          onClose={() => setRenaming(false)}
          onDone={async () => {
            setRenaming(false)
            await queryClient.invalidateQueries({ queryKey: ['learner', id] })
            await queryClient.invalidateQueries({ queryKey: ['learners'] })
          }}
        />
      )}

      <Tabs value={tab} onChange={setTab} items={tabs} />

      {tab === 'overview' && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Contact">
            <KeyValue
              items={[
                ['Name', <LearnerName name={learner.name} source={learner.nameSource} />],
                ['Phone', <span className="tabular">{learner.phone ?? '—'}</span>],
                ['Email', learner.email ?? '—'],
                ['Learner id', `#${learner.id}`],
                ['Joined', fmtDateTime(learner.createdAt)],
                ['Free grants, last 24 h', `${stats.freeGrantsLast24h} (tutor API cap: 10 a day)`],
              ]}
            />
          </Card>
          {can('tutor.access.read') ? <AiProPanel learnerId={learner.id} /> : <div />}
          {profile && (
            <Card title="Activity, last 30 days" className="lg:col-span-2">
              <div className="grid gap-6 md:grid-cols-2">
                <div>
                  <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Most used screens</div>
                  {profile.activity.screens30d.length ? (
                    <ul className="space-y-2 text-sm">
                      {profile.activity.screens30d.map((s) => (
                        <li key={s.screen} className="flex justify-between gap-3">
                          <span>{SCREEN[s.screen] ?? s.screen}</span>
                          <span className="tabular text-muted-foreground">
                            {fmtInt(s.visits)} visits · {fmtMinutes(s.minutes)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">No screen activity recorded.</p>
                  )}
                </div>
                <div>
                  <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Devices</div>
                  {profile.activity.devices.length ? (
                    <ul className="space-y-2 text-sm">
                      {profile.activity.devices.map((d, i) => (
                        <li key={i} className="flex justify-between gap-3">
                          <span className="capitalize">
                            {d.device ?? 'unknown'} {d.appVersion && <span className="text-muted-foreground">· v{d.appVersion}</span>}
                          </span>
                          <span className="text-muted-foreground">{fmtAgo(d.lastSeen)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">No app sessions recorded.</p>
                  )}
                  <p className="mt-3 text-xs text-muted-foreground">{fmtMinutes(profile.activity.appMinutes30d)} in the app in 30 days</p>
                </div>
              </div>
            </Card>
          )}
        </div>
      )}

      {tab === 'profile' && profile && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Account" className="lg:col-span-2">
            <Fields row={profile.account} />
          </Card>
          <Card title="Profile details">
            <Fields row={profile.details} skip={['id', 'user_id']} />
          </Card>
          <Card title="Languages">
            <div className="space-y-4 text-sm">
              <div>
                <div className="mb-1 text-xs text-muted-foreground">Speaks</div>
                {profile.languages.speaks.length ? <RowsTable rows={profile.languages.speaks} empty="" /> : <p className="text-muted-foreground">Not recorded.</p>}
              </div>
              <div>
                <div className="mb-1 text-xs text-muted-foreground">Learning</div>
                {profile.languages.learns.length ? <RowsTable rows={profile.languages.learns} empty="" /> : <p className="text-muted-foreground">Not recorded.</p>}
              </div>
            </div>
          </Card>
        </div>
      )}

      {tab === 'classes' && (
        <Card padded={false}>
          {detail.data.classes.length ? (
            <Table head={['Class', 'Lesson', 'Status', 'Used / total', 'Left', 'Started']}>
              {detail.data.classes.map((c) => (
                <tr key={c.id} className="border-b transition-colors hover:bg-muted/50">
                  <Td>
                    <Link className="font-medium text-primary hover:underline" to={`/tutor/classes/${c.id}`}>
                      #{c.id}
                    </Link>
                  </Td>
                  <Td>{c.lesson_topic ?? <span className="text-muted-foreground">Not started yet</span>}</Td>
                  <Td>
                    <Badge tone={statusTone(c.status)}>{c.status ?? 'unknown'}</Badge>
                  </Td>
                  <Td className="tabular whitespace-nowrap">
                    {fmtMinutes(c.time_spent)} / {fmtMinutes(c.total_minutes)}
                  </Td>
                  <Td className="tabular">{fmtMinutes(c.remaining_minutes)}</Td>
                  <Td className="whitespace-nowrap">{fmtDateTime(c.created_at)}</Td>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty title="No AI tutor classes yet" icon={<CalendarDays />} />
          )}
        </Card>
      )}

      {tab === 'bookings' && profile && (
        <div className="space-y-6">
          <Card title="Course bookings" padded={false}>
            <RowsTable rows={profile.bookings} empty="No course bookings (or the bookings table isn’t in this database)." />
          </Card>
          <Card title="Subscriptions" padded={false}>
            <RowsTable rows={profile.subscriptions} empty="No subscriptions." />
          </Card>
        </div>
      )}

      {tab === 'memory' && (
        <Card
          title={
            <span className="inline-flex items-center gap-2">
              <Brain className="size-4 text-violet" aria-hidden /> What the tutor remembers
            </span>
          }
          actions={
            <>
              {can('tutor.memory.read') && !memory && (
                <Button size="sm" onClick={viewMemory}>
                  View
                </Button>
              )}
              {can('tutor.memory.erase') && (
                <Button size="sm" variant="danger" icon={<Trash2 />} onClick={eraseMemory}>
                  Erase
                </Button>
              )}
            </>
          }
        >
          {!memory ? (
            <p className="text-sm text-muted-foreground">
              {detail.data.memory
                ? `Profile version ${detail.data.memory.version}, updated ${fmtDateTime(detail.data.memory.updatedAt)}${detail.data.memory.erasedAt ? ` · last erased ${fmtDateTime(detail.data.memory.erasedAt)}` : ''}. Viewing it asks for a reason.`
                : 'The tutor has no memory of this learner yet.'}
            </p>
          ) : (
            <div className="space-y-4 text-sm">
              {!memory.profile || !Object.keys(memory.profile.memory ?? {}).length ? (
                <p className="text-muted-foreground">The profile is empty.</p>
              ) : (
                <>
                  {!!memory.profile.memory.facts?.length && (
                    <div>
                      <div className="text-xs text-muted-foreground">Facts</div>
                      <p>{memory.profile.memory.facts.join(' · ')}</p>
                    </div>
                  )}
                  {Object.entries(memory.profile.memory.languages ?? {}).map(([lang, m]) => (
                    <div key={lang} className="rounded-lg bg-muted p-3">
                      <div className="font-medium">
                        {lang} · {m.level ?? 'level unknown'}
                      </div>
                      {m.strengths?.length ? <div className="text-ink-2">Strong: {m.strengths.join(', ')}</div> : null}
                      {m.struggles?.length ? <div className="text-ink-2">Struggles: {m.struggles.join(', ')}</div> : null}
                      {m.practice_next?.length ? <div className="text-ink-2">Practise next: {m.practice_next.join(', ')}</div> : null}
                    </div>
                  ))}
                </>
              )}
              <div>
                <div className="mb-1 text-xs text-muted-foreground">Class summaries ({memory.summaries.length})</div>
                <ul className="space-y-2">
                  {memory.summaries.map((s) => (
                    <li key={s.id} className="rounded-lg border p-2">
                      <div className="text-xs text-muted-foreground">
                        Class #{s.classId} · {s.language ?? '—'} · {fmtDateTime(s.updatedAt)}
                      </div>
                      <p className="text-ink-2">{s.summary}</p>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </Card>
      )}
    </>
  )
}
