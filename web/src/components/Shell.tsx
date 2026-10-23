import { Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useTheme } from 'next-themes'
import {
  Activity,
  BadgeCheck,
  BarChart3,
  BookOpen,
  Building2,
  CalendarClock,
  ChevronsUpDown,
  ClipboardList,
  GraduationCap,
  Headphones,
  HeartPulse,
  IndianRupee,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Monitor,
  Moon,
  MousePointerClick,
  Radio,
  ScrollText,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  Timer,
  UserCog,
  UserRound,
  Users,
} from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { useAuth } from '../lib/auth'
import { Spinner } from './ui'

interface NavItem {
  to: string
  label: string
  icon: ReactNode
  permission?: string
  badge?: number
}

const PLANNED: Record<string, ReactNode> = {
  crm: <Headphones />,
  sales: <ClipboardList />,
  finance: <IndianRupee />,
  teachers: <GraduationCap />,
  classes: <CalendarClock />,
  content: <BookOpen />,
  b2b: <Building2 />,
  marketing: <Megaphone />,
  reports: <BarChart3 />,
}

function useNav() {
  const { me, can } = useAuth()
  return useMemo(() => {
    const groups: { title?: string; items: NavItem[] }[] = [
      { items: [{ to: '/', label: 'Overview', icon: <LayoutDashboard />, permission: 'overview.dashboard.read' }] },
      {
        title: 'Insights',
        items: [
          { to: '/insights/users', label: 'Users & growth', icon: <Users />, permission: 'analytics.read' },
          { to: '/insights/engagement', label: 'Screens & content', icon: <MousePointerClick />, permission: 'analytics.read' },
          { to: '/insights/ai', label: 'AI tutor usage', icon: <Sparkles />, permission: 'analytics.read' },
          { to: '/insights/cost', label: 'Cost & margin', icon: <IndianRupee />, permission: 'analytics.cost.read' },
        ],
      },
      {
        title: 'AI Tutor',
        items: [
          { to: '/tutor/live', label: 'Live classes', icon: <Radio />, permission: 'tutor.live.read' },
          { to: '/tutor/classes', label: 'Classes', icon: <Activity />, permission: 'tutor.classes.read' },
          { to: '/tutor/minutes', label: 'Minutes ledger', icon: <Timer />, permission: 'tutor.minutes.read' },
        ],
      },
      { title: 'People', items: [{ to: '/learners', label: 'Learners', icon: <UserRound />, permission: 'learners.read' }] },
      {
        title: 'Administration',
        items: [
          { to: '/approvals', label: 'Approvals', icon: <BadgeCheck />, badge: me?.pendingApprovals },
          { to: '/staff', label: 'Staff', icon: <UserCog />, permission: 'console.staff.read' },
          { to: '/roles', label: 'Roles & permissions', icon: <KeyRound />, permission: 'console.roles.read' },
          { to: '/audit', label: 'Audit log', icon: <ScrollText />, permission: 'console.audit.read' },
          { to: '/security', label: 'Security policy', icon: <ShieldCheck />, permission: 'console.staff.read' },
          { to: '/system', label: 'System health', icon: <HeartPulse />, permission: 'system.health.read' },
        ],
      },
    ]
    return groups
      .map((g) => ({ ...g, items: g.items.filter((i) => !i.permission || can(i.permission)) }))
      .filter((g) => g.items.length)
  }, [me, can])
}

