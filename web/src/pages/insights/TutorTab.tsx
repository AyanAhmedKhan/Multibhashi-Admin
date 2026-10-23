import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { fmtInt, fmtMinutes } from '../../lib/format'
import { Card, ErrorNote, Spinner, Stat } from '../../components/ui'
import { Bars, ChartCard } from '../../components/charts'
import { RankList } from '../OverviewPage'

interface TutorInsights {
  classes: number
  learners: number
  minutesUsed: number
  avgClassMinutes: number
  learnerTurnsPerClass: number
  tutorTurnsPerClass: number
  returningShare: number
  peakConcurrentClasses: number
  languages: { language: string; classes: number; minutes: number }[]
  minutesMix: { kind: string; minutes: number }[]
  byHour: { hour: number; classes: number }[]
}

const LANG: Record<string, string> = {
  'hi-IN': 'Hindi', 'kn-IN': 'Kannada', 'ta-IN': 'Tamil', 'te-IN': 'Telugu', 'ml-IN': 'Malayalam', 'mr-IN': 'Marathi', 'bn-IN': 'Bengali',
  'gu-IN': 'Gujarati', 'pa-IN': 'Punjabi', 'od-IN': 'Odia', 'en-IN': 'English', 'es-ES': 'Spanish', 'fr-FR': 'French', 'de-DE': 'German', 'ja-JP': 'Japanese',
}

export function TutorTab({ days }: { days: number }) {
  const q = useQuery({ queryKey: ['insights-tutor', days], queryFn: () => api.get<TutorInsights>('insights/tutor', { days }) })
  if (q.isLoading) return <Spinner />
  if (q.error || !q.data) return <ErrorNote error={q.error} />
  const d = q.data
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Classes" value={fmtInt(d.classes)} hint={`${fmtInt(d.learners)} learners`} />
        <Stat label="Minutes taught" value={fmtMinutes(d.minutesUsed)} hint={`${d.avgClassMinutes} min per class on average`} />
        <Stat label="Learner turns per class" value={d.learnerTurnsPerClass} hint={`tutor: ${d.tutorTurnsPerClass}`} />
        <Stat label="Came back for another class" value={`${d.returningShare}%`} hint={`peak ${fmtInt(d.peakConcurrentClasses)} classes at once`} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Languages taught">
          <RankList rows={d.languages.map((l) => ({ label: LANG[l.language] ?? l.language, value: l.classes }))} unit="classes" />
          <p className="mt-3 text-xs text-muted-foreground">From class summaries (classes the tutor summarised).</p>
        </Card>
        <Card title="Where the minutes came from">
          <RankList rows={d.minutesMix.map((m) => ({ label: m.kind, value: m.minutes }))} unit="min" />
          <p className="mt-3 text-xs text-muted-foreground">Free = free classes; paid = purchases; complimentary = staff grants and AI Pro given without payment.</p>
        </Card>
      </div>
      <ChartCard
        title="Classes by hour of day (IST)"
        rows={d.byHour}
        columns={[
          { key: 'hour', label: 'Hour', format: (v) => `${v}:00` },
          { key: 'classes', label: 'Classes' },
        ]}
      >
        <Bars data={d.byHour} x="hour" y="classes" xFormat={(v) => `${v}:00`} label="classes" />
      </ChartCard>
    </div>
  )
}
