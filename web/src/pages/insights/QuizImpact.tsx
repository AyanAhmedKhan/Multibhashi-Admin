import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowRight, ArrowUp } from 'lucide-react'
import { api } from '../../lib/api'
import { fmtDay, fmtInt } from '../../lib/format'
import { Badge, Card, Empty, ErrorNote, Select, Spinner, Table, Td, type Tone } from '../../components/ui'

/**
 * Before vs after one logged quiz change (docs/QUIZ_OBSERVABILITY.md §7): every stored daily
 * metric over the window before the deploy day and the window after it, with the change, an
 * approximate interval and a verdict. Cost rows appear only with the cost permission.
 */

type Kind = 'count' | 'rate' | 'distribution' | 'cost'
type Verdict = 'better' | 'worse' | 'changed' | 'no_clear_change' | 'too_few' | 'too_early'
interface Side {
  value: number | null
  sample: number
  days: number
  median: number | null
  basis: string | null
}
interface MetricResult {
  key: string
  label: string
  kind: Kind
  source: 'answers' | 'attempts' | 'events' | 'bills'
  unit: string
  better: 'down' | 'up' | 'flat' | 'context'
  how: string
  expected: 'up' | 'down' | 'flat' | null
  before: Side
  after: Side
  change: number | null
  relChange: number | null
  interval: [number, number] | null
  verdict: Verdict
}
interface Window {
  from: string
  to: string
  days: number
}
interface Impact {
  release: { id: number; title: string; deployedAt: string | null; deployedEstimated: boolean }
  segment: string
  windows: { deployDay: string; before: Window; after: Window | null; windowDays: number; skipDays: number } | null
  metrics: MetricResult[]
  segments: { segment: string; answers: number }[]
}
interface ReleaseRow {
  id: number
  title: string
  kind: string
  deployedAt: string | null
}

const SOURCE_LABEL: Record<MetricResult['source'], string> = {
  answers: 'Answers',
  attempts: 'Quiz attempts',
  events: 'In the app',
  bills: 'Cost',
}
const VERDICT: Record<Verdict, { label: string; tone: Tone }> = {
  better: { label: 'Better', tone: 'green' },
  worse: { label: 'Worse', tone: 'red' },
  changed: { label: 'Changed', tone: 'violet' },
  no_clear_change: { label: 'No clear change', tone: 'neutral' },
  too_few: { label: 'Too few answers', tone: 'neutral' },
  too_early: { label: 'Too early', tone: 'neutral' },
}

const segmentLabel = (s: string) => {
  if (s === 'all') return 'All learners'
  const [k, v] = s.split(':')
  const names: Record<string, string> = { ios: 'iPhone / iPad', android: 'Android', desktop: 'Desktop', web: 'Web app', unknown: 'Unknown' }
  if (k === 'os') return `Phone OS: ${names[v] ?? v}`
  if (k === 'device') return `App: ${names[v] ?? v}`
  if (k === 'context') return `Delivery: ${v}`
  if (k === 'app') return `App version ${v}`
  if (k === 'in_app') return 'In-app browsers'
  return s
}

const num = (v: number, digits = 1) => v.toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: 0 })

/** A metric's value as people read it. */
function fmtValue(m: MetricResult, v: number | null) {
  if (v === null) return '—'
  switch (m.kind) {
    case 'rate':
      return `${num(v * 100, 1)}%`
    case 'count':
      return `${fmtInt(Math.round(v))}/day`
    case 'cost':
      return m.unit === '₹' ? `₹${num(v, v < 10 ? 3 : 0)}` : m.unit === 's' ? `${num(v, 1)} s` : num(v, v >= 100 ? 0 : 2)
    case 'distribution':
      return m.unit === 'ms' ? `${num(v / 1000, 1)} s` : `${num(v, 1)}${m.unit === '0–10' ? '' : ` ${m.unit}`}`
  }
}

/** The change: percentage points for shares, the unit for the rest, % for counts. */
function fmtChange(m: MetricResult) {
  if (m.change === null) return '—'
  const sign = m.change > 0 ? '+' : m.change < 0 ? '−' : '±'
  const abs = Math.abs(m.change)
  if (m.kind === 'rate') return `${sign}${num(abs * 100, 1)} pts`
  if (m.kind === 'count') return m.relChange === null ? `${sign}${fmtInt(Math.round(abs))}/day` : `${sign}${num(Math.abs(m.relChange) * 100, 0)}%`
  if (m.kind === 'cost' && m.unit === '₹') return `${sign}₹${num(abs, abs < 10 ? 3 : 0)}`
  if (m.unit === 'ms') return `${sign}${num(abs / 1000, 1)} s`
  return `${sign}${num(abs, abs < 10 ? 2 : 1)}${m.unit === '0–10' || m.kind === 'cost' ? '' : ` ${m.unit}`}`
}

