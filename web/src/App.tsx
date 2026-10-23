import { lazy, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from './lib/auth'
import { Shell } from './components/Shell'
import { Spinner } from './components/ui'
import { LoginPage } from './pages/LoginPage'
import { SetupPage } from './pages/SetupPage'
import { AccountPage } from './pages/AccountPage'
import { LivePage } from './pages/tutor/LivePage'
import { ClassesPage } from './pages/tutor/ClassesPage'
import { ClassPage } from './pages/tutor/ClassPage'
import { MinutesPage } from './pages/tutor/MinutesPage'
import { LearnersPage } from './pages/learners/LearnersPage'
import { LearnerPage } from './pages/learners/LearnerPage'
import { ApprovalsPage } from './pages/admin/ApprovalsPage'
import { StaffPage } from './pages/admin/StaffPage'
import { StaffMemberPage } from './pages/admin/StaffMemberPage'
import { RolesPage } from './pages/admin/RolesPage'
import { AuditPage } from './pages/admin/AuditPage'
import { SecurityPage } from './pages/admin/SecurityPage'
import { SystemPage } from './pages/admin/SystemPage'

// Chart-heavy pages load on demand, so signing in stays fast.
const OverviewPage = lazy(() => import('./pages/OverviewPage').then((m) => ({ default: m.OverviewPage })))
const InsightsPage = lazy(() => import('./pages/insights/InsightsPage').then((m) => ({ default: m.InsightsPage })))

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth()
  const location = useLocation()
  if (loading) return <Spinner />
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return children
}

/** Route-level guard for a nicer page than a 403; the API enforces it regardless. */
function Gate({ permission, children }: { permission: string; children: ReactNode }) {
  const { can } = useAuth()
  if (!can(permission)) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <p className="font-medium">You don’t have access to this page.</p>
        <p className="mt-1 text-sm text-muted-foreground">It needs the “{permission}” permission. A Super Admin can grant it through a role.</p>
      </div>
    )
  }
  return children
}

function Home() {
  const { can } = useAuth()
  if (can('overview.dashboard.read')) return <OverviewPage />
  if (can('learners.read')) return <Navigate to="/learners" replace />
  return <Navigate to="/account" replace />
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup/:token" element={<SetupPage />} />
      <Route
        element={
          <RequireAuth>
            <Shell />
          </RequireAuth>
        }
      >
        <Route index element={<Home />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="tutor/live" element={<Gate permission="tutor.live.read"><LivePage /></Gate>} />
        <Route path="tutor/classes" element={<Gate permission="tutor.classes.read"><ClassesPage /></Gate>} />
        <Route path="tutor/classes/:id" element={<Gate permission="tutor.classes.read"><ClassPage /></Gate>} />
        <Route path="tutor/minutes" element={<Gate permission="tutor.minutes.read"><MinutesPage /></Gate>} />
        <Route path="learners" element={<Gate permission="learners.read"><LearnersPage /></Gate>} />
        <Route path="learners/:id" element={<Gate permission="learners.read"><LearnerPage /></Gate>} />
        <Route path="insights" element={<Gate permission="analytics.read"><InsightsPage /></Gate>} />
        <Route path="insights/:tab" element={<Gate permission="analytics.read"><InsightsPage /></Gate>} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="staff" element={<Gate permission="console.staff.read"><StaffPage /></Gate>} />
        <Route path="staff/:id" element={<Gate permission="console.staff.read"><StaffMemberPage /></Gate>} />
        <Route path="roles" element={<Gate permission="console.roles.read"><RolesPage /></Gate>} />
        <Route path="audit" element={<Gate permission="console.audit.read"><AuditPage /></Gate>} />
        <Route path="security" element={<Gate permission="console.staff.read"><SecurityPage /></Gate>} />
        <Route path="system" element={<Gate permission="system.health.read"><SystemPage /></Gate>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
