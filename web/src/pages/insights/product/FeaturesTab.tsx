import { useState } from 'react'
import { fmtDay, fmtInt } from '../../../lib/format'
import { Badge, Card, Select, Table, Td } from '../../../components/ui'
import { ChartCard, Line, shade, shadeInk } from '../../../components/charts'
import { ProductGate, pct, useProduct } from './ProductGate'
import type { Features } from './types'

function RateCell({ cell }: { cell: { cohort: number; rate: number | null } | null }) {
  if (!cell || cell.rate === null) return <span className="text-muted-foreground">—</span>
  return (
    <div className="tabular rounded px-1 py-1 text-center text-xs" style={{ background: shade(cell.rate / 100), color: shadeInk(cell.rate / 100) }} title={`${fmtInt(cell.cohort)} learners`}>
      {cell.rate}%
    </div>
  )
}

/** Adoption (% of weekly actives), frequency, and the feature × retention matrix (DESIGN §7). */
export function FeaturesTab({ days }: { days: number }) {
  const q = useProduct<Features>('features', { days })
  const [feature, setFeature] = useState('ai_tutor')
  return (
    <ProductGate query={q}>
      {(d) => {
        const chosen = d.features.find((f) => f.key === feature) ?? d.features[0]
        return (
          <>
            <Card title="Feature adoption" padded={false} description={`Adoption: people who used the feature in the last 7 days ÷ everyone active in them (${fmtInt(d.wau)}).`}>
              <Table head={['Feature', 'Adoption (7 days)', `People, ${days} days`, 'Uses', 'Uses per person']}>
                {[...d.features]
                  .sort((a, b) => b.users - a.users)
                  .map((f) => (
                    <tr key={f.key} className="border-b">
                      <Td className="font-medium">{f.label}</Td>
                      <Td className="tabular">
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-24 rounded-full bg-muted">
                            <div className="h-2 rounded-full bg-chart" style={{ width: `${Math.min(100, f.adoption ?? 0)}%` }} />
                          </div>
                          {pct(f.adoption)}
                        </div>
                      </Td>
                      <Td className="tabular">
                        {fmtInt(f.users)}
                        {f.usersChange !== null && Math.abs(f.usersChange) >= 20 && (
                          <Badge tone={f.usersChange > 0 ? 'green' : 'red'} className="ml-2">
                            {f.usersChange > 0 ? '+' : ''}
                            {f.usersChange}%
                          </Badge>
                        )}
                      </Td>
                      <Td className="tabular">{fmtInt(f.uses)}</Td>
                      <Td className="tabular">{f.usesPerUser}</Td>
                    </tr>
                  ))}
              </Table>
            </Card>

            {chosen && (
              <ChartCard
                title={`${chosen.label}: people per day`}
                subtitle={
                  <Select aria-label="Feature" className="mt-2 w-56" value={chosen.key} onChange={(e) => setFeature(e.target.value)}>
                    {d.features.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}
                      </option>
                    ))}
                  </Select>
                }
                rows={chosen.series}
                columns={[
                  { key: 'day', label: 'Day', format: (v) => fmtDay(String(v)) },
                  { key: 'users', label: 'People' },
                ]}
              >
                <Line data={chosen.series} x="day" y="users" xFormat={fmtDay} label="people" />
              </ChartCard>
            )}

            <Card title="Feature × retention" padded={false} description="Learners grouped by the first feature they used (cohorts of the last 12 weeks): the share active again 1, 2 and 4 weeks later.">
              {d.retention.length ? (
                <Table head={['First feature', 'Week 1', 'Week 2', 'Week 4']}>
                  {d.retention.map((r) => (
                    <tr key={r.feature} className="border-b">
                      <Td className="font-medium">{r.label}</Td>
                      <Td><RateCell cell={r.week1} /></Td>
                      <Td><RateCell cell={r.week2} /></Td>
                      <Td><RateCell cell={r.week4} /></Td>
                    </tr>
                  ))}
                </Table>
              ) : (
                <p className="px-4 py-4 text-sm text-muted-foreground">Not enough weeks of data yet: a cohort shows once its week has passed.</p>
              )}
            </Card>
          </>
        )
      }}
    </ProductGate>
  )
}
