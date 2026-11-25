import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../../lib/auth'
import { fmtDateTime, fmtInt } from '../../../lib/format'
import { Badge, Button, Card, Select, Table, Td } from '../../../components/ui'
import { RankList } from '../../OverviewPage'
import { ProductGate, fmtSeconds, pct, useProduct } from './ProductGate'
import type { Dropoffs, Funnels } from './types'

const BREAKDOWNS = [
  { value: '', label: 'No breakdown' },
  { value: 'platform', label: 'By platform' },
  { value: 'channel', label: 'By channel (UTM source)' },
  { value: 'app_version', label: 'By app version' },
]

function DropoffPanel({ days, funnel, step }: { days: number; funnel: string; step: number }) {
  const q = useProduct<Dropoffs>('dropoffs', { days, funnel, step })
  const { can } = useAuth()
  return (
    <ProductGate query={q}>
      {(d) => (
        <Card
          title={`Stopped after “${d.stoppedAfter}”`}
          description={`${fmtInt(d.total)} learners did this step and never reached “${d.nextStep}” within the funnel’s window. Their best run counts.`}
        >
          <div className="grid gap-6 md:grid-cols-3">
            <div>
              <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Platform</h4>
              <RankList rows={d.byPlatform.map((x) => ({ label: x.value, value: x.people }))} />
            </div>
            <div>
              <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">App version</h4>
              <RankList rows={d.byVersion.map((x) => ({ label: x.value, value: x.people }))} />
            </div>
            <div>
              <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Channel</h4>
              <RankList rows={d.byChannel.map((x) => ({ label: x.value, value: x.people }))} />
            </div>
          </div>
          {d.learners ? (
            <div className="-mx-5 mt-5 border-t">
              <Table head={['Learner', 'Platform', 'Version', 'Last step', 'Run started']}>
                {d.learners.map((l, i) => (
                  <tr key={i} className="border-b">
                    <Td>
                      {l.tdUserId ? (
                        <Link className="text-primary underline-offset-2 hover:underline" to={`/learners/${l.tdUserId}`}>
                          Learner #{l.tdUserId}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">{l.signedIn ? 'Signed in, not linked yet' : 'Visitor (not signed in)'}</span>
                      )}
                    </Td>
                    <Td>{l.platform ?? '—'}</Td>
                    <Td>{l.appVersion ?? '—'}</Td>
                    <Td className="tabular">{fmtDateTime(l.lastStepAt)}</Td>
                    <Td className="tabular">{l.startDate}</Td>
                  </tr>
                ))}
              </Table>
              <p className="px-4 py-3 text-xs text-muted-foreground">
                The latest 50. Learners link to their console page once the sign-in v2 identity link exists. Session replays: none are linked from here (Clarity
                carries no learner id).
              </p>
            </div>
          ) : (
            !can('learners.read') && <p className="mt-4 text-xs text-muted-foreground">The list of learners needs the Learners permission.</p>
          )}
        </Card>
      )}
    </ProductGate>
  )
}

/** The five ordered, windowed funnels with breakdowns and drop-off lists (DESIGN §7). */
export function FunnelsTab({ days }: { days: number }) {
  const [funnel, setFunnel] = useState('signup')
  const [breakdown, setBreakdown] = useState('')
  const [dropStep, setDropStep] = useState<number | null>(null)
  const q = useProduct<Funnels>('funnels', { days, funnel, breakdown: breakdown || undefined })
  return (
    <ProductGate query={q}>
      {(d) => {
        const f = d.funnels.find((x) => x.key === funnel) ?? d.funnels[0]
        const top = f.steps[0]?.users || 1
        const biggest = f.steps.reduce((best, s, k) => (k > 0 && s.dropped > (f.steps[best]?.dropped ?? 0) ? k : best), 0)
        return (
          <>
            <div className="grid gap-3 md:grid-cols-5">
              {d.funnels.map((x) => (
                <button
                  key={x.key}
                  type="button"
                  onClick={() => {
                    setFunnel(x.key)
                    setDropStep(null)
                  }}
                  className={`rounded-xl border bg-card px-4 py-3 text-left shadow-xs transition-colors ${x.key === f.key ? 'border-primary ring-1 ring-primary' : 'hover:bg-muted/50'}`}
                >
                  <div className="text-[13px] text-muted-foreground">{x.label}</div>
                  <div className="tabular text-2xl font-semibold">{pct(x.conversion)}</div>
                  <div className="text-xs text-muted-foreground">
                    of {fmtInt(x.steps[0]?.users ?? 0)} · before {pct(x.conversionBefore)}
                  </div>
                </button>
              ))}
            </div>

            <Card
              title={`${f.label} funnel`}
              description={`Each step counts only after the one before it, within ${f.windowDays === 1 ? '1 day' : `${f.windowDays} days`} of the first; a learner counts at their furthest run.`}
              actions={
                <Select aria-label="Breakdown" className="w-56" value={breakdown} onChange={(e) => setBreakdown(e.target.value)}>
                  {BREAKDOWNS.map((b) => (
                    <option key={b.value} value={b.value}>
                      {b.label}
                    </option>
                  ))}
                </Select>
              }
            >
              <ul className="space-y-4">
                {f.steps.map((s, k) => (
                  <li key={s.label}>
                    <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-sm">
                      <span className="text-ink-2">
                        {k + 1}. {s.label}
                        {k === biggest && k > 0 && s.dropped > 0 && (
                          <Badge tone="amber" className="ml-2">
                            biggest drop
                          </Badge>
                        )}
                      </span>
                      <span className="tabular font-medium">
                        {fmtInt(s.users)} <span className="font-normal text-muted-foreground">({pct(s.fromFirst)})</span>
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-muted">
                      <div className="h-2 rounded-full bg-chart" style={{ width: `${(s.users / top) * 100}%` }} />
                    </div>
                    {k > 0 && (
                      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>{pct(s.fromPrevious)} of the step before</span>
                        <span>median {fmtSeconds(s.medianGapSeconds)} after it</span>
                        {f.steps[k - 1].users - s.users > 0 && (
                          <Button size="sm" variant="ghost" onClick={() => setDropStep(dropStep === k ? null : k)}>
                            {dropStep === k ? 'Hide' : `Who stopped (${fmtInt(f.steps[k - 1].users - s.users)})`}
                          </Button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {f.key === 'purchase' && (
                <p className="mt-4 text-xs text-muted-foreground">
                  The last two steps are the server’s own records (a captured payment, then a paid booking), joined to the app’s learner through the sign-in v2
                  identity link: they stay empty until it exists.
                </p>
              )}
            </Card>

            {dropStep !== null && <DropoffPanel days={days} funnel={f.key} step={dropStep} />}

            {d.breakdown && (
              <Card title={`By ${BREAKDOWNS.find((b) => b.value === d.breakdown)?.label.replace('By ', '') ?? d.breakdown}`} padded={false} description="Of the run’s start. The largest 12 segments.">
                <Table head={['Segment', ...f.steps.map((s, k) => `${k + 1}. ${s.label}`), 'Conversion']}>
                  {d.segments.map((s) => (
                    <tr key={s.segment} className="border-b">
                      <Td className="font-medium">{s.segment}</Td>
                      {s.steps.map((u, k) => (
                        <Td key={k} className="tabular">
                          {fmtInt(u)}
                        </Td>
                      ))}
                      <Td className="tabular">{pct(s.conversion)}</Td>
                    </tr>
                  ))}
                </Table>
              </Card>
            )}
          </>
        )
      }}
    </ProductGate>
  )
}