/** The interval in the same units as the change beside it. */
function fmtInterval(m: MetricResult) {
  if (!m.interval) return null
  const f = (x: number) => (m.kind === 'rate' ? `${num(x * 100, 1)}` : m.unit === 'ms' ? num(x / 1000, 1) : num(x, Math.abs(x) < 10 ? 2 : 0))
  const unit = m.kind === 'rate' ? ' pts' : m.kind === 'count' ? '/day' : m.unit === 'ms' || m.unit === 's' ? ' s' : m.unit === '₹' ? ' ₹' : ''
  return `95% range ${f(m.interval[0])} to ${f(m.interval[1])}${unit}`
}

/** The verdict as shown: volumes "change", scores and pass rates are guardrails, new numbers had no "before". */
function verdictOf(m: MetricResult): { label: string; tone: Tone } {
  if (m.before.value === null && m.before.sample === 0) return { label: 'No data before', tone: 'neutral' }
  if (m.verdict === 'changed' && m.kind === 'count') return { label: 'Volume changed', tone: 'blue' }
  if (m.verdict === 'changed' && m.better === 'flat') return { label: 'Guardrail moved', tone: 'amber' }
  return VERDICT[m.verdict]
}

const ARROW = { up: ArrowUp, down: ArrowDown, flat: ArrowRight }

