import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { fmtDateTime, fmtDay, fmtInt } from '../../lib/format'
import { Badge, Card, Empty, ErrorNote, Spinner, Stat, Table, Tabs, Td } from '../../components/ui'
import { Bars, ChartCard } from '../../components/charts'
import { RankList } from '../OverviewPage'
import { PATH_LABEL } from './QuizCostSection'
import { QuizReleaseLog } from './QuizReleaseLog'
import { QuizImpact } from './QuizImpact'

type Path = 'legacy' | 'counted' | 'evidence'
interface Summary {
  count: number
  mean: number | null
  median: number | null
  p95: number | null
}
interface Bucket {
  from: number
  to: number
  answers: number
}
interface ScoreBlock {
  relevance: Bucket[]
  grammar: Bucket[]
  pronunciation: Bucket[]
  final: Bucket[]
  means: { relevance: number | null; grammar: number | null; pronunciation: number | null; final: number | null }
  correctShare: number | null
}
interface Tally {
  key: string
  events: number
}
interface QuizInsights {
  days: number
  empty: 'no_tables' | 'no_answers' | null
  sources: { tables: { context: string; label: string; present: boolean; lsrw: boolean }[]; lsrw: boolean; evaluationCache: boolean }
  totals: {
    answers: number
    sq: number
    wq: number
    learners: number
    quizzes: number
    failed: number
    failedShare: number | null
    late: number
    lateShare: number | null
    noSpeech: number
    noSpeechShare: number | null
    emptyWriting: number
  }
  series: { day: string; sq: number; wq: number; failed: number; late: number; noSpeech: number; answers: number }[]
  paths: { path: Path; sq: number; wq: number; failed: number }[]
  failures: { reason: string; answers: number }[]
  retries: { evidenceAnswers: number; retried: number; retriedShare: number | null; cache: { assessments: number; retried: number } | null }
  scores: { sq: ScoreBlock; wq: ScoreBlock }
  length: { sqWords: Summary; wqWords: Summary; sqSeconds: Summary; wqSeconds: Summary }
  experience: {
    available: boolean
    firstSeenAt: number | null
    empty: 'no_table' | 'no_events_yet' | 'none_in_period' | null
    counts: { type: string; events: number }[]
    recording: { started: number; failed: number; failedShare: number | null; failures: Tally[]; stopped: number; seconds: Summary; stopReasons: Tally[]; deleted: number; rerecordedShare: number | null }
    stt: { results: number; noSpeechShare: number | null; failedShare: number | null; ms: Summary }
    marking: { results: number; failedShare: number | null; ms: Summary }
    submitFailures: Tally[]
    submitErrors: Tally[]
    feedbackWait: Summary
    submitted: { answers: number; timedOut: number }
    timeouts: { events: number; hadAnswerShare: number | null }
    pasteBlocked: number
    questionsShown: number
    series: { day: string; shown: number; submitted: number; problems: number }[]
  }
}

const REASON_LABEL: Record<string, string> = {
  'no score returned': 'No score returned (scores empty)',
  request_timeout: 'OpenAI request timed out',
  evaluation_deadline: 'Marking deadline (75 s) passed',
  provider_error: 'OpenAI error',
  no_reply: 'No reply from OpenAI',
  invalid_evidence: 'Evidence failed validation',
  invalid_response_schema: 'Reply did not match the schema',
  invalid_review: 'Independent review failed validation',
  evaluation_error: 'Marking crashed',
  assessment_cache_unavailable: 'Assessment cache unavailable',
  signing_key_unavailable: 'Signing key missing',
  empty_answer: 'Empty answer',
  unknown: 'Failed (no reason recorded)',
}
const ERROR_LABEL: Record<string, string> = {
  NotAllowedError: 'Microphone permission denied',
  NotFoundError: 'No microphone found',
  NotReadableError: 'Microphone busy or unreadable',
  SecurityError: 'Blocked by browser security',
  unsupported: 'Recording not supported',
  other: 'Other',
}
const STOP_LABEL: Record<string, string> = { user: 'Learner stopped', cap: 'Hit the length cap', timeout: 'Question timer ran out', blur: 'Left the app', unmount: 'Left the screen' }
const STAGE_LABEL: Record<string, string> = { convert: 'Converting the recording', stt: 'Speech-to-text upload', eval: 'Marking' }

const pct = (v: number | null) => (v === null ? '—' : `${v}%`)
const ms = (v: number | null) => (v === null ? '—' : v >= 10_000 ? `${(v / 1000).toFixed(0)} s` : `${(v / 1000).toFixed(1)} s`)
const secs = (v: number | null) => (v === null ? '—' : `${Math.round(v)} s`)

