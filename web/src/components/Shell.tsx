import { Suspense, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  Activity,
  BadgeCheck,
  BookOpen,
  Building2,
  CalendarClock,
  ClipboardList,
  Gauge,
  GraduationCap,
  HeartPulse,
  IndianRupee,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Menu,
  Radio,
  ScrollText,
  Settings,
  ShieldCheck,
  Timer,
  UserCog,
  Users,
  X,
  BarChart3,
  Headphones,
  MousePointerClick,
  Sparkles,
} from 'lucide-react'
import { useAuth } from '../lib/auth'
import { cx, Spinner } from './ui'

interface Item {
  to: string
  label: string
  icon: ReactNode
  permission?: string
  badge?: number
}

const icon = (C: typeof Gauge) => <C className="size-4 shrink-0" aria-hidden />

/** Modules from the plan that are not built yet, shown so everyone sees where this is going. */
const PLANNED: Record<string, ReactNode> = {
  crm: icon(Headphones),
  sales: icon(ClipboardList),
  finance: icon(IndianRupee),
  teachers: icon(GraduationCap),
  classes: icon(CalendarClock),
  content: icon(BookOpen),
  b2b: icon(Building2),
  marketing: icon(Megaphone),
  reports: icon(BarChart3),
}

export function Shell() {
  const { me, can, signOut } = useAuth()
  const [open, setOpen] = useState(false)
  const location = useLocation()
  if (!me) return null

  const groups: { title?: string; items: Item[] }[] = [
    { items: [{ to: '/', label: 'Overview', icon: icon(LayoutDashboard), permission: 'overview.dashboard.read' }] },
    {
      title: 'Insights',
      items: [
        { to: '/insights/users', label: 'Users & growth', icon: icon(Users), permission: 'analytics.read' },
        { to: '/insights/engagement', label: 'Screens & content', icon: icon(MousePointerClick), permission: 'analytics.read' },
        { to: '/insights/ai', label: 'AI tutor usage', icon: icon(Sparkles), permission: 'analytics.read' },
        { to: '/insights/cost', label: 'Cost & margin', icon: icon(IndianRupee), permission: 'analytics.cost.read' },
      ],
    },
    {
      title: 'AI Tutor',
      items: [
        { to: '/tutor/live', label: 'Live classes', icon: icon(Radio), permission: 'tutor.live.read' },
        { to: '/tutor/classes', label: 'Classes', icon: icon(Activity), permission: 'tutor.classes.read' },
        { to: '/tutor/minutes', label: 'Minutes ledger', icon: icon(Timer), permission: 'tutor.minutes.read' },
      ],
    },
    { title: 'People', items: [{ to: '/learners', label: 'Learners', icon: icon(Users), permission: 'learners.read' }] },
    {
      title: 'Administration',
      items: [
        { to: '/approvals', label: 'Approvals', icon: icon(BadgeCheck), badge: me.pendingApprovals },
        { to: '/staff', label: 'Staff', icon: icon(UserCog), permission: 'console.staff.read' },
        { to: '/roles', label: 'Roles & permissions', icon: icon(KeyRound), permission: 'console.roles.read' },
        { to: '/audit', label: 'Audit log', icon: icon(ScrollText), permission: 'console.audit.read' },
        { to: '/security', label: 'Security policy', icon: icon(ShieldCheck), permission: 'console.staff.read' },
        { to: '/system', label: 'System health', icon: icon(HeartPulse), permission: 'system.health.read' },
      ],
    },
  ]
  const planned = me.modules.filter((m) => m.phase > 1 && PLANNED[m.key])

  const nav = (
    <nav className="flex h-full flex-col" aria-label="Main">
      <div className="flex items-center gap-2 px-5 py-4">
        <div className="grid size-8 place-items-center rounded-lg bg-primary text-sm font-bold text-white dark:text-[#0b1220]">M</div>
        <div className="leading-tight">
          <div className="text-sm font-semibold text-ink">MultiBhashi</div>
          <div className="text-xs text-ink-3">Admin Console</div>
        </div>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        {groups.map((group, gi) => {
          const items = group.items.filter((item) => !item.permission || can(item.permission))
          if (!items.length) return null
          return (
            <div key={gi}>
              {group.title && <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-3">{group.title}</div>}
              <ul className="space-y-0.5">
                {items.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.to === '/'}
                      onClick={() => setOpen(false)}
                      className={({ isActive }) =>
                        cx(
                          'flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm',
                          isActive ? 'bg-primary-soft font-medium text-primary-strong' : 'text-ink-2 hover:bg-surface-2'
                        )
                      }
                    >
                      {item.icon}
                      <span className="flex-1">{item.label}</span>
                      {!!item.badge && <span className="tabular rounded-full bg-warning-soft px-1.5 text-xs font-semibold text-warning">{item.badge}</span>}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
        <div>
          <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Coming next</div>
          <ul className="space-y-0.5">
            {planned.map((m) => (
              <li key={m.key} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-ink-3" title="Planned in docs/PLAN.md, not built yet">
                {PLANNED[m.key]}
                <span className="flex-1">{m.label}</span>
                <span className="text-[10px] font-medium uppercase">P{m.phase}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="border-t border-line p-3">
        <NavLink to="/account" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-surface-2">
          <div className="grid size-8 place-items-center rounded-full bg-violet-soft text-xs font-semibold text-violet">
            {me.user.name.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-medium text-ink">{me.user.name}</div>
            <div className="truncate text-xs text-ink-3">{me.roles.map((r) => r.name).join(', ') || 'No role'}</div>
          </div>
          <Settings className="size-4 text-ink-3" aria-hidden />
        </NavLink>
        <button onClick={signOut} className="mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-ink-2 hover:bg-surface-2">
          <LogOut className="size-4" aria-hidden /> Sign out
        </button>
      </div>
    </nav>
  )

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 border-r border-line bg-surface lg:block">{nav}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 bg-surface shadow-xl">
            <button className="absolute right-3 top-4 rounded-lg p-1 text-ink-3" onClick={() => setOpen(false)} aria-label="Close menu">
              <X className="size-5" />
            </button>
            {nav}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3 lg:hidden">
          <button onClick={() => setOpen(true)} aria-label="Open menu" className="rounded-lg p-1 text-ink-2">
            <Menu className="size-5" />
          </button>
          <span className="text-sm font-semibold">MultiBhashi Console</span>
        </header>
        <main key={location.pathname} className="min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
          <div className="mx-auto max-w-7xl">
            <Suspense fallback={<Spinner />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
    </div>
  )
}
