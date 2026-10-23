import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, Plus, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { fmtDateTime, fmtInt, fmtMinutes, fmtQuantity, inr } from '../../lib/format'
import { useReason } from '../../components/dialogs'
import { Badge, Button, Card, ErrorNote, Field, Input, KeyValue, PageHeader, Spinner, Table, Td } from '../../components/ui'
import { statusTone } from './ClassesPage'

interface ClassCost {
  recorded: boolean
  jobs: number
  totalInr: number
  items: { engine: string; kind: string; provider: string; model: string; unit: string; unitLabel: string; label: string | null; quantity: number; costInr: number; priced: boolean }[]
}

interface ClassDetail {
  id: number
  userId: number
  quizId: number | null
  quizQuestionId: number | null
  status: string | null
  totalMinutes: number | null
  remainingMinutes: number | null
  timeSpent: number | null
  topic: string | null
  roomName: string | null
  historyStartDetailId: number | null
  createdAt: string
  updatedAt: string | null
  lessonChars: number
  messages: Record<string, number>
  ledger: { id: number; source: string; minutes_added: number; previous_total: number; new_total: number; ai_tutor_chat_id: number | null; created_at: string }[]
  grants: { id: number; source: string; minutes: number; created_at: string }[]
  hasSummary: boolean
}

interface Transcript {
  resetAfterId: number | null
  messages: { id: number; chat: string; chat_from: string; chat_type: string | null; created_at: string }[]
  summary: { summary: string; details: { topics?: string[]; mistakes?: string[]; next_steps?: string[] } | null } | null
}

