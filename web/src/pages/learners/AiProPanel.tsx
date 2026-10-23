import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarPlus, Crown, Eye, StopCircle } from 'lucide-react'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { fmtDateTime, fmtInt } from '../../lib/format'
import { useReason } from '../../components/dialogs'
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Select, Spinner, Table, Td } from '../../components/ui'

interface AiProState {
  plans: { id: number; course: string | null; level: string | null; package: string | null; expiresAt: number | null; active: boolean; kind: 'paid' | 'console' | 'complimentary' }[]
  grants: {
    id: number
    level: string
    lessons: string
    minutesPerCard: number
    cardsGranted: number
    minutesTotal: number
    subscriptionsCreated: number
    expiresAt: number
    status: 'active' | 'ended' | 'expired'
    grantedBy: string | null
    reason: string
    endReason: string | null
    createdAt: string
  }[]
  activeLessonSubscriptions: number
}

interface Preview {
  lessons: number
  cardCount: number
  minutesTotal: number
  skippedAlready: number
  skippedNoCard: number
  activePlan: { id: number; package: string; expiresAt: number } | null
  createsPlan: boolean
  subscriptionsToCreate: number
  expiresAt: number
  needsApproval: boolean
  cards: { lesson_no: number; lesson_name: string; previous_total: number; new_total: number; existing_chat_id: number | null }[]
}

const KIND: Record<string, { label: string; tone: 'green' | 'violet' | 'neutral' }> = {
  paid: { label: 'Paid', tone: 'green' },
  console: { label: 'Given in console', tone: 'violet' },
  complimentary: { label: 'Free (other)', tone: 'neutral' },
}

