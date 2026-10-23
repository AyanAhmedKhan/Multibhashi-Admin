import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react'
import { api } from '../../lib/api'
import { fmtDateTime } from '../../lib/format'
import { Button, Card, ErrorNote, PageHeader, Spinner } from '../../components/ui'

interface Health {
  checks: { name: string; ok: boolean; ms: number; detail?: string }[]
  time: string
}

export function SystemPage() {
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.get<Health>('system/health', undefined, { background: true }), refetchInterval: 30_000 })
  return (
    <>
      <PageHeader
        title="System health"
        subtitle="The services the console and the AI tutor depend on. Deep metrics and alerts live in Grafana."
        actions={
          <Button icon={<RefreshCw className="size-4" />} loading={health.isFetching} onClick={() => health.refetch()}>
            Check now
          </Button>
        }
      />
      <ErrorNote error={health.error} />
      {health.isLoading ? (
        <Spinner />
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {health.data?.checks.map((c) => (
            <Card key={c.name}>
              <div className="flex items-center gap-2">
                {c.ok ? <CheckCircle2 className="size-5 text-success" aria-hidden /> : <XCircle className="size-5 text-danger" aria-hidden />}
                <span className="font-medium">{c.name}</span>
                <span className="ml-auto text-sm text-muted-foreground">{c.ok ? 'Healthy' : 'Down'}</span>
              </div>
              <p className="tabular mt-2 text-sm text-ink-2">{c.ms} ms{c.detail ? ` · ${c.detail}` : ''}</p>
            </Card>
          ))}
        </div>
      )}
      {health.data && <p className="mt-4 text-xs text-muted-foreground">Checked {fmtDateTime(health.data.time)}. Refreshes every 30 seconds.</p>}
    </>
  )
}