type Metric = 'relevance' | 'grammar' | 'pronunciation' | 'final'
const METRIC_LABEL: Record<Metric, string> = { relevance: 'Relevance (0–10)', grammar: 'Grammar (0–10)', pronunciation: 'Pronunciation (0–10)', final: 'Final % (LSRW)' }

function ScoreChart({ title, block, metrics }: { title: string; block: ScoreBlock; metrics: Metric[] }) {
  const [metric, setMetric] = useState<Metric>(metrics[0])
  const rows = block[metric].map((b) => ({ bucket: metric === 'final' ? `${b.from}–${b.to}%` : `${b.from}–${b.to}`, answers: b.answers }))
  const scored = rows.reduce((s, r) => s + r.answers, 0)
  const mean = block.means[metric]
  return (
    <ChartCard
      title={title}
      subtitle={
        <>
          {scored ? `${fmtInt(scored)} scored · mean ${mean === null ? '—' : mean.toFixed(1)}` : 'No scores for this measure in the period'}
          {block.correctShare !== null && ` · ${block.correctShare}% marked correct`}
        </>
      }
      rows={rows}
      columns={[
        { key: 'bucket', label: 'Score' },
        { key: 'answers', label: 'Answers' },
      ]}
    >
      <Tabs value={metric} onChange={setMetric} items={metrics.map((m) => ({ value: m, label: METRIC_LABEL[m] }))} />
      <Bars data={rows} x="bucket" y="answers" label="answers" height={200} />
    </ChartCard>
  )
}