/** AI Pro access for one learner: what they have, and giving / extending / ending it without payment. */
export function AiProPanel({ learnerId }: { learnerId: number }) {
  const { can } = useAuth()
  const ask = useReason()
  const queryClient = useQueryClient()
  const state = useQuery({ queryKey: ['ai-pro', learnerId], queryFn: () => api.get<AiProState>(`learners/${learnerId}/ai-pro`) })
  const [open, setOpen] = useState(false)
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['ai-pro', learnerId] })
    queryClient.invalidateQueries({ queryKey: ['learner', String(learnerId)] })
  }

  const extend = (grantId: number) => {
    let days = 7
    ask({
      title: 'Extend AI Pro',
      description: 'Adds days to the plan and the lesson access this grant created.',
      extra: (
        <Field label="Days to add">
          {(id) => <Input id={id} type="number" min={1} defaultValue={7} onChange={(e) => (days = Number(e.target.value))} />}
        </Field>
      ),
      confirmLabel: 'Extend',
      run: async (reason) => {
        await api.post(`ai-pro/${grantId}/extend`, { days, reason })
        refresh()
      },
    })
  }

  const end = (grantId: number) => {
    let remove = true
    ask({
      title: 'End AI Pro now',
      description: 'The plan and lesson access from this grant end immediately. Paid access is not affected.',
      extra: (
        <label className="flex items-start gap-2 text-sm text-ink-2">
          <input type="checkbox" defaultChecked className="mt-1" onChange={(e) => (remove = e.target.checked)} />
          Also take back minutes from this grant that are still unused (used minutes are never taken back).
        </label>
      ),
      confirmLabel: 'End access',
      danger: true,
      run: async (reason) => {
        await api.post(`ai-pro/${grantId}/end`, { remove_unused_minutes: remove, reason })
        refresh()
      },
    })
  }

  const active = state.data?.plans.filter((p) => p.active) ?? []
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Crown className="size-4 text-warning" aria-hidden /> AI Pro access
        </span>
      }
      actions={
        can('tutor.access.grant') && (
          <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
            Give AI Pro
          </Button>
        )
      }
    >
      <ErrorNote error={state.error} />
      {state.isLoading ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-ink-2">
            {active.length ? (
              <>
                Active on <b>{active.length}</b> course level{active.length > 1 ? 's' : ''}; {fmtInt(state.data?.activeLessonSubscriptions)} unlocked lessons.
              </>
            ) : (
              'No active AI Pro plan: lessons after 2 show the paywall.'
            )}
          </p>
          {!!state.data?.plans.length && (
            <Table head={['Course / level', 'Plan', 'Kind', 'Until']}>
              {state.data.plans.map((p) => (
                <tr key={p.id}>
                  <Td>
                    {p.course ?? '—'} <span className="text-muted-foreground">· {p.level ?? '—'}</span>
                  </Td>
                  <Td>{p.package ?? '—'}</Td>
                  <Td>
                    <Badge tone={KIND[p.kind].tone}>{KIND[p.kind].label}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap">
                    {p.expiresAt ? fmtDateTime(new Date(p.expiresAt)) : '—'} {!p.active && <Badge>ended</Badge>}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          {!!state.data?.grants.length && (
            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Given in the console</div>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {state.data.grants.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                    <div className="min-w-0">
                      <div className="font-medium">
                        {g.level} · lessons {g.lessons}{' '}
                        <Badge tone={g.status === 'active' ? 'green' : 'neutral'}>{g.status}</Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {g.minutesTotal} min on {g.cardsGranted} cards · {g.subscriptionsCreated} lessons unlocked · until {fmtDateTime(new Date(g.expiresAt))} · by {g.grantedBy ?? '—'}
                      </div>
                      <div className="text-xs text-muted-foreground">“{g.reason}”{g.endReason ? ` · ended: “${g.endReason}”` : ''}</div>
                    </div>
                    {g.status === 'active' && can('tutor.access.revoke') && (
                      <div className="flex gap-2">
                        <Button size="sm" icon={<CalendarPlus className="size-4" />} onClick={() => extend(g.id)}>
                          Extend
                        </Button>
                        <Button size="sm" variant="ghost" icon={<StopCircle className="size-4" />} onClick={() => end(g.id)}>
                          End
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {open && <GiveAiPro learnerId={learnerId} onClose={() => setOpen(false)} onDone={refresh} />}
    </Card>
  )
}

function GiveAiPro({ learnerId, onClose, onDone }: { learnerId: number; onClose: () => void; onDone: () => void }) {
  const { me } = useAuth()
  const ask = useReason()
  const [courseId, setCourseId] = useState('')
  const [level, setLevel] = useState('')
  const [from, setFrom] = useState('1')
  const [to, setTo] = useState('10')
  const [minutes, setMinutes] = useState('30')
  const [days, setDays] = useState('30')
  const [withPlan, setWithPlan] = useState(true)
  const [withAccess, setWithAccess] = useState(true)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  const courses = useQuery({ queryKey: ['ai-pro-courses'], queryFn: () => api.get<{ courses: { id: number; name: string }[] }>('tutor/ai-pro/catalog') })
  const catalog = useQuery({
    queryKey: ['ai-pro-catalog', courseId],
    queryFn: () =>
      api.get<{ levels: { level: string; lessons: number; first: number; last: number }[]; packages: { id: number; name: string; ai_chat_duration: number }[] }>('tutor/ai-pro/catalog', { courseId }),
    enabled: !!courseId,
  })

  const body = () => ({
    course_id: Number(courseId),
    level_name: level,
    from_lesson: Number(from),
    to_lesson: Number(to),
    minutes_per_card: Number(minutes),
    validity_days: Number(days),
    with_plan: withPlan,
    with_access: withAccess,
  })

  const runPreview = async () => {
    setBusy(true)
    setError(null)
    try {
      setPreview(await api.post<Preview>(`learners/${learnerId}/ai-pro/preview`, body()))
    } catch (err) {
      setError(err)
      setPreview(null)
    } finally {
      setBusy(false)
    }
  }

  const confirm = () =>
    ask({
      title: preview?.needsApproval ? 'Request AI Pro approval' : 'Give AI Pro without payment',
      description: preview?.needsApproval
        ? 'This is above the direct limit, so a second person (an Ops Manager, Finance or a Super Admin) approves it first.'
        : 'Written now. The learner sees AI Pro the next time the app loads their course.',
      confirmLabel: preview?.needsApproval ? 'Request approval' : 'Give AI Pro',
      run: async (reason) => {
        const res = await api.post<{ status: string; approvalId?: number; minutes_total?: number }>(`learners/${learnerId}/ai-pro`, { ...body(), reason })
        setDone(res.status === 'pending_approval' ? `Approval request #${res.approvalId} created.` : `Done: AI Pro is on (${res.minutes_total} minutes added).`)
        onDone()
      },
    })

  const levels = catalog.data?.levels ?? []
  return (
    <Modal open title="Give AI Pro (no payment)" onClose={onClose} wide footer={
      done ? (
        <Button variant="primary" onClick={onClose}>Close</Button>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button icon={<Eye className="size-4" />} loading={busy} disabled={!courseId || !level} onClick={runPreview}>Preview</Button>
          <Button variant="primary" disabled={!preview} onClick={confirm}>{preview?.needsApproval ? 'Request approval' : 'Give AI Pro'}</Button>
        </>
      )
    }>
      {done ? (
        <p className="text-sm text-success">{done}</p>
      ) : (
        <>
          <p className="text-sm text-ink-2">
            The same three switches the app checks: the <b>AI plan</b> (removes the paywall after lesson 2), <b>lesson access</b> (unlocks lessons 5+), and{' '}
            <b>minutes</b> on each lesson’s PDF learn card. Up to {me?.policy.aiProMaxDays} days and {fmtInt(me?.policy.aiProMaxMinutes)} minutes it runs at
            once; anything longer or bigger needs a second approver.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Course">
              {(id) => (
                <Select id={id} value={courseId} onChange={(e) => (setCourseId(e.target.value), setLevel(''), setPreview(null))}>
                  <option value="">Choose…</option>
                  {(courses.data?.courses ?? []).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Level">
              {(id) => (
                <Select
                  id={id}
                  value={level}
                  disabled={!courseId}
                  onChange={(e) => {
                    const l = levels.find((x) => x.level === e.target.value)
                    setLevel(e.target.value)
                    if (l) (setFrom(String(l.first ?? 1)), setTo(String(l.last ?? 1)))
                    setPreview(null)
                  }}
                >
                  <option value="">Choose…</option>
                  {levels.map((l) => (
                    <option key={l.level} value={l.level}>{l.level} ({l.lessons} lessons)</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="From lesson">{(id) => <Input id={id} type="number" min={0} value={from} onChange={(e) => (setFrom(e.target.value), setPreview(null))} />}</Field>
            <Field label="To lesson">{(id) => <Input id={id} type="number" min={0} value={to} onChange={(e) => (setTo(e.target.value), setPreview(null))} />}</Field>
            <Field label="AI minutes per lesson card" hint="0 = access only, no minutes">
              {(id) => <Input id={id} type="number" min={0} max={600} value={minutes} onChange={(e) => (setMinutes(e.target.value), setPreview(null))} />}
            </Field>
            <Field label="Valid for (days)">{(id) => <Input id={id} type="number" min={1} max={730} value={days} onChange={(e) => (setDays(e.target.value), setPreview(null))} />}</Field>
          </div>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={withPlan} onChange={(e) => (setWithPlan(e.target.checked), setPreview(null))} /> AI plan (paywall off)</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={withAccess} onChange={(e) => (setWithAccess(e.target.checked), setPreview(null))} /> Lesson access</label>
          </div>
          <ErrorNote error={error} />
          {preview && (
            <div className="rounded-lg border border-border bg-muted p-3 text-sm">
              <div className="font-medium">What will be written</div>
              <ul className="mt-1 list-inside list-disc space-y-0.5 text-ink-2">
                <li>{preview.lessons} lessons matched; {preview.cardCount} cards get {minutes} min each = <b>{fmtInt(preview.minutesTotal)} min</b></li>
                {preview.skippedAlready > 0 && <li>{preview.skippedAlready} cards skipped: already given AI Pro minutes</li>}
                {preview.skippedNoCard > 0 && <li>{preview.skippedNoCard} lessons have no PDF learn card</li>}
                <li>
                  AI plan:{' '}
                  {preview.createsPlan ? 'a new complimentary plan' : preview.activePlan ? `already active (${preview.activePlan.package} until ${fmtDateTime(new Date(preview.activePlan.expiresAt))})` : 'not included'}
                </li>
                <li>Lesson access: {preview.subscriptionsToCreate} lessons to unlock</li>
                <li>Valid until {fmtDateTime(new Date(preview.expiresAt))}</li>
              </ul>
              {preview.needsApproval && <p className="mt-2"><Badge tone="amber">Needs a second approver</Badge></p>}
            </div>
          )}
        </>
      )}
    </Modal>
  )
}
