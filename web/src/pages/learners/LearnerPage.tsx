import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Brain, Download, Eye, Trash2 } from 'lucide-react'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { fmtDateTime, fmtInt, fmtMinutes } from '../../lib/format'
import { useReason } from '../../components/dialogs'
import { Badge, Button, Card, ErrorNote, KeyValue, PageHeader, Spinner, Stat, Table, Td } from '../../components/ui'
import { statusTone } from '../tutor/ClassesPage'
import { AiProPanel } from './AiProPanel'

interface LearnerDetail {
  learner: { id: number; name: string | null; email: string | null; phone: string | null; createdAt: string | null }
  stats: { classes: number; minutesUsed: number; minutesLeft: number; freeGrantsLast24h: number }
  memory: { version: number; erasedAt: string | null; updatedAt: string | null } | null
  classes: { id: number; status: string | null; lesson_topic: string | null; total_minutes: number; remaining_minutes: number; time_spent: number; created_at: string }[]
}

interface Memory {
  profile: { memory: { facts?: string[]; preferences?: string[]; languages?: Record<string, { level?: string; strengths?: string[]; struggles?: string[]; mastered?: string[]; practice_next?: string[] }> }; version: number; erasedAt: string | null } | null
  summaries: { id: number; classId: number; language: string | null; summary: string; updatedAt: string }[]
}

