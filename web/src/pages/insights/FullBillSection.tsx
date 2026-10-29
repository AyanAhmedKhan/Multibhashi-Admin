import { Fragment, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, CircleCheck, CircleDashed, RefreshCw, TriangleAlert } from 'lucide-react'
import { api, ApiError } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { fmtAgo, fmtDateTime, fmtDay, fmtInt, inr, inrSmall } from '../../lib/format'
import { Badge, Button, Card, Empty, ErrorNote, Spinner, Stat, Table, Td } from '../../components/ui'
import { Bars, ChartCard } from '../../components/charts'
import { qty } from './QuizCostSection'

type Bucket = 'quizzes' | 'tutor' | 'other'
type Split = Record<Bucket, number>
interface Run {
  at: string
  ok: boolean
  error: string | null
  rows: number
  days: number
  dataThrough: string | null
  exportedAt?: string | null
  demo?: boolean
  costsByKey?: boolean
}
interface Tokens {
  inputTokens: number
  outputTokens: number
  requests: number
  listInr: number
}
interface FullBill {
  days: number
  usdToInr: number
  attribution: { speech: string; marking: string; tutor: string }
  empty: 'not_connected' | 'no_data_yet' | null
  sources: {
    openaiUsage: { connected: boolean; missing: string[]; lastRun: Run | null; latestDay: string | null; demo: boolean }
    openaiCosts: { connected: boolean; latestDay: string | null; byKey: boolean | null }
    gcp: { connected: boolean; missing: string[]; problem: string | null; lastRun: Run | null; latestDay: string | null; demo: boolean }
    manual: { latestMonth: string | null; updatedAt: string | null; entries: number }
  }
  window: {
    openaiInr: number
    openaiUsageDays: number
    googleGrossInr: number
    googleCreditsInr: number
    googleNetInr: number
    totalInr: number
    split: Split
    quizParts: { speechInr: number; markingInr: number }
    incompleteDays: string[]
    googleFrom: string | null
    openaiFrom: string | null
  }
  series: {
    day: string
    openaiInr: number
    openaiBasis: 'billed' | 'usage' | 'none'
    googleGrossInr: number
    googleCreditsInr: number
    googleNetInr: number
    totalInr: number
    quizzesInr: number
    tutorInr: number
    otherInr: number
    complete: boolean
  }[]
  months: {
    month: string
    openaiInr: number
    openaiUsageDays: number
    googleGrossInr: number
    googleCreditsInr: number
    googleNetInr: number
    manual: { provider: string; label: string; amountInr: number; note: string | null; counted: boolean; bucket: Bucket }[]
    manualInr: number
    totalInr: number
    split: Split
    coverage: { googleDays: number; openaiDays: number }
  }[]
  gcp: {
    project: string
    grossInr: number
    creditsInr: number
    netInr: number
    split: Split
    role: string | null
    services: { service: string; grossInr: number; creditsInr: number; netInr: number; skus: { sku: string; unit: string; quantity: number; netInr: number; bucket: Bucket }[]; moreSkus: number }[]
  }[]
  openai: {
    costsByKey: boolean | null
    byProject: (Tokens & { project: string; billedInr: number | null; quiz: boolean | null })[]
    byModel: (Tokens & { model: string; billedInr: number | null })[]
    byKey: (Tokens & { project: string; key: string | null; billedInr: number | null; quiz: boolean | null })[]
  }
  gemini: { project: string; status: 'billed' | 'not_billed' | 'not_connected'; netInr: number | null }
  tutorComparison: { month: string; provider: string; label: string; computedInr: number; computedEstimatedInr: number; billed: { inr: number | null; status: string; source: string } }[]
  tutorComputedWindowInr: number
}

