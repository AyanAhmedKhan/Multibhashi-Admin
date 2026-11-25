import { useState } from 'react'
import { fmtInt } from '../../../lib/format'
import { Badge, Card, Table, Td } from '../../../components/ui'
import { Bars, ChartCard } from '../../../components/charts'
import { RankList } from '../../OverviewPage'
import { ProductGate, fmtSeconds, pct, useProduct } from './ProductGate'
import type { ScreenRow } from './types'

const paths = (rows: { screen: string; views: number }[]) => rows.slice(0, 3).map((r) => `${r.screen} (${fmtInt(r.views)})`).join(' · ') || '—'

/** Which pages get traction: views, people, time, exits, and paths in and out (DESIGN §7). */
export function ScreensTab({ days }: { days: number }) {
  const q = useProduct<{ screens: ScreenRow[] }>('screens', { days })
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <ProductGate query={q}>
      {(d) => {
        const top = d.screens.slice(0, 12)
        const focus = d.screens.find((s) => s.screen === selected) ?? d.screens[0]
        return (
          <>
            <ChartCard
              title="Most viewed screens"
              subtitle="screen_viewed per route; sheets that act as screens (Menu, Join, Plans) included."
              rows={top}
              columns={[
                { key: 'screen', label: 'Screen' },
                { key: 'views', label: 'Views' },
                { key: 'users', label: 'People' },
              ]}
            >
              <Bars data={top} x="screen" y="views" label="views" height={260} />
            </ChartCard>

            <Card title="Screens in detail" padded={false} description="Click a row for its paths in and out.">
              <Table head={['Screen', 'Views', 'People', 'Median time', 'Exit rate', 'Came from', 'Went to']}>
                {d.screens.map((s) => (
                  <tr key={s.screen} className={`cursor-pointer border-b ${focus?.screen === s.screen ? 'bg-muted/60' : ''}`} onClick={() => setSelected(s.screen)}>
                    <Td className="font-medium">{s.screen}</Td>
                    <Td className="tabular">
                      {fmtInt(s.views)}
                      {s.viewsChange !== null && Math.abs(s.viewsChange) >= 20 && (
                        <Badge tone={s.viewsChange > 0 ? 'green' : 'red'} className="ml-2">
                          {s.viewsChange > 0 ? '+' : ''}
                          {s.viewsChange}%
                        </Badge>
                      )}
                    </Td>
                    <Td className="tabular">{fmtInt(s.users)}</Td>
                    <Td className="tabular">{fmtSeconds(s.medianSeconds)}</Td>
                    <Td className="tabular">{s.exitRate !== null && s.exitRate >= 40 ? <Badge tone="amber">{pct(s.exitRate)}</Badge> : pct(s.exitRate)}</Td>
                    <Td className="text-xs text-muted-foreground">{paths(s.into)}</Td>
                    <Td className="text-xs text-muted-foreground">{paths(s.outOf)}</Td>
                  </tr>
                ))}
              </Table>
              <p className="px-4 py-3 text-xs text-muted-foreground">
                People: unique over the whole period. Median time: until the next screen in the session (capped at 30 min). Exit rate: views that were the
                session’s last screen. A high exit rate on a screen that should lead somewhere is a drop-off.
              </p>
            </Card>

            {focus && (
              <div className="grid gap-6 lg:grid-cols-2">
                <Card title={`Into “${focus.screen}”`} description="The screen before it in the same session; (entry) = the session started here.">
                  <RankList rows={focus.into.map((p) => ({ label: p.screen, value: p.views }))} unit="views" />
                </Card>
                <Card title={`Out of “${focus.screen}”`} description="The screen after it; (exit) = the session ended here.">
                  <RankList rows={focus.outOf.map((p) => ({ label: p.screen, value: p.views }))} unit="views" />
                </Card>
              </div>
            )}
          </>
        )
      }}
    </ProductGate>
  )
}