export function LearnerPage() {
  const { id } = useParams()
  const { can } = useAuth()
  const ask = useReason()
  const queryClient = useQueryClient()
  const detail = useQuery({ queryKey: ['learner', id], queryFn: () => api.get<LearnerDetail>(`learners/${id}`) })
  const [revealed, setRevealed] = useState<{ name: string | null; email: string | null; phone: string | null } | null>(null)
  const [memory, setMemory] = useState<Memory | null>(null)

  if (detail.isLoading) return <Spinner />
  if (detail.error || !detail.data) return <ErrorNote error={detail.error} />
  const { learner, stats } = detail.data
  const shown = revealed ?? learner

  const reveal = () =>
    ask({
      title: 'Reveal contact details',
      description: 'Only when you need to contact this learner or confirm who they are. Recorded with your reason.',
      confirmLabel: 'Reveal',
      run: async (reason) => setRevealed(await api.post(`learners/${id}/reveal`, { reason })),
    })

  const viewMemory = () =>
    ask({
      title: 'Read what the tutor remembers',
      description: 'The learner profile and class summaries the AI tutor uses to personalise classes.',
      confirmLabel: 'Open memory',
      run: async (reason) => setMemory(await api.post<Memory>(`learners/${id}/memory`, { reason })),
    })

  const eraseMemory = () =>
    ask({
      title: 'Erase AI tutor memory',
      description: (
        <>
          Deletes the learner’s profile and every class summary, exactly like saying “forget everything” in class. A class in progress can’t write the old
          memory back. This can’t be undone.
        </>
      ),
      confirmText: 'ERASE',
      confirmLabel: 'Erase memory',
      danger: true,
      run: async (reason) => {
        await api.post(`learners/${id}/memory/erase`, { reason })
        setMemory(null)
        await queryClient.invalidateQueries({ queryKey: ['learner', id] })
      },
    })

  const exportData = () =>
    ask({
      title: 'Export this learner’s data',
      description: 'A JSON file with everything the AI tutor holds about them, for a data access request (DPDP Act). Handle it as personal data.',
      confirmLabel: 'Download',
      run: async (reason) => {
        const data = await api.post(`learners/${id}/export`, { reason })
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
        const a = document.createElement('a')
        a.href = url
        a.download = `learner-${id}-ai-tutor-data.json`
        a.click()
        URL.revokeObjectURL(url)
      },
    })

  return (
    <>
      <PageHeader
        title={shown.name ?? `Learner #${learner.id}`}
        subtitle={`Learner #${learner.id} · joined ${fmtDateTime(learner.createdAt)}`}
        actions={
          <>
            {can('learners.pii.read') && !revealed && (
              <Button icon={<Eye className="size-4" />} onClick={reveal}>
                Reveal contact
              </Button>
            )}
            {can('learners.export') && (
              <Button icon={<Download className="size-4" />} onClick={exportData}>
                Export data
              </Button>
            )}
          </>
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="AI tutor classes" value={fmtInt(stats.classes)} />
        <Stat label="Minutes used" value={fmtMinutes(stats.minutesUsed)} />
        <Stat label="Minutes left (all classes)" value={fmtMinutes(stats.minutesLeft)} />
        <Stat label="Free grants, last 24 h" value={fmtInt(stats.freeGrantsLast24h)} tone={stats.freeGrantsLast24h >= 8 ? 'amber' : undefined} hint="tutor API cap (default 10 a day)" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Contact">
          <KeyValue
            items={[
              ['Name', shown.name ?? '—'],
              ['Phone', <span className="tabular">{shown.phone ?? '—'}</span>],
              ['Email', shown.email ?? '—'],
              ['Shown', revealed ? <Badge tone="amber">revealed (audited)</Badge> : <Badge>masked</Badge>],
            ]}
          />
        </Card>
        {can('tutor.access.read') ? <AiProPanel learnerId={learner.id} /> : <div />}

        <Card title="AI tutor classes" className="lg:col-span-2" padded={false}>
          <Table head={['Class', 'Lesson', 'Status', 'Used / total', 'Left', 'Started']}>
            {detail.data.classes.map((c) => (
              <tr key={c.id} className="hover:bg-surface-2">
                <Td>
                  <Link className="font-medium text-primary" to={`/tutor/classes/${c.id}`}>#{c.id}</Link>
                </Td>
                <Td>{c.lesson_topic ?? <span className="text-ink-3">Not started yet</span>}</Td>
                <Td><Badge tone={statusTone(c.status)}>{c.status ?? 'unknown'}</Badge></Td>
                <Td className="tabular whitespace-nowrap">{fmtMinutes(c.time_spent)} / {fmtMinutes(c.total_minutes)}</Td>
                <Td className="tabular">{fmtMinutes(c.remaining_minutes)}</Td>
                <Td className="whitespace-nowrap">{fmtDateTime(c.created_at)}</Td>
              </tr>
            ))}
            {!detail.data.classes.length && (
              <tr><Td className="text-ink-3">No AI tutor classes yet.</Td></tr>
            )}
          </Table>
        </Card>

        {(can('tutor.memory.read') || can('tutor.memory.erase')) && (
          <Card
            title={<span className="inline-flex items-center gap-2"><Brain className="size-4 text-violet" aria-hidden /> Tutor memory</span>}
            className="lg:col-span-2"
            actions={
              <>
                {can('tutor.memory.read') && !memory && <Button size="sm" onClick={viewMemory}>View</Button>}
                {can('tutor.memory.erase') && <Button size="sm" variant="danger" icon={<Trash2 className="size-4" />} onClick={eraseMemory}>Erase</Button>}
              </>
            }
          >
            {!memory ? (
              <p className="text-sm text-ink-2">
                {detail.data.memory
                  ? `Profile version ${detail.data.memory.version}, updated ${fmtDateTime(detail.data.memory.updatedAt)}${detail.data.memory.erasedAt ? ` · last erased ${fmtDateTime(detail.data.memory.erasedAt)}` : ''}.`
                  : 'The tutor has no memory of this learner yet.'}
              </p>
            ) : (
              <div className="space-y-4 text-sm">
                {!memory.profile || !Object.keys(memory.profile.memory ?? {}).length ? (
                  <p className="text-ink-3">The profile is empty.</p>
                ) : (
                  <>
                    {!!memory.profile.memory.facts?.length && <div><div className="text-xs text-ink-3">Facts</div><p>{memory.profile.memory.facts.join(' · ')}</p></div>}
                    {Object.entries(memory.profile.memory.languages ?? {}).map(([lang, m]) => (
                      <div key={lang} className="rounded-lg bg-surface-2 p-3">
                        <div className="font-medium">{lang} · {m.level ?? 'level unknown'}</div>
                        {m.strengths?.length ? <div className="text-ink-2">Strong: {m.strengths.join(', ')}</div> : null}
                        {m.struggles?.length ? <div className="text-ink-2">Struggles: {m.struggles.join(', ')}</div> : null}
                        {m.practice_next?.length ? <div className="text-ink-2">Practise next: {m.practice_next.join(', ')}</div> : null}
                      </div>
                    ))}
                  </>
                )}
                <div>
                  <div className="mb-1 text-xs text-ink-3">Class summaries ({memory.summaries.length})</div>
                  <ul className="space-y-2">
                    {memory.summaries.map((s) => (
                      <li key={s.id} className="rounded-lg border border-line p-2">
                        <div className="text-xs text-ink-3">Class #{s.classId} · {s.language ?? '—'} · {fmtDateTime(s.updatedAt)}</div>
                        <p className="text-ink-2">{s.summary}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  )
}