export function QuizzesTab({ days }: { days: number }) {
  const q = useQuery({ queryKey: ['insights-quizzes', days], queryFn: () => api.get<QuizInsights>('insights/quizzes', { days }) })
  if (q.isLoading) return <Spinner />
  if (q.error || !q.data) return <ErrorNote error={q.error} />
  const d = q.data
  const t = d.totals
  const x = d.experience
  const missing = d.sources.tables.filter((s) => !s.present)

  return (
    <div className="space-y-6">
      <QuizReleaseLog />
      <QuizImpact />
      {d.empty === 'no_tables' ? (
        <Card>
          <Empty title="The quiz answer tables aren’t in this database">
            None of user_quiz_log_details, webinar_class_quiz_log_details or session_call_quiz_log_details (with their logs and quiz_questions) were found.
          </Empty>
        </Card>
      ) : (
        <>
          {(!d.sources.lsrw || missing.length > 0) && (
            <div className="rounded-lg border border-border bg-muted px-3 py-2 text-sm text-ink-2">
              {!d.sources.lsrw && (
                <>
                  <b>No LSRW marking columns</b> in this database (scoring_version, prompt_version, evaluation_status): every answer counts as legacy marking and failures are
                  answers that came back without scores.{' '}
                </>
              )}
              {missing.length > 0 && <>Not in this database: {missing.map((m) => m.label).join(', ')}.</>}
            </div>
          )}

          {d.empty === 'no_answers' ? (
            <Card>
              <Empty title={`No Speaking or Writing answers in the last ${days} days`}>Quiz volume, marking and scores appear here once learners answer SQ or WQ questions.</Empty>
            </Card>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                <Stat label="Speaking answers" value={fmtInt(t.sq)} hint={`${fmtInt(t.learners)} learners · ${fmtInt(t.quizzes)} quizzes`} />
                <Stat label="Writing answers" value={fmtInt(t.wq)} hint={t.emptyWriting ? `${fmtInt(t.emptyWriting)} submitted empty` : 'none submitted empty'} />
                <Stat label="Marking failed" value={pct(t.failedShare)} tone={t.failedShare !== null && t.failedShare >= 5 ? 'red' : undefined} hint={`${fmtInt(t.failed)} answers without a mark`} />
                <Stat label="Not finished on time" value={pct(t.lateShare)} hint={`${fmtInt(t.late)} answers`} />
                <Stat label="No speech (Speaking)" value={pct(t.noSpeechShare)} hint={`${fmtInt(t.noSpeech)} empty transcripts`} />
                <Stat
                  label="Evidence marking retried"
                  value={d.retries.evidenceAnswers ? pct(d.retries.retriedShare) : '—'}
                  hint={d.retries.evidenceAnswers ? `${fmtInt(d.retries.retried)} of ${fmtInt(d.retries.evidenceAnswers)} needed a second attempt` : 'no evidence-marked answers'}
                />
              </div>

              <ChartCard
                title="Speaking and Writing answers per day"
                rows={d.series}
                columns={[
                  { key: 'day', label: 'Day', format: (v) => fmtDay(String(v)) },
                  { key: 'sq', label: 'Speaking' },
                  { key: 'wq', label: 'Writing' },
                  { key: 'failed', label: 'Marking failed' },
                  { key: 'late', label: 'Not on time' },
                  { key: 'noSpeech', label: 'No speech' },
                ]}
              >
                <Bars data={d.series} x="day" y="answers" xFormat={fmtDay} label="answers" />
              </ChartCard>

              <div className="grid gap-6 lg:grid-cols-2">
                <Card title="Marking path" padded={false}>
                  <Table head={['Path', 'Speaking', 'Writing', 'Failed']}>
                    {d.paths.map((p) => (
                      <tr key={p.path}>
                        <Td>{PATH_LABEL[p.path]}</Td>
                        <Td className="tabular">{fmtInt(p.sq)}</Td>
                        <Td className="tabular">{fmtInt(p.wq)}</Td>
                        <Td className="tabular">{p.failed ? <Badge tone="red">{fmtInt(p.failed)}</Badge> : '0'}</Td>
                      </tr>
                    ))}
                  </Table>
                  <p className="px-4 py-3 text-xs text-muted-foreground">
                    Legacy: no LSRW columns or scoring_version empty. Counted: scoring_version 2. Evidence: prompt english-evidence-*, scoring_version 3 (grammar, independent review,
                    content).
                    {d.retries.cache && ` Evidence cache: ${fmtInt(d.retries.cache.assessments)} accepted assessments in the period, ${fmtInt(d.retries.cache.retried)} after a retry.`}
                  </p>
                </Card>
                <Card title="Why marking failed">
                  {d.failures.length ? (
                    <RankList rows={d.failures.map((f) => ({ label: REASON_LABEL[f.reason] ?? f.reason, value: f.answers }))} unit="answers" />
                  ) : (
                    <p className="text-sm text-muted-foreground">No marking failures in this period.</p>
                  )}
                  <p className="mt-3 text-xs text-muted-foreground">From evaluation_status and the stored failure reason; answers without any score are counted too.</p>
                </Card>
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                <ScoreChart title="Speaking scores" block={d.scores.sq} metrics={['relevance', 'grammar', 'pronunciation', ...(d.sources.lsrw ? (['final'] as Metric[]) : [])]} />
                <ScoreChart title="Writing scores" block={d.scores.wq} metrics={['relevance', 'grammar', ...(d.sources.lsrw ? (['final'] as Metric[]) : [])]} />
              </div>

              <Card title="Answer length" padded={false}>
                <Table head={['', 'Words (median · p95)', 'Time taken (median · p95)']}>
                  <tr>
                    <Td className="font-medium">Speaking</Td>
                    <Td className="tabular">{d.length.sqWords.count ? `${fmtInt(d.length.sqWords.median)} · ${fmtInt(d.length.sqWords.p95)}` : '—'}</Td>
                    <Td className="tabular">{d.length.sqSeconds.count ? `${secs(d.length.sqSeconds.median)} · ${secs(d.length.sqSeconds.p95)}` : '—'}</Td>
                  </tr>
                  <tr>
                    <Td className="font-medium">Writing</Td>
                    <Td className="tabular">{d.length.wqWords.count ? `${fmtInt(d.length.wqWords.median)} · ${fmtInt(d.length.wqWords.p95)}` : '—'}</Td>
                    <Td className="tabular">{d.length.wqSeconds.count ? `${secs(d.length.wqSeconds.median)} · ${secs(d.length.wqSeconds.p95)}` : '—'}</Td>
                  </tr>
                </Table>
                <p className="px-4 py-3 text-xs text-muted-foreground">Words are counted inside the database; answer text is never read out or shown.</p>
              </Card>
            </>
          )}
        </>
      )}

      <h2 className="pt-2 text-base font-semibold">Learner experience</h2>
      {x.empty ? (
        <Card>
          <Empty title={x.empty === 'no_table' ? 'No activity events table in this database' : x.empty === 'no_events_yet' ? 'No quiz app events yet' : 'No quiz app events in this period'}>
            {x.empty === 'no_table'
              ? 'student_activity_events was not found.'
              : x.empty === 'no_events_yet'
                ? 'Recording, upload, marking and wait times come from the app’s quiz_* events (quiz_record_started, quiz_stt_result, quiz_feedback_shown…). They arrive with the app release that sends them; nothing is shown until then.'
                : `The app has sent quiz events since ${fmtDateTime(x.firstSeenAt ? new Date(x.firstSeenAt) : null)}, but none in the last ${days} days.`}
          </Empty>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Recording couldn’t start" value={pct(x.recording.failedShare)} tone={x.recording.failedShare !== null && x.recording.failedShare >= 5 ? 'red' : undefined} hint={`${fmtInt(x.recording.failed)} of ${fmtInt(x.recording.started + x.recording.failed)} tries`} />
            <Stat label="Recording length" value={secs(x.recording.seconds.median)} hint={`median · p95 ${secs(x.recording.seconds.p95)} · ${fmtInt(x.recording.stopped)} recordings`} />
            <Stat label="Re-recorded" value={pct(x.recording.rerecordedShare)} hint={`${fmtInt(x.recording.deleted)} recordings deleted`} />
            <Stat label="No speech heard" value={pct(x.stt.noSpeechShare)} hint={`speech-to-text failed ${pct(x.stt.failedShare)} · ${fmtInt(x.stt.results)} results`} />
            <Stat label="Submit → feedback" value={ms(x.feedbackWait.median)} hint={`median · p95 ${ms(x.feedbackWait.p95)} · ${fmtInt(x.feedbackWait.count)} answers`} />
            <Stat label="Paste blocked" value={fmtInt(x.pasteBlocked)} hint={`${fmtInt(x.timeouts.events)} question timeouts${x.timeouts.hadAnswerShare !== null ? `, ${x.timeouts.hadAnswerShare}% with an answer` : ''}`} />
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card title="Why recording couldn’t start">
              {x.recording.failures.length ? (
                <RankList rows={x.recording.failures.map((f) => ({ label: ERROR_LABEL[f.key] ?? f.key, value: f.events }))} unit="times" />
              ) : (
                <p className="text-sm text-muted-foreground">Every recording started.</p>
              )}
            </Card>
            <Card title="How recordings ended">
              <RankList rows={x.recording.stopReasons.map((f) => ({ label: STOP_LABEL[f.key] ?? f.key, value: f.events }))} unit="recordings" />
            </Card>
            <Card title="Where submitting failed">
              {x.submitFailures.length ? (
                <>
                  <RankList rows={x.submitFailures.map((f) => ({ label: STAGE_LABEL[f.key] ?? f.key, value: f.events }))} unit="answers" />
                  {x.submitErrors.length > 0 && (
                    <p className="mt-3 text-xs text-muted-foreground">Most common errors: {x.submitErrors.map((e) => `${e.key} (${fmtInt(e.events)})`).join(', ')}</p>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">No failed submissions in this period.</p>
              )}
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Waits the learner sees" padded={false}>
              <Table head={['Step', 'Results', 'Median', 'p95', 'Failed']}>
                <tr>
                  <Td>Speech-to-text</Td>
                  <Td className="tabular">{fmtInt(x.stt.results)}</Td>
                  <Td className="tabular">{ms(x.stt.ms.median)}</Td>
                  <Td className="tabular">{ms(x.stt.ms.p95)}</Td>
                  <Td className="tabular">{pct(x.stt.failedShare)}</Td>
                </tr>
                <tr>
                  <Td>Marking</Td>
                  <Td className="tabular">{fmtInt(x.marking.results)}</Td>
                  <Td className="tabular">{ms(x.marking.ms.median)}</Td>
                  <Td className="tabular">{ms(x.marking.ms.p95)}</Td>
                  <Td className="tabular">{pct(x.marking.failedShare)}</Td>
                </tr>
                <tr>
                  <Td>Submit → feedback screen</Td>
                  <Td className="tabular">{fmtInt(x.feedbackWait.count)}</Td>
                  <Td className="tabular">{ms(x.feedbackWait.median)}</Td>
                  <Td className="tabular">{ms(x.feedbackWait.p95)}</Td>
                  <Td className="tabular">—</Td>
                </tr>
              </Table>
              <p className="px-4 py-3 text-xs text-muted-foreground">
                Measured in the app. {fmtInt(x.submitted.answers)} answers submitted{x.submitted.timedOut ? `, ${fmtInt(x.submitted.timedOut)} by the timer` : ''}.
              </p>
            </Card>
            <ChartCard
              title="Questions shown and answers submitted per day"
              subtitle="From the app"
              rows={x.series}
              columns={[
                { key: 'day', label: 'Day', format: (v) => fmtDay(String(v)) },
                { key: 'shown', label: 'Questions shown' },
                { key: 'submitted', label: 'Answers submitted' },
                { key: 'problems', label: 'Recording or submit failures' },
              ]}
            >
              <Bars data={x.series} x="day" y="submitted" xFormat={fmtDay} label="submitted" />
            </ChartCard>
          </div>
        </>
      )}
    </div>
  )
}
