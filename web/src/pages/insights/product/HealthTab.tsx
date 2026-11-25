import { fmtAgo, fmtDay, fmtInt } from '../../../lib/format'
import { Badge, Card, Stat, Table, Td } from '../../../components/ui'
import { Bars, ChartCard } from '../../../components/charts'
import { RankList } from '../../OverviewPage'
import { ProductGate, pct, useProduct } from './ProductGate'
import type { Health } from './types'

const SOURCE_LABEL: Record<string, string> = {
  events_raw: 'Events arriving (collector)',
  fact_users: 'Business facts export',
  identities: 'Identity link export',
  m_sessions: 'Sessions model',
  m_screen_daily: 'Screens model',
  m_feature_daily: 'Features model',
  m_funnel_steps: 'Funnels model',
  m_retention_weekly: 'Retention model',
  m_health_daily: 'Health model',
}

const VITAL_GOOD: Record<string, string> = { LCP: '≤ 2,500 ms good', INP: '≤ 200 ms good', CLS: '≤ 0.1 good' }

/** Errors, slow API calls, web vitals by screen and app version, and data freshness (MUL-154). */
export function HealthTab({ days }: { days: number }) {
  const q = useProduct<Health>('health', { days })
  return (
    <ProductGate query={q}>
      {(d) => (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label={`App errors, ${days} days`} value={fmtInt(d.errorsDaily.reduce((s, e) => s + e.events, 0))} />
            {['LCP', 'INP', 'CLS'].map((name) => {
              const v = d.vitals.find((x) => x.name === name)
              return (
                <Stat
                  key={name}
                  label={`${name} (p75, web)`}
                  value={v?.p75 === null || v?.p75 === undefined ? '—' : name === 'CLS' ? String(v.p75) : `${fmtInt(v.p75)} ms`}
                  hint={v ? `${pct(v.poorShare)} poor · ${VITAL_GOOD[name]}` : VITAL_GOOD[name]}
                  tone={v?.poorShare && v.poorShare > 25 ? 'amber' : undefined}
                />
              )
            })}
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <ChartCard
              title="App errors per day"
              rows={d.errorsDaily}
              columns={[
                { key: 'day', label: 'Day', format: (v) => fmtDay(String(v)) },
                { key: 'events', label: 'Errors' },
              ]}
            >
              <Bars data={d.errorsDaily} x="day" y="events" xFormat={fmtDay} label="errors" />
            </ChartCard>
            <Card title="Errors by screen">
              <RankList rows={d.errorsByScreen.map((e) => ({ label: e.screen, value: e.events }))} unit="errors" />
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Error types" padded={false}>
              <Table head={['Type', 'Errors', 'Screens']}>
                {d.errorsByType.map((e) => (
                  <tr key={e.type} className="border-b">
                    <Td className="font-medium">{e.type}</Td>
                    <Td className="tabular">{fmtInt(e.events)}</Td>
                    <Td className="tabular">{fmtInt(e.screens)}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
            <Card title="Errors by app version" padded={false}>
              <Table head={['Version', 'Platform', 'Errors']}>
                {d.errorsByVersion.map((e, i) => (
                  <tr key={i} className="border-b">
                    <Td className="font-medium">{e.appVersion}</Td>
                    <Td>{e.platform}</Td>
                    <Td className="tabular">{fmtInt(e.events)}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Slow API calls (over 3 s)" padded={false} description="Per endpoint group. Percentiles are each day’s, weighted by its calls (≈).">
              <Table head={['Endpoint', 'Slow calls', '≈ p50', '≈ p95']}>
                {d.slowApis.map((a) => (
                  <tr key={a.endpoint} className="border-b">
                    <Td className="font-mono text-xs">{a.endpoint}</Td>
                    <Td className="tabular">{fmtInt(a.events)}</Td>
                    <Td className="tabular">{a.p50 === null ? '—' : `${fmtInt(a.p50)} ms`}</Td>
                    <Td className="tabular">{a.p95 === null ? '—' : `${fmtInt(a.p95)} ms`}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
            <Card title="Slow screens (LCP, web)" padded={false} description="Screens and versions with at least 5 page loads, slowest first.">
              <Table head={['Screen', 'Version', 'Loads', '≈ p75', 'Poor']}>
                {d.slowScreens.map((s, i) => (
                  <tr key={i} className="border-b">
                    <Td className="font-medium">{s.screen}</Td>
                    <Td>{s.appVersion}</Td>
                    <Td className="tabular">{fmtInt(s.events)}</Td>
                    <Td className="tabular">{s.p75 === null ? '—' : `${fmtInt(s.p75)} ms`}</Td>
                    <Td className="tabular">{pct(s.poorShare)}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
          </div>

          <Card title="Data freshness" padded={false} description="A source older than 26 hours means a nightly job (export or models) or the collector needs a look.">
            <Table head={['Source', 'Last updated', 'Status']}>
              {d.freshness.map((f) => (
                <tr key={f.source} className="border-b">
                  <Td className="font-medium">{SOURCE_LABEL[f.source] ?? f.source}</Td>
                  <Td className="tabular">{f.at ? fmtAgo(f.at) : 'never'}</Td>
                  <Td>{f.stale ? <Badge tone="amber">stale</Badge> : <Badge tone="green">fresh</Badge>}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
    </ProductGate>
  )
}
