import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { CircleCheck, CircleDashed, ExternalLink, RefreshCw, TriangleAlert } from 'lucide-react'
import { api, ApiError } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { fmtAgo, fmtDateTime, fmtDay, fmtInt, inrSmall, inr } from '../../lib/format'
import { Badge, Button, Card, Empty, ErrorNote, Spinner, Stat, Table, Td } from '../../components/ui'
import { Bars, ChartCard } from '../../components/charts'

type Basis = 'actual' | 'usage' | 'estimated'
type Path = 'legacy' | 'counted' | 'evidence'
interface Summary {
  count: number
  mean: number | null
  median: number | null
  p95: number | null
}
interface ProviderRun {
  at: string
  ok: boolean
  error: string | null
  rows: number
  days: number
  dataThrough: string | null
  demo?: boolean
}
interface ProviderStatus {
  openai: { connected: boolean; missing: string[]; filters: { projectIds: string[]; apiKeyIds: string[] }; lastRun: ProviderRun | null; earliestDay: string | null; latestDay: string | null }
  google: { connected: boolean; missing: string[]; problem: string | null; projectId: string | null; lastRun: ProviderRun | null; earliestDay: string | null; latestDay: string | null }
}
interface QuizCost {
  days: number
  empty: 'no_tables' | 'no_answers' | null
  providers: ProviderStatus
  usdToInr: number
  priceLines: { id: string; label: string; provider: string; model: string; unit: string; price: number; currency: string; per: number; source?: string }[]
  unpriced: string[]
  totals: {
    totalInr: number
    actualInr: number
    estimatedInr: number
    speechInr: number
    markingInr: number
    speechActualInr: number
    markingActualInr: number
    unallocatedInr: number
    answers: number
    sq: number
    wq: number
    actualAnswers: number
    monthlyRunRateInr: number
  }
  perAnswer: Record<'SQ' | 'WQ', Summary & { speech: number | null; marking: number | null; actualAnswers: number; actualOnly: Summary }>
  byPath: (Summary & { type: 'SQ' | 'WQ'; path: Path; avgInputTokens: number | null; avgOutputTokens: number | null; avgCalls: number | null; avgSpeechSeconds: number | null; recordedShare: number | null })[]
  series: { day: string; sq: number; wq: number; speechInr: number; markingInr: number; speechBasis: Basis; markingBasis: Basis; estimatedSpeechInr: number; estimatedMarkingInr: number; unallocatedInr: number }[]
  topQuizzes: { quizId: number; name: string | null; answers: number; costInr: number; actual: number; perAnswerInr: number }[]
  topLearners: { userId: number; answers: number; costInr: number; actual: number; perAnswerInr: number }[]
  providerItems: { provider: string; scope: string; item: string; unit: string; quantity: number; costInr: number; counted: string }[]
  calibration: {
    marking: { days: number; estimatedCalls: number; actualRequests: number; estimatedInputTokens: number; actualInputTokens: number; estimatedOutputTokens: number; actualOutputTokens: number } | null
    speech: { days: number; estimatedSeconds: number; billedQuantity: number; billedUnits: string[] } | null
  }
}

export const PATH_LABEL: Record<Path, string> = {
  legacy: 'Legacy (one 0–10 prompt)',
  counted: 'Counted (scoring v2)',
  evidence: 'Evidence (3 calls, scoring v3)',
}
const TYPE_LABEL = { SQ: 'Speaking', WQ: 'Writing' } as const

function BasisBadge({ basis }: { basis: Basis }) {
  return basis === 'estimated' ? <Badge tone="amber">estimated</Badge> : basis === 'usage' ? <Badge tone="blue">usage × price</Badge> : <Badge tone="green">billed</Badge>
}

