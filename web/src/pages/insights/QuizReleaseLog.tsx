import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowRight, ArrowUp, Pencil, Plus, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { fmtAgo, fmtDateTime, fmtDay } from '../../lib/format'
import { useReason } from '../../components/dialogs'
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Modal, Select, Spinner, Table, Td, Textarea, type Tone } from '../../components/ui'

/**
 * The quiz release log and the stored baseline (docs/QUIZ_OBSERVABILITY.md §7). Every change
 * that can move a quiz metric — a brief phase, an app fix, a confounder — with when it reached
 * learners; before/after comparisons are cut at that time.
 */

type Kind = 'fix' | 'telemetry' | 'confounder'
type Surface = 'app_web' | 'app_android' | 'app_ios' | 'backend' | 'admin'
type Direction = 'up' | 'down' | 'flat'
interface Expectation {
  metric: string
  direction: Direction
}
interface Release {
  id: number
  title: string
  phase: string | null
  kind: Kind
  surface: Surface
  ticket: string | null
  pr: string | null
  commitSha: string | null
  appVersion: string | null
  deployedAt: string | null
  deployedEstimated: boolean
  expects: Expectation[] | null
  notes: string | null
}
interface MetricDef {
  key: string
  label: string
  source: 'answers' | 'attempts' | 'events' | 'bills'
}
interface MetricsInfo {
  status: {
    definitionVersion: number
    backfillFrom: string
    firstDay: string | null
    lastDay: string | null
    days: number
    finalThrough: string | null
    lastComputedAt: string | null
    eventsFrom: string | null
    costFrom: string | null
  }
  metrics: MetricDef[]
}

const KIND: Record<Kind, { label: string; tone: Tone }> = {
  fix: { label: 'Fix', tone: 'green' },
  telemetry: { label: 'Tracking', tone: 'blue' },
  confounder: { label: 'Other change', tone: 'amber' },
}
const SURFACE: Record<Surface, string> = {
  app_web: 'App (web)',
  app_android: 'App (Android)',
  app_ios: 'App (iOS)',
  backend: 'Quiz backend',
  admin: 'Admin console',
}
const ARROW: Record<Direction, typeof ArrowUp> = { up: ArrowUp, down: ArrowDown, flat: ArrowRight }

// The console is used in India; deploy times are entered and shown in IST.
const IST_MS = 19_800_000
const toIstInput = (iso: string | null) => (iso ? new Date(Date.parse(iso) + IST_MS).toISOString().slice(0, 16) : '')
const fromIstInput = (value: string) => (value ? `${value}:00+05:30` : null)

interface Draft {
  id: number | null
  title: string
  phase: string
  kind: Kind
  surface: Surface
  ticket: string
  pr: string
  commit_sha: string
  app_version: string
  deployed_at: string
  deployed_estimated: boolean
  expects: Expectation[]
  notes: string
}

const empty = (): Draft => ({
  id: null,
  title: '',
  phase: '',
  kind: 'fix',
  surface: 'app_web',
  ticket: '',
  pr: '',
  commit_sha: '',
  app_version: '',
  deployed_at: '',
  deployed_estimated: false,
  expects: [],
  notes: '',
})

const draftOf = (r: Release): Draft => ({
  id: r.id,
  title: r.title,
  phase: r.phase ?? '',
  kind: r.kind,
  surface: r.surface,
  ticket: r.ticket ?? '',
  pr: r.pr ?? '',
  commit_sha: r.commitSha ?? '',
  app_version: r.appVersion ?? '',
  deployed_at: toIstInput(r.deployedAt),
  deployed_estimated: r.deployedEstimated,
  expects: r.expects ?? [],
  notes: r.notes ?? '',
})