export function ClassPage() {
  const { id } = useParams()
  const { can, me } = useAuth()
  const ask = useReason()
  const queryClient = useQueryClient()
  const detail = useQuery({ queryKey: ['class', id], queryFn: () => api.get<ClassDetail>(`tutor/classes/${id}`) })
  const cost = useQuery({
    queryKey: ['class-cost', id],
    queryFn: () => api.get<ClassCost>(`tutor/classes/${id}/cost`),
    enabled: can('analytics.cost.read'),
  })
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [minutes, setMinutes] = useState('15')
  const [notice, setNotice] = useState<string | null>(null)

  if (detail.isLoading) return <Spinner />
  if (detail.error || !detail.data) return <ErrorNote error={detail.error} />
  const c = detail.data
  const limit = me?.policy.grantDirectLimit ?? 60
  const minutesNum = Number(minutes)

  const openTranscript = () =>
    ask({
      title: 'Read the transcript',
      description: 'Transcripts are the learner’s own words. Your name and reason are recorded.',
      confirmLabel: 'Open transcript',
      run: async (reason) => setTranscript(await api.post<Transcript>(`tutor/classes/${c.id}/transcript`, { reason })),
    })

  const removing = minutesNum < 0
  const grant = () =>
    ask({
      title: removing ? `Remove ${-minutesNum} minutes` : `Grant ${minutesNum} minutes`,
      description: removing ? (
        <>
          Takes {-minutesNum} minutes off this class ({fmtMinutes(c.totalMinutes)} → about {fmtMinutes((c.totalMinutes ?? 0) + minutesNum)}). Minutes the learner already used
          can’t be removed.
        </>
      ) : minutesNum > limit ? (
          <>
            Grants above {limit} minutes need a second person: this creates an <b>approval request</b>. Nothing changes until it is approved.
          </>
        ) : (
          <>
            Adds {minutesNum} minutes to this class now ({fmtMinutes(c.totalMinutes)} → about {fmtMinutes((c.totalMinutes ?? 0) + minutesNum)}). If the
            class is live, the learner gets them the next time they start or resume it.
          </>
        ),
      confirmLabel: removing ? 'Remove minutes' : minutesNum > limit ? 'Request approval' : 'Grant minutes',
      danger: removing,
      run: async (reason) => {
        const res = await api.post<{ status: string; approvalId?: number; new_total?: number }>(`tutor/classes/${c.id}/grant`, { minutes: minutesNum, reason })
        if (res.status === 'pending_approval') toast.info(`Approval request #${res.approvalId} created. It runs once someone else approves it.`)
        else toast.success(`Done. The class total is now ${fmtMinutes(res.new_total)}.`)
        setNotice(res.status === 'pending_approval' ? `Waiting for approval #${res.approvalId}.` : `Done. The class total is now ${fmtMinutes(res.new_total)}.`)
        await queryClient.invalidateQueries({ queryKey: ['class', id] })
      },
    })

  return (
    <>
      <PageHeader
        title={`Class #${c.id}`}
        subtitle={
          <>
            {c.topic ?? 'Lesson'} · learner <Link to={`/learners/${c.userId}`} className="text-primary">#{c.userId}</Link>
          </>
        }
        actions={
          can('tutor.transcripts.read') && (
            <Button icon={<FileText className="size-4" />} onClick={openTranscript}>
              Read transcript
            </Button>
          )
        }
      />
      {notice && <div className="mb-4 rounded-lg border border-border bg-success-soft px-3 py-2 text-sm text-success">{notice}</div>}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Class" className="lg:col-span-2">
          <KeyValue
            items={[
              ['Status', <Badge tone={statusTone(c.status)}>{c.status ?? 'unknown'}</Badge>],
              ['Minutes', `${fmtMinutes(c.timeSpent)} used · ${fmtMinutes(c.remainingMinutes)} left of ${fmtMinutes(c.totalMinutes)}`],
              ['Lesson / question', `quiz ${c.quizId ?? '—'} · question ${c.quizQuestionId ?? '—'}`],
              ['Messages', `${fmtInt(c.messages.user)} from learner · ${fmtInt(c.messages.ai)} from tutor`],
              ['Created', fmtDateTime(c.createdAt)],
              ['Last update', fmtDateTime(c.updatedAt)],
              ['Room', <code className="text-xs">{c.roomName ?? '—'}</code>],
              ['Lesson text', `${fmtInt(c.lessonChars)} characters`],
              ...(c.historyStartDetailId
                ? ([['Reset', <Badge tone="violet"><RotateCcw className="size-3" /> learner restarted this class</Badge>]] as [string, React.ReactNode][])
                : []),
            ]}
          />
        </Card>
        {can('tutor.minutes.grant') && (
          <Card title="Add or remove minutes">
            <div className="space-y-3">
              <Field label="Minutes (negative removes)" hint={`Adding up to ${limit} min runs at once; more needs a second approver (max ${me?.policy.grantMax}).`}>
                {(fid) => <Input id={fid} type="number" min={-(me?.policy.grantMax ?? 600)} max={me?.policy.grantMax} value={minutes} onChange={(e) => setMinutes(e.target.value)} />}
              </Field>
              <Button variant={removing ? 'danger' : 'primary'} className="w-full" icon={<Plus className="size-4" />} disabled={!Number.isInteger(minutesNum) || minutesNum === 0} onClick={grant}>
                {removing ? 'Remove' : minutesNum > limit ? 'Request approval' : 'Grant'}
              </Button>
            </div>
          </Card>
        )}
      </div>

      {cost.data?.recorded && (
        <Card
          title={`AI cost of this class: ${inr(cost.data.totalInr, 2)}`}
          className="mt-6"
          padded={false}
          actions={<span className="text-xs text-muted-foreground">{cost.data.jobs} agent run{cost.data.jobs === 1 ? '' : 's'}{c.timeSpent ? ` · ${inr(cost.data.totalInr / c.timeSpent, 2)}/min` : ''}</span>}
        >
          {cost.data.items.length ? (
            <Table head={['Service', 'Usage', 'Cost']}>
              {cost.data.items.map((i) => (
                <tr key={`${i.kind}-${i.provider}-${i.model}-${i.unit}`}>
                  <Td>
                    {i.label ?? `${i.provider} ${i.model}`}
                    <div className="text-xs text-muted-foreground">{i.kind} · {i.model || 'any model'}</div>
                  </Td>
                  <Td className="tabular">{fmtQuantity(i.quantity, i.unit)}</Td>
                  <Td className="tabular">{i.priced ? inr(i.costInr, 3) : <Badge tone="red">no price</Badge>}</Td>
                </tr>
              ))}
            </Table>
          ) : (
            <p className="p-5 text-sm text-muted-foreground">No usage was recorded for this class (it ran before recording started); Insights estimates it.</p>
          )}
        </Card>
      )}

      <Card title="Minutes ledger for this lesson" className="mt-6" padded={false}>
        <Table head={['When', 'Source', 'Added', 'Total after', 'Class']}>
          {c.ledger.map((l) => (
            <tr key={l.id}>
              <Td className="whitespace-nowrap">{fmtDateTime(l.created_at)}</Td>
              <Td>
                <Badge tone={l.source.startsWith('console_') || l.source === 'manual_grant' ? 'violet' : l.source === 'free' ? 'green' : 'blue'}>{l.source}</Badge>
              </Td>
              <Td className="tabular">{l.minutes_added > 0 ? '+' : ''}{l.minutes_added}</Td>
              <Td className="tabular">{l.new_total}</Td>
              <Td>{l.ai_tutor_chat_id ? `#${l.ai_tutor_chat_id}` : '—'}</Td>
            </tr>
          ))}
          {!c.ledger.length && (
            <tr>
              <Td className="text-muted-foreground">No ledger rows (a class the tutor opened without a purchase record).</Td>
            </tr>
          )}
        </Table>
      </Card>

      {transcript && (
        <Card title="Transcript" className="mt-6" actions={<Button size="sm" variant="ghost" onClick={() => setTranscript(null)}>Hide</Button>}>
          {transcript.summary && (
            <div className="mb-4 rounded-lg bg-muted p-3 text-sm">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Tutor’s class summary</div>
              <p className="mt-1 text-ink-2">{transcript.summary.summary}</p>
            </div>
          )}
          <ol className="space-y-2">
            {transcript.messages.map((m) => (
              <li key={m.id}>
                <div className={m.chat_from === 'user' ? 'ml-auto max-w-[85%] rounded-xl bg-success-soft px-3 py-2' : 'max-w-[85%] rounded-xl bg-muted px-3 py-2'}>
                  <div className="text-[11px] text-muted-foreground">
                    {m.chat_from === 'user' ? 'Learner' : 'Tutor'} · {fmtDateTime(m.created_at)}
                  </div>
                  <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">{m.chat}</p>
                </div>
                {transcript.resetAfterId === m.id && (
                  <div className="my-3 flex items-center gap-2 text-xs text-violet">
                    <span className="h-px flex-1 bg-border" /> Learner reset the class here: the tutor only remembers what follows <span className="h-px flex-1 bg-border" />
                  </div>
                )}
              </li>
            ))}
            {!transcript.messages.length && <p className="text-sm text-muted-foreground">No messages were saved for this class.</p>}
          </ol>
        </Card>
      )}
    </>
  )
}