/** 1.2K, 3.4M, 1.0B: provider quantities span byte-seconds to requests. */
export const qty = (v: number) =>
  v >= 1e9 ? `${(v / 1e9).toLocaleString('en-IN', { maximumFractionDigits: 1 })}B` : v >= 1e6 ? `${(v / 1e6).toLocaleString('en-IN', { maximumFractionDigits: 1 })}M` : v >= 1e4 ? `${(v / 1e3).toLocaleString('en-IN', { maximumFractionDigits: 1 })}K` : fmtInt(Math.round(v))

const ratio = (est: number, actual: number) => (actual ? `${Math.round((est / actual) * 100)}%` : '—')

function ProviderRow({ name, what, connected, missing, problem, lastRun, detail, through }: {
  name: string
  what: string
  connected: boolean
  missing: string[]
  problem?: string | null
  lastRun: ProviderRun | null
  detail: string
  through: string | null
}) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          {connected ? (
            lastRun && !lastRun.ok ? <TriangleAlert className="size-4 text-warning" aria-hidden /> : <CircleCheck className="size-4 text-success" aria-hidden />
          ) : (
            <CircleDashed className="size-4 text-muted-foreground" aria-hidden />
          )}
          {name}
          <span className="font-normal text-muted-foreground">· {what}</span>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {connected ? detail : problem ? problem : `Not connected: set ${missing.join(', ')} (deploy/.env.production).`}
        </div>
        {lastRun && !lastRun.ok && lastRun.error && <div className="mt-1 max-w-2xl text-xs text-warning">Last sync failed: {lastRun.error}</div>}
      </div>
      <div className="text-right text-xs text-muted-foreground">
        {connected ? <Badge tone={lastRun?.ok === false ? 'amber' : 'green'}>{lastRun ? (lastRun.ok ? 'connected' : 'sync failed') : 'not synced yet'}</Badge> : <Badge>not connected</Badge>}
        {lastRun?.demo && <Badge tone="violet" className="ml-1">demo rows</Badge>}
        {lastRun && <div className="mt-1">synced {fmtAgo(lastRun.at)}</div>}
        {through && <div>data through {fmtDateTime(through)}</div>}
      </div>
    </li>
  )
}