export function QuizReleaseLog() {
  const { can } = useAuth()
  const ask = useReason()
  const queryClient = useQueryClient()
  const manage = can('analytics.releases.manage')
  const releases = useQuery({ queryKey: ['quiz-releases'], queryFn: () => api.get<{ releases: Release[] }>('insights/quiz-releases') })
  const info = useQuery({ queryKey: ['quiz-metrics'], queryFn: () => api.get<MetricsInfo>('insights/quiz-metrics') })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<unknown>(null)

  const labels = new Map((info.data?.metrics ?? []).map((m) => [m.key, m.label]))
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d))

  const save = async () => {
    if (!draft) return
    setSaving(true)
    setSaveError(null)
    const body = {
      title: draft.title,
      phase: draft.phase || null,
      kind: draft.kind,
      surface: draft.surface,
      ticket: draft.ticket || null,
      pr: draft.pr || null,
      commit_sha: draft.commit_sha || null,
      app_version: draft.app_version || null,
      deployed_at: fromIstInput(draft.deployed_at),
      deployed_estimated: draft.deployed_at ? draft.deployed_estimated : false,
      expects: draft.expects.filter((e) => e.metric),
      notes: draft.notes || null,
    }
    try {
      if (draft.id) await api.put(`insights/quiz-releases/${draft.id}`, body)
      else await api.post('insights/quiz-releases', body)
      toast.success(draft.id ? 'Change updated' : 'Change logged')
      setDraft(null)
      await queryClient.invalidateQueries({ queryKey: ['quiz-releases'] })
    } catch (error) {
      setSaveError(error)
    } finally {
      setSaving(false)
    }
  }

  const remove = (r: Release) =>
    ask({
      title: 'Delete this change',
      description: `“${r.title}” leaves the release log; before/after views lose its marker.`,
      confirmLabel: 'Delete',
      run: async (reason) => {
        await api.delete(`insights/quiz-releases/${r.id}`, { reason })
        toast.success('Change deleted')
        await queryClient.invalidateQueries({ queryKey: ['quiz-releases'] })
      },
    })

  const refs = (r: Release) => [r.ticket, r.pr, r.commitSha?.slice(0, 8)].filter(Boolean).join(' · ')

  // Render helpers shared by the phone list and the table (plain functions, not components)
  const when = (r: Release, inline = false) =>
    r.deployedAt ? (
      <>
        <span className="tabular">{fmtDateTime(r.deployedAt)}</span>
        {r.deployedEstimated && (inline ? <Badge tone="neutral">estimated</Badge> : <div><Badge tone="neutral">estimated</Badge></div>)}
      </>
    ) : (
      <Badge tone="violet">Not live yet</Badge>
    )

  const expects = (r: Release) => (
    <>
      {(r.expects ?? []).map((e) => {
        const Icon = ARROW[e.direction]
        return (
          <div key={e.metric} className="flex items-start gap-1">
            <Icon className="mt-0.5 size-3 shrink-0" aria-label={e.direction} />
            {labels.get(e.metric) ?? e.metric}
          </div>
        )
      })}
    </>
  )

  const actions = (r: Release) => (
    <div className="flex shrink-0">
      <Button size="sm" variant="ghost" icon={<Pencil aria-hidden />} aria-label={`Edit ${r.title}`} onClick={() => (setSaveError(null), setDraft(draftOf(r)))} />
      <Button size="sm" variant="ghost" icon={<Trash2 aria-hidden />} aria-label={`Delete ${r.title}`} onClick={() => remove(r)} />
    </div>
  )

  const s = info.data?.status
  return (
    <Card
      title="Quiz changes and the baseline"
      description="Every change that can move a quiz number, and when learners got it. Before/after comparisons are cut at these times."
      actions={
        manage && (
          <Button size="sm" icon={<Plus aria-hidden />} onClick={() => (setSaveError(null), setDraft(empty()))}>
            Log a change
          </Button>
        )
      }
      padded={false}
    >
      <div className="border-b px-5 py-3 text-sm text-ink-2">
        {info.isLoading ? (
          'Checking the stored baseline…'
        ) : info.error || !s ? (
          <ErrorNote error={info.error} />
        ) : s.days === 0 ? (
          <>
            <b>No daily metrics stored yet.</b> Run <code>node ace quiz:daily-metrics --backfill</code> once (from {fmtDay(s.backfillFrom)}), then daily after the provider sync.
          </>
        ) : (
          <>
            <b>Baseline:</b> {s.days} days stored, {fmtDay(s.firstDay!)} to {fmtDay(s.lastDay!)}
            {s.finalThrough ? `, frozen through ${fmtDay(s.finalThrough)}` : ', none frozen yet'}. App events{' '}
            {s.eventsFrom ? `from ${fmtDay(s.eventsFrom)}` : 'not in yet: they start when the app release with quiz events reaches learners'}. Updated{' '}
            {fmtAgo(s.lastComputedAt)}.
          </>
        )}
      </div>

      {releases.isLoading ? (
        <Spinner />
      ) : releases.error || !releases.data ? (
        <ErrorNote error={releases.error} />
      ) : releases.data.releases.length === 0 ? (
        <Empty title="No changes logged yet">Run <code>node ace quiz:seed-releases</code> to add the changes made before this log existed.</Empty>
      ) : (
        <>
          {/* Phones: one block per change; the seven-column table only from md up */}
          <ul className="divide-y md:hidden">
            {releases.data.releases.map((r) => (
              <li key={r.id} className="space-y-2 px-5 py-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="font-medium">{r.title}</div>
                  {manage && actions(r)}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {when(r, true)}
                  <Badge tone={KIND[r.kind].tone}>{KIND[r.kind].label}</Badge>
                  {r.phase !== null && <span>Phase {r.phase}</span>}
                  <span>{SURFACE[r.surface]}</span>
                  {refs(r) && <span>{refs(r)}</span>}
                </div>
                {r.notes && <div className="text-xs text-muted-foreground">{r.notes}</div>}
                {!!r.expects?.length && (
                  <div className="text-xs">
                    {expects(r)}
                  </div>
                )}
              </li>
            ))}
          </ul>
          <div className="hidden md:block">
            <Table head={['Reached learners', 'Change', 'Type', 'Where', 'Ticket / PR', 'Should move', ...(manage ? [''] : [])]}>
              {releases.data.releases.map((r) => (
                <tr key={r.id} className="align-top">
                  <Td className="whitespace-nowrap tabular">
                    {when(r)}
                  </Td>
                  <Td>
                    <div className="font-medium">{r.title}</div>
                    {r.notes && <div className="mt-0.5 max-w-prose text-xs text-muted-foreground">{r.notes}</div>}
                  </Td>
                  <Td>
                    <Badge tone={KIND[r.kind].tone}>{KIND[r.kind].label}</Badge>
                    {r.phase !== null && <div className="mt-1 text-xs text-muted-foreground">Phase {r.phase}</div>}
                  </Td>
                  <Td className="whitespace-nowrap">{SURFACE[r.surface]}</Td>
                  <Td className="text-xs">
                    {refs(r) || '—'}
                    {r.appVersion && <div className="text-muted-foreground">app {r.appVersion}</div>}
                  </Td>
                  <Td className="text-xs">{r.expects?.length ? expects(r) : '—'}</Td>
                  {manage && (
                    <Td className="whitespace-nowrap">
                      {actions(r)}
                    </Td>
                  )}
                </tr>
              ))}
            </Table>
          </div>
        </>
      )}

      {draft && (
        <Modal
          open
          wide
          title={draft.id ? 'Edit change' : 'Log a change'}
          description="Times are IST. Mark the time estimated when it is a merge or commit time rather than the moment learners got it."
          onClose={() => setDraft(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button variant="primary" loading={saving} disabled={draft.title.trim().length < 3} onClick={save}>
                {draft.id ? 'Save' : 'Log change'}
              </Button>
            </>
          }
        >
          <Field label="What changed">{(id) => <Input id={id} value={draft.title} maxLength={160} onChange={(e) => set('title', e.target.value)} />}</Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Type">
              {(id) => (
                <Select id={id} value={draft.kind} onChange={(e) => set('kind', e.target.value as Kind)}>
                  <option value="fix">Fix</option>
                  <option value="telemetry">Tracking</option>
                  <option value="confounder">Other change (not a fix)</option>
                </Select>
              )}
            </Field>
            <Field label="Brief phase">
              {(id) => (
                <Select id={id} value={draft.phase} onChange={(e) => set('phase', e.target.value)}>
                  <option value="">None</option>
                  {['0', '1', '2', '3', '4', '5', '6'].map((p) => (
                    <option key={p} value={p}>
                      Phase {p}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Where">
              {(id) => (
                <Select id={id} value={draft.surface} onChange={(e) => set('surface', e.target.value as Surface)}>
                  {(Object.keys(SURFACE) as Surface[]).map((k) => (
                    <option key={k} value={k}>
                      {SURFACE[k]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Reached learners (IST)" hint="Leave empty until it is live.">
              {(id) => <Input id={id} type="datetime-local" value={draft.deployed_at} onChange={(e) => set('deployed_at', e.target.value)} />}
            </Field>
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input type="checkbox" checked={draft.deployed_estimated} disabled={!draft.deployed_at} onChange={(e) => set('deployed_estimated', e.target.checked)} />
              The time is an estimate
            </label>
          </div>
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Ticket">{(id) => <Input id={id} value={draft.ticket} maxLength={32} placeholder="MUL-102" onChange={(e) => set('ticket', e.target.value)} />}</Field>
            <Field label="PR">{(id) => <Input id={id} value={draft.pr} maxLength={64} placeholder="RN #45" onChange={(e) => set('pr', e.target.value)} />}</Field>
            <Field label="Commit">{(id) => <Input id={id} value={draft.commit_sha} maxLength={40} onChange={(e) => set('commit_sha', e.target.value.trim())} />}</Field>
            <Field label="App version" hint="If it shipped in one">
              {(id) => <Input id={id} value={draft.app_version} maxLength={32} onChange={(e) => set('app_version', e.target.value)} />}
            </Field>
          </div>
          <div className="space-y-2">
            <div className="text-sm font-medium">Numbers it should move</div>
            {draft.expects.map((e, i) => (
              <div key={i} className="flex items-center gap-2">
                <Select
                  aria-label="Metric"
                  value={e.metric}
                  onChange={(ev) => set('expects', draft.expects.map((x, j) => (j === i ? { ...x, metric: ev.target.value } : x)))}
                >
                  <option value="">Choose a number…</option>
                  {(info.data?.metrics ?? []).map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.label}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label="Direction"
                  value={e.direction}
                  onChange={(ev) => set('expects', draft.expects.map((x, j) => (j === i ? { ...x, direction: ev.target.value as Direction } : x)))}
                  className="w-32"
                >
                  <option value="down">down</option>
                  <option value="up">up</option>
                  <option value="flat">unchanged</option>
                </Select>
                <Button size="sm" variant="ghost" icon={<X aria-hidden />} aria-label="Remove" onClick={() => set('expects', draft.expects.filter((_, j) => j !== i))} />
              </div>
            ))}
            {draft.expects.length < 12 && (
              <Button size="sm" icon={<Plus aria-hidden />} onClick={() => set('expects', [...draft.expects, { metric: '', direction: 'down' }])}>
                Add a number
              </Button>
            )}
          </div>
          <Field label="Notes">{(id) => <Textarea id={id} value={draft.notes} maxLength={2000} rows={3} onChange={(e) => set('notes', e.target.value)} />}</Field>
          <ErrorNote error={saveError} />
        </Modal>
      )}
    </Card>
  )
}
