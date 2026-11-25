import { useState } from 'react'
import { fmtDay, fmtInt } from '../../../lib/format'
import { Card, Select } from '../../../components/ui'
import { shade, shadeInk } from '../../../components/charts'
import { ProductGate, useProduct } from './ProductGate'
import type { Retention } from './types'

const FEATURE_LABEL: Record<string, string> = {
  ai_tutor: 'AI tutor class',
  live_class: 'Live class joined',
  quiz: 'Quiz started',
  notes: 'Notes opened',
  recordings: 'Recording played',
  study_material: 'Study material',
  chat: 'Chat',
  plans: 'Plans viewed',
  '(none)': 'None yet',
}

/** Weekly cohorts by sign-up week, filtered by channel and first feature (DESIGN §7). */
export function RetentionTab({ days }: { days: number }) {
  const [basis, setBasis] = useState('')
  const [channel, setChannel] = useState('')
  const [feature, setFeature] = useState('')
  const q = useProduct<Retention>('retention', { days, basis: basis || undefined, channel: channel || undefined, feature: feature || undefined })
  return (
    <ProductGate query={q}>
      {(d) => (
        <Card
          title="Retention by week"
          padded={false}
          description="Share of each weekly cohort with an app session N weeks later (week 0 = the cohort week). Monday-start weeks, IST."
          actions={
            <>
              <Select aria-label="Cohort by" className="w-48" value={basis} onChange={(e) => setBasis(e.target.value)}>
                <option value="">Sign-up or first seen</option>
                <option value="signup">Verified sign-up week</option>
                <option value="first_seen">First seen in the app</option>
              </Select>
              <Select aria-label="Channel" className="w-44" value={channel} onChange={(e) => setChannel(e.target.value)}>
                <option value="">All channels</option>
                {d.channels.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.value} ({fmtInt(c.people)})
                  </option>
                ))}
              </Select>
              <Select aria-label="First feature" className="w-44" value={feature} onChange={(e) => setFeature(e.target.value)}>
                <option value="">Any first feature</option>
                {d.features.map((f) => (
                  <option key={f.value} value={f.value}>
                    {FEATURE_LABEL[f.value] ?? f.value} ({fmtInt(f.people)})
                  </option>
                ))}
              </Select>
            </>
          }
        >
          {d.cohorts.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="px-4 py-2 text-left font-medium">Cohort (week of)</th>
                    <th className="px-2 py-2 text-right font-medium">Learners</th>
                    {Array.from({ length: 12 }, (_, k) => (
                      <th key={k} className="px-1 py-2 text-center font-medium">
                        W{k}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.cohorts.map((c) => (
                    <tr key={c.week} className="border-b border-border">
                      <td className="whitespace-nowrap px-4 py-1.5">{fmtDay(c.week)}</td>
                      <td className="tabular px-2 text-right">{fmtInt(c.users)}</td>
                      {c.weeks.map((v, k) => (
                        <td key={k} className="px-0.5 py-0.5">
                          {v === null ? null : (
                            <div className="tabular rounded px-1 py-1 text-center text-xs" style={{ background: shade(v / 100), color: shadeInk(v / 100) }}>
                              {v}%
                            </div>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="px-4 py-6 text-sm text-muted-foreground">No cohorts for this filter yet.</p>
          )}
          <p className="px-4 py-3 text-xs text-muted-foreground">
            Cohort by sign-up week needs the identity link (sign-in v2) between the app’s learner and the verified account; until then learners are grouped by
            the week they were first seen in the events. Channel: the sign-up’s UTM source, else the first session’s.
          </p>
        </Card>
      )}
    </ProductGate>
  )
}