function isActive(pathname: string, to: string) {
  return to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`)
}

function AppSidebar() {
  const { me, signOut } = useAuth()
  const nav = useNav()
  const { pathname } = useLocation()
  const { setOpenMobile } = useSidebar()
  if (!me) return null
  const planned = me.modules.filter((m) => m.phase > 1 && PLANNED[m.key])
  const initials = me.user.name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/" onClick={() => setOpenMobile(false)}>
                <img src="/brand/multibhashi-mark.png" alt="" className="size-8 shrink-0 object-contain" />
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-semibold">Multibhashi</span>
                  <span className="truncate text-xs text-muted-foreground">Admin Console</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {nav.map((group, gi) => (
          <SidebarGroup key={gi} className="py-1">
            {group.title && <SidebarGroupLabel>{group.title}</SidebarGroupLabel>}
            <SidebarMenu>
              {group.items.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton asChild isActive={isActive(pathname, item.to)} tooltip={item.label}>
                    <NavLink to={item.to} onClick={() => setOpenMobile(false)}>
                      {item.icon}
                      <span>{item.label}</span>
                    </NavLink>
                  </SidebarMenuButton>
                  {!!item.badge && <SidebarMenuBadge className="bg-warning-soft text-warning">{item.badge}</SidebarMenuBadge>}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
        <SidebarGroup className="py-1">
          <SidebarGroupLabel>Coming next</SidebarGroupLabel>
          <SidebarMenu>
            {planned.map((m) => (
              <SidebarMenuItem key={m.key}>
                <SidebarMenuButton disabled tooltip={`${m.label} (phase ${m.phase})`} className="opacity-60">
                  {PLANNED[m.key]}
                  <span>{m.label}</span>
                </SidebarMenuButton>
                <SidebarMenuBadge className="text-[10px] text-muted-foreground">P{m.phase}</SidebarMenuBadge>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
                  <Avatar className="size-8 rounded-lg">
                    <AvatarFallback className="rounded-lg bg-violet-soft text-xs font-semibold text-violet">{initials}</AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{me.user.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{me.roles.map((r) => r.name).join(', ') || 'No role'}</span>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-60">
                <DropdownMenuLabel className="font-normal">
                  <div className="text-sm font-medium">{me.user.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{me.user.email}</div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/account" onClick={() => setOpenMobile(false)}>
                    <UserCog /> My account
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={signOut} variant="destructive">
                  <LogOut /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

function ThemeMenu() {
  const { theme, setTheme } = useTheme()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Theme">
          <Sun className="dark:hidden" />
          <Moon className="hidden dark:block" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={theme ?? 'system'} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light">
            <Sun /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor /> System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Ctrl/⌘ K: jump to any page, or open a learner or a class by id. */
function CommandPalette({ open, setOpen }: { open: boolean; setOpen: (v: boolean) => void }) {
  const nav = useNav()
  const navigate = useNavigate()
  const { can } = useAuth()
  const [query, setQuery] = useState('')
  const id = /^\d{1,9}$/.test(query.trim()) ? query.trim() : null
  const go = (to: string) => {
    setOpen(false)
    setQuery('')
    navigate(to)
  }
  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Go to" description="Pages, learners and classes">
      <CommandInput placeholder="Type a page, a learner name, or a learner / class id…" value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>Nothing found.</CommandEmpty>
        {id && (
          <CommandGroup heading="Open">
            {can('learners.read') && (
              <CommandItem value={`learner ${id}`} onSelect={() => go(`/learners/${id}`)}>
                <UserRound /> Learner #{id}
              </CommandItem>
            )}
            {can('tutor.classes.read') && (
              <CommandItem value={`class ${id}`} onSelect={() => go(`/tutor/classes/${id}`)}>
                <Activity /> Class #{id}
              </CommandItem>
            )}
          </CommandGroup>
        )}
        {query && !id && can('learners.read') && (
          <CommandGroup heading="Search">
            <CommandItem value={`search learners ${query}`} onSelect={() => go(`/learners?q=${encodeURIComponent(query)}`)}>
              <Search /> Search learners for “{query}”
            </CommandItem>
          </CommandGroup>
        )}
        {nav.map((g, gi) => (
          <CommandGroup key={gi} heading={g.title ?? 'Console'}>
            {g.items.map((item) => (
              <CommandItem key={item.to} value={`${g.title ?? ''} ${item.label}`} onSelect={() => go(item.to)}>
                {item.icon}
                {item.label}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
        <CommandGroup heading="Account">
          <CommandItem value="my account profile password" onSelect={() => go('/account')}>
            <UserCog /> My account
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}

const TITLES: [RegExp, string][] = [
  [/^\/$/, 'Overview'],
  [/^\/insights/, 'Insights'],
  [/^\/tutor\/live/, 'Live classes'],
  [/^\/tutor\/classes/, 'Classes'],
  [/^\/tutor\/minutes/, 'Minutes ledger'],
  [/^\/learners/, 'Learners'],
  [/^\/approvals/, 'Approvals'],
  [/^\/staff/, 'Staff'],
  [/^\/roles/, 'Roles & permissions'],
  [/^\/audit/, 'Audit log'],
  [/^\/security/, 'Security policy'],
  [/^\/system/, 'System health'],
  [/^\/account/, 'My account'],
]

export function Shell() {
  const { me } = useAuth()
  const location = useLocation()
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!me) return null
  const title = TITLES.find(([re]) => re.test(location.pathname))?.[1] ?? 'Console'
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
          <span className="truncate text-sm font-medium">{title}</span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button variant="outline" size="sm" className="hidden w-60 justify-start font-normal text-muted-foreground sm:flex" onClick={() => setPaletteOpen(true)}>
              <Search /> Search or jump to…
              <CommandShortcut className="ml-auto">Ctrl K</CommandShortcut>
            </Button>
            <Button variant="ghost" size="icon" className="sm:hidden" aria-label="Search" onClick={() => setPaletteOpen(true)}>
              <Search />
            </Button>
            {me.pendingApprovals > 0 && (
              <Button variant="ghost" size="sm" asChild>
                <Link to="/approvals" className="text-warning" aria-label={`${me.pendingApprovals} approvals waiting`}>
                  <BadgeCheck /> {me.pendingApprovals}
                </Link>
              </Button>
            )}
            <ThemeMenu />
          </div>
        </header>
        <main key={location.pathname} className="min-w-0 flex-1 px-4 py-6 sm:px-8">
          <div className="mx-auto max-w-7xl">
            <Suspense fallback={<Spinner />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </SidebarInset>
      <CommandPalette open={paletteOpen} setOpen={setPaletteOpen} />
    </SidebarProvider>
  )
}
