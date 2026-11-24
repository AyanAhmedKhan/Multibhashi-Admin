import { fmtDay, fmtInt } from '../../../lib/format'
import { Card, Stat } from '../../../components/ui'
import { Bars, ChartCard, Line } from '../../../components/charts'
import { RankList } from '../../OverviewPage'
import { ProductGate, changeText, pct, useProduct } from './ProductGate'
import type { Overview } from './types'

/** DAU/WAU/MAU, new verified learners, activation, stickiness and a 13-week trend (DESIGN §7). */
export function ProductOverviewTab({ days }: { days: number }) {
  const q = useProduct<Overview>('overview', { days })
  return (
    <ProductGate query={q}>
      {(d) => (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label={`Active on ${fmtDay(d.range.to)} (DAU)`} value={fmtInt(d.totals.dau)} hint="signed-in learners" />
            <Stat label="Active, 7 days (WAU)" value={fmtInt(d.totals.wau)} />
            <Stat label="Active, 30 days (MAU)" value={fmtInt(d.totals.mau)} hint={`stickiness ${d.totals.stickiness}% (avg DAU ÷ MAU)`} />
            <Stat label={`New verified, ${days} days`} value={fmtInt(d.totals.newVerified)} hint={changeText(d.totals.newVerifiedChange)} />
            <Stat
              label="Activation"
              value={pct(d.totals.activation.rate)}
              hint={`first value within 7 days: ${fmtInt(d.totals.activation.activated)} of ${fmtInt(d.totals.activation.cohort)} who joined 7 days earlier`}
            />
            <Stat label={`Sessions, ${days} days`} value={fmtInt(d.totals.sessions)} hint={`${d.totals.avgSessionMinutes} min avg · ${changeText(d.totals.sessionsChange)}`} />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <ChartCard
              title="Active learners per day"
              subtitle={`Signed-in learners with an app session. ${fmtInt(d.totals.periodActive)} in the period (${changeText(d.totals.periodActiveChange)}).`}
              rows={d.series}
              columns={[
                { key: 'day', label: 'Day', format: (v) => fmtDay(String(v)) },
                { key: 'activeLearners', label: 'Active learners' },
                { key: 'visitors', label: 'Incl. visitors' },
                { key: 'sessions', label: 'Sessions' },
                { key: 'minutes', label: 'App minutes' },
              ]}
            >
              <Line data={d.series} x="day" y="activeLearners" xFormat={fmtDay} label="active learners" />
            </ChartCard>
            <ChartCard
              title="New verified learners per day"
              subtitle="Accounts that signed in, by the day they signed up (business facts from MySQL). OTP requests alone are not counted."
              rows={d.series}
              columns={[
                { key: 'day', label: 'Day', format: (v) => fmtDay(String(v)) },
                { key: 'signups', label: 'New verified' },
              ]}
            >
              <Bars data={d.series} x="day" y="signups" xFormat={fmtDay} label="new verified" />
            </ChartCard>
            <ChartCard
              title="13-week trend"
              subtitle="Weekly active learners (Monday-start weeks, IST). The current week is still filling in."
              rows={d.weekly}
              columns={[
                { key: 'week', label: 'Week of', format: (v) => fmtDay(String(v)) },
                { key: 'activeLearners', label: 'Active learners' },
                { key: 'signups', label: 'New verified' },
                { key: 'sessions', label: 'Sessions' },
              ]}
            >
              <Bars data={d.weekly} x="week" y="activeLearners" xFormat={fmtDay} label="weekly active learners" />
            </ChartCard>
            <Card title="Platforms" description="People with a session in the period, including visitors who haven’t signed in.">
              <RankList rows={d.platforms.map((p) => ({ label: p.platform, value: p.people }))} unit="people" />
            </Card>
          </div>
          {d.totals.activation.cohort > 0 && d.totals.activation.bySignup === 0 && (
            <p className="text-xs text-warning">
              Activation is measured from the day learners were first seen in the events: the sign-up date needs the identity link (sign-in v2, learner_accounts).
            </p>
          )}
        </>
      )}
    </ProductGate>
  )
}