const BUCKET_LABEL: Record<Bucket, string> = { quizzes: 'Quizzes', tutor: 'AI tutor', other: 'Everything else' }
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00+05:30`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })

function QuizFlag({ quiz }: { quiz: boolean | null }) {
  return quiz === true ? <Badge tone="blue">quizzes</Badge> : quiz === null ? <Badge tone="amber">split by usage</Badge> : <Badge>other</Badge>
}

function SourceRow({ name, connected, missing, problem, lastRun, latestDay, extra, demo }: {
  name: string
  connected: boolean
  missing?: string[]
  problem?: string | null
  lastRun?: Run | null
  latestDay: string | null
  extra?: string
  demo?: boolean
}) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          {connected ? lastRun && !lastRun.ok ? <TriangleAlert className="size-4 text-warning" aria-hidden /> : <CircleCheck className="size-4 text-success" aria-hidden /> : <CircleDashed className="size-4 text-muted-foreground" aria-hidden />}
          {name}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {connected || latestDay ? (extra ?? '') : problem ?? (missing?.length ? `Not connected: set ${missing.join(', ')} (deploy/.env.production).` : '')}
          {latestDay && ` Latest day: ${fmtDay(latestDay)}.`}
        </div>
        {lastRun && !lastRun.ok && lastRun.error && <div className="mt-1 max-w-2xl text-xs text-warning">Last sync failed: {lastRun.error}</div>}
      </div>
      <div className="text-right text-xs text-muted-foreground">
        {connected ? <Badge tone={lastRun?.ok === false ? 'amber' : 'green'}>{lastRun ? (lastRun.ok ? 'connected' : 'sync failed') : 'not synced yet'}</Badge> : <Badge>not connected</Badge>}
        {demo && <Badge tone="violet" className="ml-1">demo rows</Badge>}
        {lastRun && <div className="mt-1">synced {fmtAgo(lastRun.at)}</div>}
        {lastRun?.dataThrough && <div>data through {fmtDateTime(lastRun.dataThrough)}</div>}
      </div>
    </li>
  )
}

export function FullBillSection({ days }: { days: number }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [refreshing, setRefreshing] = useState(false)
  const q = useQuery({ queryKey: ['insights-full-bill', days], queryFn: () => api.get<FullBill>('insights/full-bill', { days }) })
  if (q.isLoading) return <Spinner />
  if (q.error || !q.data) return <ErrorNote error={q.error} />
  const d = q.data
  const s = d.sources
  const manage = can('analytics.costs.manage')
  const connected = s.openaiUsage.connected || s.gcp.connected
  const toggle = (key: string) => {
    const next = new Set(open)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setOpen(next)
  }
  const refresh = async () => {
    setRefreshing(true)
    try {
      await api.post('insights/quiz-providers/refresh', { days: Math.min(days, 90) })
      toast.success('Provider data refreshed')
      await queryClient.invalidateQueries({ queryKey: ['insights-full-bill'] })
      await queryClient.invalidateQueries({ queryKey: ['insights-quiz-cost'] })
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }

  const sourcesCard = (
    <Card
      title="Sources and freshness"
      description="What each provider itself reports; synced daily (quiz:sync-provider-usage) and on Refresh."
      actions={manage && <Button size="sm" icon={<RefreshCw className="size-4" />} loading={refreshing} onClick={refresh} disabled={!connected}>Refresh</Button>}
    >
      <ul className="divide-y">
        <SourceRow name="OpenAI usage (tokens by project, key, model)" connected={s.openaiUsage.connected} missing={s.openaiUsage.missing} lastRun={s.openaiUsage.lastRun} latestDay={s.openaiUsage.latestDay} demo={s.openaiUsage.demo} extra="Usage API, whole organisation." />
        <SourceRow
          name="OpenAI costs (USD by project, line item, key)"
          connected={s.openaiCosts.connected}
          missing={s.openaiUsage.missing}
          latestDay={s.openaiCosts.latestDay}
          demo={s.openaiUsage.demo}
          extra={s.openaiCosts.byKey === false ? 'Costs API, per project (it refused grouping by key; key rules are split by usage).' : 'Costs API, whole organisation.'}
        />
        <SourceRow name="Google Cloud billing export (every project, service, SKU)" connected={s.gcp.connected} missing={s.gcp.missing} problem={s.gcp.problem} lastRun={s.gcp.lastRun} latestDay={s.gcp.latestDay} demo={s.gcp.demo} extra="BigQuery export of billing account 016513-594D05-0EF1D5; lags by hours to a day." />
        <li className="flex flex-wrap items-start justify-between gap-3 py-3 last:pb-0">
          <div>
            <div className="text-sm font-medium">Finance’s monthly bills</div>
            <div className="mt-1 text-xs text-muted-foreground">Entered under AI tutor → Reconcile with the bills (Sarvam, LiveKit, other: no billing API).</div>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            {s.manual.entries ? <>latest month {monthLabel(s.manual.latestMonth!)}{s.manual.updatedAt && <div>updated {fmtAgo(s.manual.updatedAt)}</div>}</> : <Badge>none entered</Badge>}
          </div>
        </li>
      </ul>
    </Card>
  )

  if (d.empty) {
    return (
      <div className="space-y-6">
        <Card>
          <Empty title={d.empty === 'not_connected' ? 'No provider is connected' : 'Connected, but nothing synced yet'}>
            {d.empty === 'not_connected'
              ? 'The full bill comes from OpenAI’s Usage and Costs APIs and the GCP billing export. Set the credentials in deploy/.env.production (see Sources below); Finance’s monthly bills also appear here once entered.'
              : 'Press Refresh, or wait for the daily sync. The GCP export lags by hours to a day after it is enabled.'}
          </Empty>
        </Card>
        {sourcesCard}
      </div>
    )
  }

  const w = d.window
  const series = d.series.map((x) => ({ ...x, incomplete: !x.complete }))
  const geminiText = d.gemini.status === 'billed' ? inr(d.gemini.netInr, 2) : d.gemini.status === 'not_billed' ? 'not billed (free tier project)' : 'billing export not connected'

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border bg-muted px-3 py-2 text-sm text-ink-2">
        Billed figures only: what OpenAI and Google report (net of credits), plus Finance’s monthly bills in the monthly table. The AI tutor’s usage-priced cost is shown beside the
        billed figures, never added to them. Attribution: quizzes = {d.attribution.speech} + {d.attribution.marking}; AI tutor = {d.attribution.tutor}.
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label={`Billed, ${days} days`} value={inr(w.totalInr, 2)} hint={`OpenAI ${inr(w.openaiInr, 2)} · Google ${inr(w.googleNetInr, 2)} net${w.incompleteDays.length ? ` · ${w.incompleteDays.length} ${w.incompleteDays.length === 1 ? 'day' : 'days'} still arriving` : ''}`} />
        <Stat label="Google Cloud, net" value={inr(w.googleNetInr, 2)} hint={`gross ${inr(w.googleGrossInr, 2)} · credits ${inr(w.googleCreditsInr, 2)}`} />
        <Stat label="OpenAI" value={inr(w.openaiInr, 2)} hint={w.openaiUsageDays ? `${w.openaiUsageDays} ${w.openaiUsageDays === 1 ? 'day' : 'days'} from usage × list price (no Costs API row)` : 'from the Costs API'} />
        <Stat label="Quizzes" value={inr(w.split.quizzes, 2)} hint={`speech-to-text ${inr(w.quizParts.speechInr, 2)} · marking ${inr(w.quizParts.markingInr, 2)}`} />
        <Stat label="AI tutor (billed)" value={inr(w.split.tutor, 2)} hint={`Gemini: ${geminiText} · computed from usage ${inr(d.tutorComputedWindowInr)} (not added)`} />
        <Stat label="Everything else" value={inr(w.split.other, 2)} hint="not attributed to the tutor or quizzes" />
      </div>

      <ChartCard
        title="Billed per day"
        subtitle={`OpenAI + Google Cloud (net). Hatched = a source’s data for that day is still arriving.${w.googleFrom ? ` GCP export data from ${fmtDay(w.googleFrom)}` : ' No GCP export data yet'}${w.openaiFrom ? `, OpenAI from ${fmtDay(w.openaiFrom)}.` : '.'}`}
        rows={series}
        columns={[
          { key: 'day', label: 'Day', format: (v) => fmtDay(String(v)) },
          { key: 'openaiInr', label: 'OpenAI', format: (v, r) => (r.openaiBasis === 'none' ? '—' : `${inrSmall(Number(v))}${r.openaiBasis === 'usage' ? ' (usage × price)' : ''}`) },
          { key: 'googleNetInr', label: 'Google net', format: (v) => inrSmall(Number(v)) },
          { key: 'totalInr', label: 'Total', format: (v) => inrSmall(Number(v)) },
          { key: 'quizzesInr', label: 'Quizzes', format: (v) => inrSmall(Number(v)) },
          { key: 'tutorInr', label: 'AI tutor', format: (v) => inrSmall(Number(v)) },
          { key: 'otherInr', label: 'Other', format: (v) => inrSmall(Number(v)) },
          { key: 'complete', label: 'Complete', format: (v) => (v ? 'yes' : <Badge tone="amber">arriving</Badge>) },
        ]}
      >
        <Bars data={series} x="day" y="totalInr" hatched="incomplete" hatchedLabel="still arriving" xFormat={fmtDay} yFormat={(v) => inrSmall(v)} label="" yDecimals />
      </ChartCard>

      <Card title="Per month" padded={false}>
        <Table head={['Month', 'OpenAI', 'Google gross', 'Credits', 'Google net', 'Finance’s bills', 'Total', 'Quizzes', 'AI tutor', 'Other']}>
          {d.months.map((m) => (
            <tr key={m.month}>
              <Td className="whitespace-nowrap font-medium">
                {monthLabel(m.month)}
                <div className="text-xs font-normal text-muted-foreground">{m.coverage.googleDays} GCP days · {m.coverage.openaiDays} OpenAI days</div>
              </Td>
              <Td className="tabular">{m.coverage.openaiDays ? inr(m.openaiInr, 2) : '—'}</Td>
              <Td className="tabular">{m.coverage.googleDays ? inr(m.googleGrossInr, 2) : '—'}</Td>
              <Td className="tabular text-muted-foreground">{m.coverage.googleDays ? inr(m.googleCreditsInr, 2) : '—'}</Td>
              <Td className="tabular">{m.coverage.googleDays ? inr(m.googleNetInr, 2) : '—'}</Td>
              <Td className="text-xs">
                {m.manual.length
                  ? m.manual.map((x) => (
                      <div key={x.provider} className={x.counted ? '' : 'text-muted-foreground line-through'} title={x.counted ? undefined : 'Shown, not added: the GCP export already has this month'}>
                        {x.label} {inr(x.amountInr)}
                      </div>
                    ))
                  : '—'}
              </Td>
              <Td className="tabular font-semibold">{m.totalInr ? inr(m.totalInr, 2) : '—'}</Td>
              <Td className="tabular">{m.totalInr ? inr(m.split.quizzes, 2) : '—'}</Td>
              <Td className="tabular">{m.totalInr ? inr(m.split.tutor, 2) : '—'}</Td>
              <Td className="tabular">{m.totalInr ? inr(m.split.other, 2) : '—'}</Td>
            </tr>
          ))}
        </Table>
        <p className="px-4 py-3 text-xs text-muted-foreground">
          A month is only as complete as its synced days (shown under the month): the daily sync keeps the last 7 days, Refresh can pull up to 90. Finance’s Google figure is shown but
          not added for a month the export covers.
        </p>
      </Card>

      <Card title="Google Cloud by project, service and SKU" description={`Last ${days} days, net of credits. Click a project or service to open it.`} padded={false}>
        {d.gcp.length ? (
          <Table head={['Project / service / SKU', 'Gross', 'Credits', 'Net', 'Attributed']}>
            {d.gcp.map((p) => (
              <Fragment key={p.project}>
                <tr className="cursor-pointer" onClick={() => toggle(p.project)}>
                  <Td className="font-medium">
                    <span className="inline-flex items-center gap-1">
                      {open.has(p.project) ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />}
                      {p.project === 'no-project' ? 'No project (account-level: tax, adjustments)' : p.project}
                    </span>
                    {p.role && <div className="pl-5 text-xs font-normal text-muted-foreground">{p.role}</div>}
                  </Td>
                  <Td className="tabular">{inrSmall(p.grossInr)}</Td>
                  <Td className="tabular text-muted-foreground">{inrSmall(p.creditsInr)}</Td>
                  <Td className="tabular font-medium">{inrSmall(p.netInr)}</Td>
                  <Td className="text-xs">
                    {(Object.keys(p.split) as Bucket[]).filter((b) => Math.abs(p.split[b]) > 0.005).map((b) => `${BUCKET_LABEL[b]} ${inrSmall(p.split[b])}`).join(' · ') || '—'}
                  </Td>
                </tr>
                {open.has(p.project) &&
                  p.services.map((sv) => (
                    <Fragment key={sv.service}>
                      <tr className="cursor-pointer bg-muted/40" onClick={() => toggle(`${p.project}|${sv.service}`)}>
                        <Td className="pl-10">
                          <span className="inline-flex items-center gap-1">
                            {open.has(`${p.project}|${sv.service}`) ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
                            {sv.service}
                          </span>
                        </Td>
                        <Td className="tabular">{inrSmall(sv.grossInr)}</Td>
                        <Td className="tabular text-muted-foreground">{inrSmall(sv.creditsInr)}</Td>
                        <Td className="tabular">{inrSmall(sv.netInr)}</Td>
                        <Td>{''}</Td>
                      </tr>
                      {open.has(`${p.project}|${sv.service}`) && (
                        <>
                          {sv.skus.map((k) => (
                            <tr key={`${k.sku}|${k.unit}`} className="bg-muted/20">
                              <Td className="pl-16 text-xs">
                                {k.sku}
                                <div className="text-muted-foreground">{qty(k.quantity)} {k.unit}</div>
                              </Td>
                              <Td>{''}</Td>
                              <Td>{''}</Td>
                              <Td className="tabular text-xs">{inrSmall(k.netInr)}</Td>
                              <Td>{k.bucket === 'other' ? <span className="text-xs text-muted-foreground">other</span> : <Badge tone="blue">{BUCKET_LABEL[k.bucket]}</Badge>}</Td>
                            </tr>
                          ))}
                          {sv.moreSkus > 0 && (
                            <tr className="bg-muted/20">
                              <Td className="pl-16 text-xs text-muted-foreground">+ {sv.moreSkus} smaller SKUs</Td>
                              <Td>{''}</Td>
                              <Td>{''}</Td>
                              <Td>{''}</Td>
                              <Td>{''}</Td>
                            </tr>
                          )}
                        </>
                      )}
                    </Fragment>
                  ))}
              </Fragment>
            ))}
          </Table>
        ) : (
          <p className="p-5 text-sm text-muted-foreground">{s.gcp.connected ? 'No GCP rows for this period yet (the export lags by hours to a day).' : 'The GCP billing export is not connected.'}</p>
        )}
        <p className="px-4 py-3 text-xs text-muted-foreground">
          The tutor’s Gemini project {d.gemini.project}: {geminiText}.
        </p>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="OpenAI by project" padded={false}>
          {d.openai.byProject.length ? (
            <Table head={['Project', 'Billed', 'Tokens in / out', 'Requests', '']}>
              {d.openai.byProject.map((p) => (
                <tr key={p.project}>
                  <Td className="font-medium">{p.project}</Td>
                  <Td className="tabular">{p.billedInr === null ? <span className="text-muted-foreground">{inrSmall(p.listInr)} at list</span> : inrSmall(p.billedInr)}</Td>
                  <Td className="tabular whitespace-nowrap">{qty(p.inputTokens)} / {qty(p.outputTokens)}</Td>
                  <Td className="tabular">{fmtInt(Math.round(p.requests))}</Td>
                  <Td><QuizFlag quiz={p.quiz} /></Td>
                </tr>
              ))}
            </Table>
          ) : (
            <p className="p-5 text-sm text-muted-foreground">{s.openaiUsage.connected ? 'Nothing synced for this period yet.' : 'OpenAI is not connected.'}</p>
          )}
        </Card>
        <Card title="OpenAI by model" padded={false}>
          {d.openai.byModel.length ? (
            <Table head={['Model', 'Billed', 'Tokens in / out', 'Requests']}>
              {d.openai.byModel.map((m) => (
                <tr key={m.model}>
                  <Td className="font-medium">{m.model}</Td>
                  <Td className="tabular">{m.billedInr === null ? <span className="text-muted-foreground">{inrSmall(m.listInr)} at list</span> : inrSmall(m.billedInr)}</Td>
                  <Td className="tabular whitespace-nowrap">{qty(m.inputTokens)} / {qty(m.outputTokens)}</Td>
                  <Td className="tabular">{fmtInt(Math.round(m.requests))}</Td>
                </tr>
              ))}
            </Table>
          ) : (
            <p className="p-5 text-sm text-muted-foreground">{s.openaiUsage.connected ? 'Nothing synced for this period yet.' : 'OpenAI is not connected.'}</p>
          )}
        </Card>
      </div>

      <Card title="OpenAI by API key" padded={false}>
        {d.openai.byKey.length ? (
          <Table head={['Key', 'Project', 'Billed', 'Tokens in / out', 'Requests', '']}>
            {d.openai.byKey.map((k) => (
              <tr key={`${k.project}/${k.key}`}>
                <Td className="font-medium">{k.key ?? '—'}</Td>
                <Td className="text-xs">{k.project}</Td>
                <Td className="tabular">{k.billedInr === null ? <span className="text-muted-foreground">{inrSmall(k.listInr)} at list</span> : inrSmall(k.billedInr)}</Td>
                <Td className="tabular whitespace-nowrap">{qty(k.inputTokens)} / {qty(k.outputTokens)}</Td>
                <Td className="tabular">{fmtInt(Math.round(k.requests))}</Td>
                <Td><QuizFlag quiz={k.quiz} /></Td>
              </tr>
            ))}
          </Table>
        ) : (
          <p className="p-5 text-sm text-muted-foreground">{s.openaiUsage.connected ? 'Nothing synced for this period yet.' : 'OpenAI is not connected.'}</p>
        )}
        <p className="px-4 py-3 text-xs text-muted-foreground">
          {d.openai.costsByKey === false
            ? 'OpenAI’s Costs API would not group by key, so per-key figures are usage × list price.'
            : '“at list” = OpenAI’s own token counts × the price list, where the Costs API has no figure.'}
        </p>
      </Card>

      <Card title="AI tutor: billed next to computed" description="Never added together: the computed figure is the tutor’s recorded usage × the price list (estimated for classes without usage), the billed figure is the provider’s." padded={false}>
        {d.tutorComparison.length ? (
          <Table head={['Month', 'Provider', 'Billed', 'Computed from usage', 'Of which estimated']}>
            {d.tutorComparison.map((r) => (
              <tr key={`${r.month}-${r.provider}`}>
                <Td className="whitespace-nowrap">{monthLabel(r.month)}</Td>
                <Td>{r.label}</Td>
                <Td>
                  {r.billed.inr !== null ? <span className="tabular">{inr(r.billed.inr, 2)}</span> : <Badge tone={r.billed.status === 'not_billed' ? 'green' : 'neutral'}>{r.billed.source}</Badge>}
                  {r.billed.inr !== null && <div className="text-xs text-muted-foreground">{r.billed.source}</div>}
                </Td>
                <Td className="tabular">{inr(r.computedInr, 2)}</Td>
                <Td className="tabular text-muted-foreground">{inr(r.computedEstimatedInr, 2)}</Td>
              </tr>
            ))}
          </Table>
        ) : (
          <p className="p-5 text-sm text-muted-foreground">No tutor cost or bills in the last three months.</p>
        )}
      </Card>

      {sourcesCard}
    </div>
  )
}
