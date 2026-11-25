import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Hourglass, PlugZap } from 'lucide-react'
import { api } from '../../../lib/api'
import { fmtDay } from '../../../lib/format'
import { Card, Empty, ErrorNote, Spinner } from '../../../components/ui'
import type { Answer, Ready } from './types'

/** One product-analytics page's data (cached by react-query; the API caches for 10 minutes). */
export function useProduct<T>(path: string, params: Record<string, string | number | undefined | null>) {
  return useQuery({
    queryKey: ['insights-product', path, params],
    queryFn: () => api.get<Answer<T>>(`insights/product/${path}`, params),
  })
}

/**
 * The states every product tab shares: loading, an error, "not connected yet" (the BigQuery
 * settings are missing on the server; the env names, never values) and "not ready" (the tables
 * or the first model run are missing). Otherwise renders the page with its data.
 */
export function ProductGate<T>({ query, children }: { query: ReturnType<typeof useProduct<T>>; children: (data: Ready<T>) => ReactNode }) {
  if (query.isLoading) return <Spinner />
  if (query.error || !query.data) return <ErrorNote error={query.error} />
  const data = query.data
  if (!data.connected) {
    return (
      <Card>
        <Empty title="Product analytics isn’t connected yet" icon={<PlugZap />}>
          These tabs read the app’s own events from BigQuery (dataset product_analytics, {data.location}), modelled nightly.
          {data.problem ? ` ${data.problem}.` : ` Set ${data.missing.join(' and ')} on the console’s server`}, then run analytics:bq-setup --apply,
          analytics:export-facts and analytics:models (docs/PRODUCT_ANALYTICS.md). The other Insights tabs keep working from MySQL.
        </Empty>
      </Card>
    )
  }
  if (!data.ready) {
    return (
      <Card>
        <Empty title="No product analytics data yet" icon={<Hourglass />}>
          {data.message}
        </Empty>
      </Card>
    )
  }
  return (
    <div className="space-y-6">
      {children(data)}
      <p className="text-xs text-muted-foreground">
        Product analytics: the app’s own events in BigQuery, modelled nightly. {fmtDay(data.range.from)} – {fmtDay(data.range.to)} IST, compared with the{' '}
        {data.range.days} days before. Opted-out learners send only essential events (errors, security) and are left out of these behavioural figures.
      </p>
    </div>
  )
}

/** "+12.5%" / "−3%" / "new" for a change against the period before. */
export function changeText(v: number | null, suffix = 'vs previous period') {
  if (v === null) return `new ${suffix}`
  return `${v > 0 ? '+' : ''}${v}% ${suffix}`
}

export function fmtSeconds(s: number | null | undefined) {
  if (s === null || s === undefined) return '—'
  if (s < 60) return `${Math.round(s)} s`
  if (s < 3600) {
    const m = Math.floor(s / 60)
    const r = Math.round(s % 60)
    return r ? `${m} min ${r} s` : `${m} min`
  }
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  return m ? `${h} h ${m} min` : `${h} h`
}

export const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}%`)
