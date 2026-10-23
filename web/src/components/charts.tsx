import { useState, type ReactNode } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Button, Card, Table, Td } from './ui'

/**
 * Chart building blocks (dataviz rules): one validated hue (--chart) per chart, one axis,
 * thin bars (≤ 24 px, 4 px rounded data end), 2 px lines with a 10 % area wash, recessive
 * hairline grid, hover tooltip on every chart, and a table view for every chart.
 */

export interface Column<T> {
  key: keyof T & string
  label: string
  format?: (v: T[keyof T], row: T) => ReactNode
}

export function ChartCard<T extends Record<string, unknown>>({
  title,
  subtitle,
  rows,
  columns,
  children,
  className,
}: {
  title: string
  subtitle?: ReactNode
  rows: T[]
  columns: Column<T>[]
  children: ReactNode
  className?: string
}) {
  const [table, setTable] = useState(false)
  return (
    <Card
      className={className}
      title={
        <span>
          {title}
          {subtitle && <span className="block text-xs font-normal text-ink-3">{subtitle}</span>}
        </span>
      }
      actions={
        <Button size="sm" variant="ghost" onClick={() => setTable((v) => !v)}>
          {table ? 'Show chart' : 'Show table'}
        </Button>
      }
    >
      {table ? (
        <div className="max-h-80 overflow-y-auto">
          <Table head={columns.map((c) => c.label)}>
            {rows.map((row, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <Td key={c.key} className="tabular">
                    {c.format ? c.format(row[c.key], row) : String(row[c.key] ?? '—')}
                  </Td>
                ))}
              </tr>
            ))}
          </Table>
        </div>
      ) : (
        children
      )}
    </Card>
  )
}

const axisTick = { fill: 'var(--ink-3)', fontSize: 12 }

function TooltipBox({ title, lines }: { title: ReactNode; lines: ReactNode[] }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-md">
      <div className="font-medium text-ink">{title}</div>
      {lines.map((l, i) => (
        <div key={i} className="tabular mt-0.5 text-ink-2">
          {l}
        </div>
      ))}
    </div>
  )
}

export function Bars<T extends Record<string, unknown>>({
  data,
  x,
  y,
  xFormat,
  yFormat = (v) => v.toLocaleString('en-IN'),
  label,
  height = 240,
}: {
  data: T[]
  x: keyof T & string
  y: keyof T & string
  xFormat?: (v: string) => string
  yFormat?: (v: number) => string
  label: string
  height?: number
}) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey={x} tickFormatter={xFormat} tick={axisTick} axisLine={{ stroke: 'var(--chart-grid)' }} tickLine={false} minTickGap={16} />
          <YAxis allowDecimals={false} tick={axisTick} axisLine={false} tickLine={false} tickFormatter={(v) => compact(v)} />
          <Tooltip
            cursor={{ fill: 'var(--surface-2)' }}
            content={({ active, payload }) =>
              active && payload?.length ? (
                <TooltipBox title={xFormat ? xFormat(String(payload[0].payload[x])) : String(payload[0].payload[x])} lines={[`${yFormat(Number(payload[0].value))} ${label}`]} />
              ) : null
            }
          />
          <Bar dataKey={y} fill="var(--chart)" maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

export function Line<T extends Record<string, unknown>>({
  data,
  x,
  y,
  xFormat,
  yFormat = (v) => v.toLocaleString('en-IN'),
  label,
  height = 240,
}: {
  data: T[]
  x: keyof T & string
  y: keyof T & string
  xFormat?: (v: string) => string
  yFormat?: (v: number) => string
  label: string
  height?: number
}) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey={x} tickFormatter={xFormat} tick={axisTick} axisLine={{ stroke: 'var(--chart-grid)' }} tickLine={false} minTickGap={24} />
          <YAxis allowDecimals={false} tick={axisTick} axisLine={false} tickLine={false} tickFormatter={(v) => compact(v)} />
          <Tooltip
            cursor={{ stroke: 'var(--ink-3)', strokeWidth: 1 }}
            content={({ active, payload }) =>
              active && payload?.length ? (
                <TooltipBox title={xFormat ? xFormat(String(payload[0].payload[x])) : String(payload[0].payload[x])} lines={[`${yFormat(Number(payload[0].value))} ${label}`]} />
              ) : null
            }
          />
          <Area
            type="monotone"
            dataKey={y}
            stroke="var(--chart)"
            strokeWidth={2}
            fill="var(--chart)"
            fillOpacity={0.1}
            isAnimationActive={false}
            dot={false}
            activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

export function compact(v: number) {
  if (Math.abs(v) >= 100_000) return `${Math.round(v / 1000) / 100}L`
  if (Math.abs(v) >= 1000) return `${Math.round(v / 100) / 10}K`
  return String(v)
}

/** Sequential single-hue fill for a 0–1 share (heatmap, retention). */
export function shade(share: number) {
  const pct = Math.round(8 + Math.max(0, Math.min(1, share)) * 80)
  return `color-mix(in oklab, var(--chart) ${pct}%, var(--surface))`
}

/** Text that stays readable on a shaded cell. */
export function shadeInk(share: number) {
  return share > 0.55 ? 'white' : 'var(--ink)'
}