export function QuizCostSection({ days }: { days: number }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)
  const q = useQuery({ queryKey: ['insights-quiz-cost', days], queryFn: () => api.get<QuizCost>('insights/quiz-cost', { days }) })
  if (q.isLoading) return <Spinner />
  if (q.error || !q.data) return <ErrorNote error={q.error} />
  const d = q.data
  const manage = can('analytics.costs.manage')
  const p = d.providers
  const connected = p.openai.connected || p.google.connected

  const refresh = async () => {
    setRefreshing(true)
    try {
      const res = await api.post<{ result: Record<'openai' | 'google', { connected?: false; ok?: boolean; rows?: number; error?: string | null }> }>('insights/quiz-providers/refresh', { days: Math.min(days, 90) })
      const parts = (['openai', 'google'] as const).map((k) => {
        const r = res.result[k]
        const name = k === 'openai' ? 'OpenAI' : 'Google'
        return r.connected === false ? `${name}: not connected` : r.ok ? `${name}: ${fmtInt(r.rows ?? 0)} rows` : `${name}: failed`
      })
      const failed = (['openai', 'google'] as const).some((k) => res.result[k].ok === false)
      if (failed) toast.warning(`Refresh finished with errors. ${parts.join(' · ')}`)
      else toast.success(`Provider data refreshed. ${parts.join(' · ')}`)
      await queryClient.invalidateQueries({ queryKey: ['insights-quiz-cost'] })
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }

  const providerCard = (
    <Card
      title="Provider data"
      description="What OpenAI and Google themselves report, synced daily (quiz:sync-provider-usage) and on Refresh."
      actions={
        manage && (
          <Button size="sm" icon={<RefreshCw className="size-4" />} loading={refreshing} onClick={refresh} disabled={!connected} title={connected ? undefined : 'No provider is connected'}>
            Refresh
          </Button>
        )
      }
    >
      <ul className="divide-y">
        <ProviderRow
          name="OpenAI"
          what="marking (Usage + Costs API)"
          connected={p.openai.connected}
          missing={p.openai.missing}
          lastRun={p.openai.lastRun}
          through={p.openai.lastRun?.dataThrough ?? null}
          detail={
            p.openai.filters.projectIds.length || p.openai.filters.apiKeyIds.length
              ? `Quiz scope: ${[...p.openai.filters.projectIds, ...p.openai.filters.apiKeyIds].join(', ')}${p.openai.earliestDay ? ` · days ${fmtDay(p.openai.earliestDay)} – ${fmtDay(p.openai.latestDay!)}` : ''}`
              : `Whole organisation (set OPENAI_QUIZ_PROJECT_ID / OPENAI_QUIZ_API_KEY_IDS to narrow it to the quiz backend)${p.openai.earliestDay ? ` · days ${fmtDay(p.openai.earliestDay)} – ${fmtDay(p.openai.latestDay!)}` : ''}`
          }
        />
        <ProviderRow
          name="Google Cloud"
          what="speech-to-text (billing export)"
          connected={p.google.connected}
          missing={p.google.missing}
          problem={p.google.problem}
          lastRun={p.google.lastRun}
          through={p.google.lastRun?.dataThrough ?? null}
          detail={`Project ${p.google.projectId}${p.google.earliestDay ? ` · days ${fmtDay(p.google.earliestDay)} – ${fmtDay(p.google.latestDay!)}` : ' · no rows yet (the export lags by hours to a day)'}`}
        />
      </ul>
    </Card>
  )

  if (d.empty) {
    return (
      <div className="space-y-6">
        {providerCard}
        <Card>
          <Empty title={d.empty === 'no_tables' ? 'The quiz answer tables aren’t in this database' : `No Speaking or Writing answers in the last ${days} days`}>
            {d.empty === 'no_tables'
              ? 'user_quiz_log_details, webinar_class_quiz_log_details and session_call_quiz_log_details were not found, so there is nothing to cost.'
              : 'Cost per answer appears once learners answer SQ or WQ questions. Provider spend still shows above once a provider is connected.'}
          </Empty>
        </Card>
      </div>
    )
  }

  const t = d.totals
  const allEstimated = t.actualInr === 0 && t.estimatedInr > 0
  const series = d.series.map((s) => ({ ...s, speechEstimated: s.speechBasis === 'estimated', markingEstimated: s.markingBasis === 'estimated' }))
  const answerStat = (type: 'SQ' | 'WQ') => {
    const s = d.perAnswer[type]
    if (!s.count) return <Stat label={`Cost per ${TYPE_LABEL[type]} answer`} value="—" hint={`no ${TYPE_LABEL[type]} answers in this period`} />
    const share = Math.round((s.actualAnswers / s.count) * 100)
    return (
      <Stat
        label={`Cost per ${TYPE_LABEL[type]} answer (mean)`}
        value={inrSmall(s.mean)}
        hint={
          <>
            median {inrSmall(s.median)} · p95 {inrSmall(s.p95)} · {fmtInt(s.count)} answers
            <br />
            {share === 100 ? 'all from provider bills' : share === 0 ? 'estimated (no provider data for these days)' : `${share}% from provider bills, the rest estimated`}
            {type === 'SQ' && s.count ? ` · speech ${inrSmall(s.speech)} + marking ${inrSmall(s.marking)}` : ''}
          </>
        }
      />
    )
  }

  return (
    <div className="space-y-6">
      {allEstimated ? (
        <div className="rounded-lg border border-border bg-warning-soft px-3 py-2 text-sm text-warning">
          <b>Estimated.</b> {connected ? 'The providers haven’t reported these days yet' : 'No provider is connected'}, so every figure below is each answer’s
          estimated usage × the price list. Connect OpenAI and the GCP billing export (below) for billed figures.
        </div>
      ) : t.estimatedInr > 0 ? (
        <div className="rounded-lg border border-border bg-success-soft px-3 py-2 text-sm text-success">
          <b>{inr(t.actualInr, 2)} from provider bills</b>, {inr(t.estimatedInr, 2)} estimated for days the providers haven’t reported (marked “estimated”).
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-success-soft px-3 py-2 text-sm text-success">
          <b>All from provider bills.</b> Each day’s actual cost is spread over that day’s answers by length and marking path.
        </div>
      )}
      {d.unpriced.length > 0 && (
        <div className="rounded-lg border border-border bg-danger-soft px-3 py-2 text-sm text-danger">
          OpenAI usage without a price: {d.unpriced.join(', ')}. Days priced from usage count it as ₹0 until a price is added.
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {answerStat('SQ')}
        {answerStat('WQ')}
        <Stat label={`Quiz AI spend, ${days} days`} value={inr(t.totalInr, 2)} hint={`${inr(t.actualInr, 2)} billed · ${inr(t.estimatedInr, 2)} estimated · run-rate ${inr(t.monthlyRunRateInr)}/month`} />
        <Stat
          label="Speech-to-text · marking"
          value={<span className="text-xl">{inr(t.speechInr, 2)} · {inr(t.markingInr, 2)}</span>}
          hint={`${fmtInt(t.sq)} Speaking, ${fmtInt(t.wq)} Writing answers${t.unallocatedInr > 0.005 ? ` · ${inr(t.unallocatedInr, 2)} billed on days without answers` : ''}`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard
          title="Speech-to-text per day"
          subtitle="Google, Speaking answers. Hatched = estimated (no billing export for that day)."
          rows={series}
          columns={[
            { key: 'day', label: 'Day', format: (v) => fmtDay(String(v)) },
            { key: 'speechInr', label: 'Cost', format: (v, row) => (row.speechBasis === 'estimated' && !row.sq ? '—' : inrSmall(Number(v))) },
            { key: 'speechBasis', label: 'Basis', format: (v) => <BasisBadge basis={v as Basis} /> },
            { key: 'sq', label: 'Speaking answers' },
          ]}
        >
          <Bars data={series} x="day" y="speechInr" hatched="speechEstimated" xFormat={fmtDay} yFormat={(v) => inrSmall(v)} label="" yDecimals />
        </ChartCard>
        <ChartCard
          title="Marking per day"
          subtitle="OpenAI, Speaking and Writing answers. Hatched = estimated (no OpenAI data for that day)."
          rows={series}
          columns={[
            { key: 'day', label: 'Day', format: (v) => fmtDay(String(v)) },
            { key: 'markingInr', label: 'Cost', format: (v, row) => (row.markingBasis === 'estimated' && !row.sq && !row.wq ? '—' : inrSmall(Number(v))) },
            { key: 'markingBasis', label: 'Basis', format: (v) => <BasisBadge basis={v as Basis} /> },
            { key: 'wq', label: 'Writing answers' },
          ]}
        >
          <Bars data={series} x="day" y="markingInr" hatched="markingEstimated" xFormat={fmtDay} yFormat={(v) => inrSmall(v)} label="" yDecimals />
        </ChartCard>
      </div>

      <Card title="Cost per answer by marking path" padded={false}>
        <Table head={['Answers', 'Marking path', 'Count', 'Mean', 'Median', 'p95', 'Calls', 'Tokens in / out', 'Speech']}>
          {d.byPath.map((r) => (
            <tr key={`${r.type}-${r.path}`}>
              <Td className="font-medium">{TYPE_LABEL[r.type]}</Td>
              <Td>{PATH_LABEL[r.path]}</Td>
              <Td className="tabular">{fmtInt(r.count)}</Td>
              <Td className="tabular font-medium">{inrSmall(r.mean)}</Td>
              <Td className="tabular">{inrSmall(r.median)}</Td>
              <Td className="tabular">{inrSmall(r.p95)}</Td>
              <Td className="tabular">{r.avgCalls === null ? '—' : r.avgCalls.toFixed(1)}</Td>
              <Td className="tabular whitespace-nowrap">{fmtInt(Math.round(r.avgInputTokens ?? 0))} / {fmtInt(Math.round(r.avgOutputTokens ?? 0))}</Td>
              <Td className="tabular whitespace-nowrap">
                {r.avgSpeechSeconds === null ? '—' : `${Math.round(r.avgSpeechSeconds)} s`}
                {r.recordedShare !== null && <div className="text-xs text-muted-foreground">{r.recordedShare}% measured in the app</div>}
              </Td>
            </tr>
          ))}
        </Table>
        <p className="px-4 py-3 text-xs text-muted-foreground">
          Each day’s bill is spread over its answers in proportion to estimated usage: speech by billed seconds (the app’s recorded length, else words ÷ 2.3, 1–58 s);
          marking by tokens for the path and the answer’s length (evidence = grammar, independent review and content calls, repeated on a retry). Calls and tokens are those
          estimates; totals per day are exact when billed.
        </p>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Most expensive quizzes" padded={false}>
          <Table head={['Quiz', 'Answers', 'Cost', 'Per answer']}>
            {d.topQuizzes.map((r) => (
              <tr key={r.quizId}>
                <Td>
                  <span className="font-medium">{r.name ?? `Quiz #${r.quizId}`}</span>
                  <div className="text-xs text-muted-foreground">#{r.quizId}{r.actual < r.answers ? ` · ${fmtInt(r.answers - r.actual)} estimated` : ''}</div>
                </Td>
                <Td className="tabular">{fmtInt(r.answers)}</Td>
                <Td className="tabular">{inrSmall(r.costInr)}</Td>
                <Td className="tabular">{inrSmall(r.perAnswerInr)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Most expensive learners" padded={false}>
          <Table head={['Learner', 'Answers', 'Cost', 'Per answer']}>
            {d.topLearners.map((r) => (
              <tr key={r.userId}>
                <Td>
                  <Link className="font-medium text-primary" to={`/learners/${r.userId}`}>#{r.userId}</Link>
                  {r.actual < r.answers && <div className="text-xs text-muted-foreground">{fmtInt(r.answers - r.actual)} estimated</div>}
                </Td>
                <Td className="tabular">{fmtInt(r.answers)}</Td>
                <Td className="tabular">{inrSmall(r.costInr)}</Td>
                <Td className="tabular">{inrSmall(r.perAnswerInr)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      {providerCard}

      <div className="grid gap-6">
        <Card title="What the providers reported" padded={false}>
          {d.providerItems.length ? (
            <Table head={['Line', 'Usage', 'Cost', 'Counted as']}>
              {d.providerItems.slice(0, 15).map((r, i) => (
                <tr key={i}>
                  <Td>
                    <span className="text-sm">{r.item}</span>
                    <div className="text-xs text-muted-foreground">{r.provider === 'openai' ? 'OpenAI' : 'Google'} · {r.scope}</div>
                  </Td>
                  <Td className="tabular whitespace-nowrap">{qty(r.quantity)} {r.unit}</Td>
                  <Td className="tabular">{r.costInr ? inrSmall(r.costInr) : '—'}</Td>
                  <Td>{r.counted === 'not quiz (shown only)' || r.counted === 'other project' ? <Badge>{r.counted}</Badge> : <Badge tone="blue">{r.counted}</Badge>}</Td>
                </tr>
              ))}
            </Table>
          ) : (
            <p className="p-5 text-sm text-muted-foreground">
              {connected ? 'Nothing synced for this period yet. Refresh, or wait for the daily sync.' : 'No provider is connected, so there is nothing the providers reported.'}
            </p>
          )}
          <p className="px-4 py-3 text-xs text-muted-foreground">
            Google speech-to-text is the speech project’s SKUs named “…Recognition…” (as on Google’s price page); other SKUs of the project are listed but not counted.
          </p>
        </Card>
        <Card title="Estimates vs provider counts" padded={false}>
          {d.calibration.marking || d.calibration.speech ? (
            <Table head={['Measure', 'Estimated', 'Provider', 'Estimate / provider']}>
              {d.calibration.marking && (
                <>
                  <tr>
                    <Td>OpenAI calls ({d.calibration.marking.days} days)</Td>
                    <Td className="tabular">{fmtInt(Math.round(d.calibration.marking.estimatedCalls))}</Td>
                    <Td className="tabular">{fmtInt(Math.round(d.calibration.marking.actualRequests))}</Td>
                    <Td className="tabular">{ratio(d.calibration.marking.estimatedCalls, d.calibration.marking.actualRequests)}</Td>
                  </tr>
                  <tr>
                    <Td>Input tokens</Td>
                    <Td className="tabular">{fmtInt(Math.round(d.calibration.marking.estimatedInputTokens))}</Td>
                    <Td className="tabular">{fmtInt(Math.round(d.calibration.marking.actualInputTokens))}</Td>
                    <Td className="tabular">{ratio(d.calibration.marking.estimatedInputTokens, d.calibration.marking.actualInputTokens)}</Td>
                  </tr>
                  <tr>
                    <Td>Output tokens</Td>
                    <Td className="tabular">{fmtInt(Math.round(d.calibration.marking.estimatedOutputTokens))}</Td>
                    <Td className="tabular">{fmtInt(Math.round(d.calibration.marking.actualOutputTokens))}</Td>
                    <Td className="tabular">{ratio(d.calibration.marking.estimatedOutputTokens, d.calibration.marking.actualOutputTokens)}</Td>
                  </tr>
                </>
              )}
              {d.calibration.speech && (
                <tr>
                  <Td>Speech audio ({d.calibration.speech.days} days, {d.calibration.speech.billedUnits.join(', ')})</Td>
                  <Td className="tabular">{fmtInt(Math.round(d.calibration.speech.estimatedSeconds))} s</Td>
                  <Td className="tabular">{fmtInt(Math.round(d.calibration.speech.billedQuantity))}</Td>
                  <Td className="tabular">{d.calibration.speech.billedUnits.every((u) => u === 'seconds') ? ratio(d.calibration.speech.estimatedSeconds, d.calibration.speech.billedQuantity) : '—'}</Td>
                </tr>
              )}
            </Table>
          ) : (
            <p className="p-5 text-sm text-muted-foreground">Once providers report usage, the estimated calls, tokens and seconds are compared with theirs here. A big gap means the weights need tuning or the key is shared with something else.</p>
          )}
        </Card>
      </div>

      <Card title="Quiz price lines" padded={false}>
        <Table head={['Service', 'Provider · model · unit', 'Price', 'Source']}>
          {d.priceLines.map((l) => (
            <tr key={l.id}>
              <Td>{l.label}</Td>
              <Td className="text-xs text-ink-2">{l.provider} · {l.model} · {l.unit}</Td>
              <Td className="tabular whitespace-nowrap">{l.currency === 'USD' ? '$' : '₹'}{l.price} / {fmtInt(l.per)}</Td>
              <Td>{l.source ? <a className="inline-flex items-center gap-1 text-primary" href={l.source} target="_blank" rel="noreferrer noopener">pricing <ExternalLink className="size-3" aria-hidden /></a> : '—'}</Td>
            </tr>
          ))}
        </Table>
        <p className="px-4 py-3 text-xs text-muted-foreground">
          Standard list prices, USD → INR {d.usdToInr}. Used for estimates and to weigh a day’s bill across answers; edit them in the AI tutor section’s price list. Limits: per-answer figures are
          allocated from daily bills (the backend doesn’t record individual calls); daily and monthly totals are exact for billed days; if the quiz OpenAI key is shared, its other
          usage is included unless OPENAI_QUIZ_API_KEY_IDS narrows it; the billing export starts on the day it was enabled and lags by hours to a day; app events exist only from the
          app release that sends them.
        </p>
      </Card>
    </div>
  )
}