export function QuizImpact() {
  const releases = useQuery({ queryKey: ['quiz-releases'], queryFn: () => api.get<{ releases: ReleaseRow[] }>('insights/quiz-releases') })
  const live = useMemo(() => (releases.data?.releases ?? []).filter((r) => r.deployedAt), [releases.data])
  const [releaseId, setReleaseId] = useState<number | null>(null)
  const [segment, setSegment] = useState('all')
  const [windowDays, setWindowDays] = useState(28)

  // Default: the newest fix that is live, else the newest live change
  useEffect(() => {
    if (releaseId !== null || !live.length) return
    setReleaseId((live.find((r) => r.kind === 'fix') ?? live[0]).id)
  }, [live, releaseId])

  const impact = useQuery({
    queryKey: ['quiz-impact', releaseId, segment, windowDays],
    queryFn: () => api.get<Impact>('insights/quiz-impact', { release: releaseId, segment, window: windowDays }),
    enabled: releaseId !== null,
  })

  const d = impact.data
  const groups = useMemo(() => {
    if (!d) return []
    const expected = d.metrics.filter((m) => m.expected)
    const rest = d.metrics.filter((m) => !m.expected)
    const bySource = (['answers', 'attempts', 'events', 'bills'] as const)
      .map((s) => ({ title: SOURCE_LABEL[s], rows: rest.filter((m) => m.source === s) }))
      .filter((g) => g.rows.length)
    return [...(expected.length ? [{ title: 'Expected to move', rows: expected }] : []), ...bySource]
  }, [d])

  return (
    <Card
      title="Before and after a change"
      description="Each number over the days before the change reached learners, against the days after it (the first few days are skipped while learners update). Ranges are approximate."
      padded={false}
    >
      <div className="flex flex-wrap items-end gap-3 border-b px-5 py-3">
        <label className="min-w-0 flex-1 basis-64 text-sm">
          <span className="mb-1 block font-medium">Change</span>
          <Select value={releaseId ?? ''} onChange={(e) => (setReleaseId(Number(e.target.value)), setSegment('all'))} aria-label="Change">
            {live.map((r) => (
              <option key={r.id} value={r.id}>
                {fmtDay(r.deployedAt!.slice(0, 10))} · {r.title}
              </option>
            ))}
          </Select>
        </label>
        <label className="w-52 text-sm">
          <span className="mb-1 block font-medium">Learners</span>
          <Select value={segment} onChange={(e) => setSegment(e.target.value)} aria-label="Learners">
            <option value="all">All learners</option>
            {(d?.segments ?? [])
              .filter((s) => s.segment !== 'all')
              .map((s) => (
                <option key={s.segment} value={s.segment}>
                  {segmentLabel(s.segment)}
                </option>
              ))}
          </Select>
        </label>
        <label className="w-36 text-sm">
          <span className="mb-1 block font-medium">Window</span>
          <Select value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))} aria-label="Window">
            <option value={14}>14 days</option>
            <option value={28}>28 days</option>
            <option value={56}>56 days</option>
          </Select>
        </label>
      </div>

      {releases.isLoading || (releaseId !== null && impact.isLoading) ? (
        <Spinner />
      ) : releases.error || impact.error ? (
        <ErrorNote error={releases.error ?? impact.error} />
      ) : !live.length ? (
        <Empty title="No live changes yet">A change appears here once its "reached learners" time is set in the log above.</Empty>
      ) : !d || !d.windows ? (
        <Empty title="Not live yet">This change has no "reached learners" time.</Empty>
      ) : (
        <>
          <div className="border-b px-5 py-3 text-sm text-ink-2">
            <b>Before:</b> {fmtDay(d.windows.before.from)} – {fmtDay(d.windows.before.to)} ({d.windows.before.days} days).{' '}
            <b>After:</b>{' '}
            {d.windows.after
              ? `${fmtDay(d.windows.after.from)} – ${fmtDay(d.windows.after.to)} (${d.windows.after.days} of ${d.windows.windowDays} days so far)`
              : `starts ${d.windows.skipDays} days after ${fmtDay(d.windows.deployDay)}; no data yet`}
            .{d.release.deployedEstimated && <> The change's time is an estimate.</>}
          </div>
          {!d.metrics.length ? (
            <Empty title="No stored numbers for these days">Run the daily metrics job for this period.</Empty>
          ) : (
            <>
            {/* Phones: one block per number; the five-column table from md up */}
            <div className="md:hidden">
              {groups.map((g) => (
                <section key={g.title}>
                  <h3 className="bg-muted/60 px-5 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.title}</h3>
                  <ul className="divide-y">
                    {g.rows.map((m) => {
                      const v = verdictOf(m)
                      return (
                        <li key={m.key} className="space-y-1 px-5 py-3">
                          <div className="flex items-start justify-between gap-2">
                            <div className="font-medium">{m.label}</div>
                            <Badge tone={v.tone} className="shrink-0">{v.label}</Badge>
                          </div>
                          <div className="tabular text-sm">
                            {fmtValue(m, m.before.value)} <span className="text-muted-foreground">→</span> {fmtValue(m, m.after.value)}
                            <span className="ml-2 font-semibold">{fmtChange(m)}</span>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {fmtInt(m.before.sample)} before · {fmtInt(m.after.sample)} after
                            {fmtInterval(m) ? ` · ${fmtInterval(m)}` : ''}
                            {m.expected ? ` · expected ${m.expected === 'flat' ? 'unchanged' : m.expected}` : ''}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              ))}
            </div>
            <div className="hidden md:block">
            <Table head={['Number', 'Before', 'After', 'Change', 'Verdict']}>
              {groups.flatMap((g) => [
                <tr key={`h-${g.title}`}>
                  <td colSpan={5} className="bg-muted/60 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {g.title}
                  </td>
                </tr>,
                ...g.rows.map((m) => {
                  const v = verdictOf(m)
                  const Expected = m.expected ? ARROW[m.expected] : null
                  return (
                    <tr key={m.key} className="align-top">
                      <Td>
                        <div className="font-medium" title={m.how}>
                          {m.label}
                        </div>
                        {Expected && (
                          <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                            <Expected className="size-3" aria-hidden /> expected {m.expected === 'flat' ? 'unchanged' : m.expected}
                          </div>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap tabular">
                        {fmtValue(m, m.before.value)}
                        <div className="text-xs text-muted-foreground">
                          {m.kind === 'distribution' && m.before.median !== null ? `median ${fmtValue(m, m.before.median)} · ` : ''}
                          {fmtInt(m.before.sample)}
                        </div>
                      </Td>
                      <Td className="whitespace-nowrap tabular">
                        {fmtValue(m, m.after.value)}
                        <div className="text-xs text-muted-foreground">
                          {m.kind === 'distribution' && m.after.median !== null ? `median ${fmtValue(m, m.after.median)} · ` : ''}
                          {fmtInt(m.after.sample)}
                        </div>
                      </Td>
                      <Td className="whitespace-nowrap tabular">
                        {fmtChange(m)}
                        {fmtInterval(m) && <div className="text-xs text-muted-foreground">{fmtInterval(m)}</div>}
                      </Td>
                      <Td>
                        <Badge tone={v.tone}>{v.label}</Badge>
                        {(m.after.basis === 'estimated' || m.before.basis === 'estimated') && <div className="mt-1 text-xs text-muted-foreground">includes estimated days</div>}
                      </Td>
                    </tr>
                  )
                }),
              ])}
            </Table>
            </div>
            </>
          )}
          <p className="px-5 py-3 text-xs text-muted-foreground">
            Shares are compared in percentage points; counts per day; costs as total spend ÷ total answers. "Changed" marks numbers where more is not simply better or worse (a
            longer answer costs more); "Guardrail moved" marks scores and pass rates that a fix should leave alone. Verdicts need at least 7 days after the change and 200
            answers on each side.
          </p>
        </>
      )}
    </Card>
  )
}
