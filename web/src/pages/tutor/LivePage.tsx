import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, PhoneOff, User } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { fmtAgo, fmtMinutes } from '../../lib/format'
import { useReason } from '../../components/dialogs'
import { Badge, Button, Card, Empty, ErrorNote, PageHeader, Spinner, Table, Td } from '../../components/ui'

interface LiveRoom {
  room: string
  createdAt: string | null
  participants: { identity: string; isAgent: boolean; joinedAt: string | null }[]
  class: { id: number; userId: number; topic: string | null; status: string | null; totalMinutes: number | null; remainingMinutes: number | null } | null
}

export function LivePage() {
  const { can } = useAuth()
  const ask = useReason()
  const queryClient = useQueryClient()
  const live = useQuery({ queryKey: ['live'], queryFn: () => api.get<LiveRoom[]>('tutor/live', undefined, { background: true }), refetchInterval: 10_000 })

  const end = (room: LiveRoom) =>
    ask({
      title: 'End this class?',
      description: (
        <>
          The tutor and learner are disconnected now. The class is saved as paused with the minutes left, and the learner can resume it later. Use this
          for abuse, a stuck class, or an incident.
        </>
      ),
      confirmLabel: 'End class',
      danger: true,
      run: async (reason) => {
        await api.post(`tutor/live/${encodeURIComponent(room.room)}/end`, { reason })
        toast.success('Class ended. The learner can resume with the minutes left.')
        await queryClient.invalidateQueries({ queryKey: ['live'] })
      },
    })

  return (
    <>
      <PageHeader title="Live classes" subtitle="AI tutor classes in progress right now, refreshed every 10 seconds." />
      <ErrorNote error={live.error} />
      <Card padded={false}>
        {live.isLoading ? (
          <Spinner />
        ) : !live.data?.length ? (
          <Empty title="No class is live right now">Classes appear here the moment a learner joins.</Empty>
        ) : (
          <Table head={['Class', 'Lesson', 'In the room', 'Started', 'Minutes', '']}>
            {live.data.map((r) => (
              <tr key={r.room}>
                <Td>
                  {r.class ? (
                    <Link to={`/tutor/classes/${r.class.id}`} className="font-medium text-primary">
                      #{r.class.id}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">no record</span>
                  )}
                  <div className="mt-0.5 max-w-[14rem] truncate text-xs text-muted-foreground">{r.room}</div>
                </Td>
                <Td>
                  {r.class?.topic ?? '—'}
                  {r.class && (
                    <div className="text-xs text-muted-foreground">
                      Learner <Link className="text-primary" to={`/learners/${r.class.userId}`}>#{r.class.userId}</Link>
                    </div>
                  )}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {r.participants.map((p) => (
                      <Badge key={p.identity} tone={p.isAgent ? 'violet' : 'green'}>
                        {p.isAgent ? <Bot className="size-3" aria-hidden /> : <User className="size-3" aria-hidden />}
                        {p.isAgent ? 'Tutor' : 'Learner'}
                      </Badge>
                    ))}
                    {!r.participants.length && <span className="text-xs text-muted-foreground">empty</span>}
                  </div>
                </Td>
                <Td>{fmtAgo(r.createdAt)}</Td>
                <Td className="tabular">{r.class ? `${fmtMinutes(r.class.remainingMinutes)} left of ${fmtMinutes(r.class.totalMinutes)}` : '—'}</Td>
                <Td>
                  {can('tutor.live.terminate') && (
                    <Button size="sm" variant="danger" icon={<PhoneOff className="size-4" />} onClick={() => end(r)}>
                      End
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  )
}
