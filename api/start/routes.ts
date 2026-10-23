/*
|--------------------------------------------------------------------------
| Routes
|--------------------------------------------------------------------------
| Everything lives under /api; the web app is served from the same origin (nginx in
| production, the Vite proxy locally), so cookies are first-party and SameSite=Strict.
| Every authenticated route names the permission it needs: authorisation is enforced
| here, on the server, never only by hiding things in the UI.
*/

import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

const AuthController = () => import('#controllers/auth_controller')
const StaffController = () => import('#controllers/staff_controller')
const RolesController = () => import('#controllers/roles_controller')
const ConsoleController = () => import('#controllers/console_controller')
const TutorController = () => import('#controllers/tutor_controller')
const AiProController = () => import('#controllers/ai_pro_controller')
const InsightsController = () => import('#controllers/insights_controller')

const id = { id: router.matchers.number() }

router
  .group(() => {
    router.get('health', () => ({ status: 'ok', service: 'multibhashi-admin-api' }))

    // Signing in and accepting an invite (no session yet)
    router.post('auth/login', [AuthController, 'login'])
    router.get('auth/setup/:token', [AuthController, 'setupInfo'])
    router.post('auth/setup/:token', [AuthController, 'completeSetup'])
    router.post('auth/mfa', [AuthController, 'mfa']).use(middleware.auth({ pending: true }))

    router
      .group(() => {
        // My account
        router.get('auth/me', [AuthController, 'me'])
        router.post('auth/logout', [AuthController, 'logout'])
        router.post('auth/step-up', [AuthController, 'stepUp'])
        router.post('auth/password', [AuthController, 'changePassword'])
        router.post('auth/recovery-codes', [AuthController, 'recoveryCodes']).use(middleware.freshMfa())
        router.get('auth/sessions', [AuthController, 'sessions'])
        router.post('auth/sessions/revoke-others', [AuthController, 'revokeOtherSessions'])

        // Overview
        router.get('overview', [TutorController, 'overview']).use(middleware.can(['overview.dashboard.read']))

        // AI Tutor
        router.get('tutor/overview', [TutorController, 'overview']).use(middleware.can(['tutor.classes.read']))
        router.get('tutor/live', [TutorController, 'live']).use(middleware.can(['tutor.live.read']))
        router
          .post('tutor/live/:room/end', [TutorController, 'endLive'])
          .use(middleware.can(['tutor.live.terminate']))
        router.get('tutor/classes', [TutorController, 'classes']).use(middleware.can(['tutor.classes.read']))
        router
          .get('tutor/classes/:id', [TutorController, 'showClass'])
          .where('id', id.id)
          .use(middleware.can(['tutor.classes.read']))
        router
          .post('tutor/classes/:id/transcript', [TutorController, 'transcript'])
          .where('id', id.id)
          .use(middleware.can(['tutor.classes.read', 'tutor.transcripts.read']))
        router
          .post('tutor/classes/:id/grant', [TutorController, 'grant'])
          .where('id', id.id)
          .use(middleware.can(['tutor.classes.read', 'tutor.minutes.grant']))
        router.get('tutor/minutes', [TutorController, 'ledger']).use(middleware.can(['tutor.minutes.read']))
        router.get('tutor/free-grants', [TutorController, 'freeGrants']).use(middleware.can(['tutor.minutes.read']))

        // Learners
        router.get('learners', [TutorController, 'learners']).use(middleware.can(['learners.read']))
        router
          .get('learners/:id', [TutorController, 'learner'])
          .where('id', id.id)
          .use(middleware.can(['learners.read']))
        router
          .post('learners/:id/reveal', [TutorController, 'revealLearner'])
          .where('id', id.id)
          .use(middleware.can(['learners.read', 'learners.pii.read']))
        router
          .post('learners/:id/memory', [TutorController, 'memory'])
          .where('id', id.id)
          .use(middleware.can(['learners.read', 'tutor.memory.read']))
        router
          .post('learners/:id/memory/erase', [TutorController, 'eraseMemory'])
          .where('id', id.id)
          .use(middleware.can(['learners.read', 'tutor.memory.erase']))
        router
          .post('learners/:id/export', [TutorController, 'exportLearner'])
          .where('id', id.id)
          .use(middleware.can(['learners.read', 'learners.export']))

        // AI Pro access without payment (complimentary plans, lesson access, minutes)
        router.get('tutor/ai-pro/catalog', [AiProController, 'catalog']).use(middleware.can(['tutor.access.read']))
        router
          .get('learners/:id/ai-pro', [AiProController, 'forLearner'])
          .where('id', id.id)
          .use(middleware.can(['learners.read', 'tutor.access.read']))
        router
          .post('learners/:id/ai-pro/preview', [AiProController, 'preview'])
          .where('id', id.id)
          .use(middleware.can(['learners.read', 'tutor.access.read']))
        router
          .post('learners/:id/ai-pro', [AiProController, 'grant'])
          .where('id', id.id)
          .use(middleware.can(['learners.read', 'tutor.access.grant']))
        router
          .post('ai-pro/:grantId/extend', [AiProController, 'extend'])
          .where('grantId', id.id)
          .use(middleware.can(['tutor.access.revoke']))
        router
          .post('ai-pro/:grantId/end', [AiProController, 'end'])
          .where('grantId', id.id)
          .use(middleware.can(['tutor.access.revoke']))

        // Insights (aggregates only)
        router.get('insights/users', [InsightsController, 'users']).use(middleware.can(['analytics.read']))
        router.get('insights/engagement', [InsightsController, 'engagement']).use(middleware.can(['analytics.read']))
        router.get('insights/tutor', [InsightsController, 'tutor']).use(middleware.can(['analytics.read']))
        router.get('insights/highlights', [InsightsController, 'highlights']).use(middleware.can(['analytics.read']))
        router.get('insights/staff', [InsightsController, 'staff']).use(middleware.can(['console.audit.read']))
        router.get('insights/cost', [InsightsController, 'cost']).use(middleware.can(['analytics.cost.read']))
        router.get('insights/cost-model', [InsightsController, 'costModel']).use(middleware.can(['analytics.cost.read']))
        router.get('insights/reconciliation', [InsightsController, 'reconciliation']).use(middleware.can(['analytics.cost.read']))
        router
          .put('insights/invoices', [InsightsController, 'saveInvoice'])
          .use(middleware.can(['analytics.cost.read', 'analytics.costs.manage']))
        router
          .get('tutor/classes/:id/cost', [InsightsController, 'classCost'])
          .where('id', id.id)
          .use(middleware.can(['tutor.classes.read', 'analytics.cost.read']))
        router
          .put('insights/cost-model', [InsightsController, 'updateCostModel'])
          .use(middleware.can(['analytics.cost.read', 'analytics.costs.manage']))

        // Administration: staff
        router.get('staff', [StaffController, 'index']).use(middleware.can(['console.staff.read']))
        router
          .get('staff/:id', [StaffController, 'show'])
          .where('id', id.id)
          .use(middleware.can(['console.staff.read']))
        router.post('staff', [StaffController, 'invite']).use(middleware.can(['console.staff.manage']))
        router
          .put('staff/:id', [StaffController, 'rename'])
          .where('id', id.id)
          .use(middleware.can(['console.staff.manage']))
        router
          .put('staff/:id/roles', [StaffController, 'roles'])
          .where('id', id.id)
          .use(middleware.can(['console.staff.manage']))
        router
          .post('staff/:id/disable', [StaffController, 'disable'])
          .where('id', id.id)
          .use(middleware.can(['console.staff.manage']))
        router
          .post('staff/:id/enable', [StaffController, 'enable'])
          .where('id', id.id)
          .use(middleware.can(['console.staff.manage']))
        router
          .post('staff/:id/reset-access', [StaffController, 'resetAccess'])
          .where('id', id.id)
          .use(middleware.can(['console.staff.manage']))
        router
          .post('staff/:id/revoke-sessions', [StaffController, 'revokeSessions'])
          .where('id', id.id)
          .use(middleware.can(['console.staff.manage']))

        // Administration: roles
        router.get('roles', [RolesController, 'index']).use(middleware.can(['console.roles.read']))
        router.post('roles', [RolesController, 'store']).use(middleware.can(['console.roles.manage']))
        router
          .put('roles/:id', [RolesController, 'update'])
          .where('id', id.id)
          .use(middleware.can(['console.roles.manage']))
        router
          .delete('roles/:id', [RolesController, 'destroy'])
          .where('id', id.id)
          .use(middleware.can(['console.roles.manage']))

        // Administration: approvals (requesters see their own; deciders see all)
        router.get('approvals', [ConsoleController, 'approvals'])
        router
          .post('approvals/:id/decide', [ConsoleController, 'decide'])
          .where('id', id.id)
          .use(middleware.can(['console.approvals.decide']))
        router.post('approvals/:id/cancel', [ConsoleController, 'cancelApproval']).where('id', id.id)

        // Administration: audit, settings, health
        router.get('audit', [ConsoleController, 'audit']).use(middleware.can(['console.audit.read']))
        router.post('audit/verify', [ConsoleController, 'verifyAudit']).use(middleware.can(['console.audit.read']))
        router.get('settings', [ConsoleController, 'settings']).use(middleware.can(['console.staff.read']))
        router.put('settings', [ConsoleController, 'updateSettings']).use(middleware.can(['console.settings.manage']))
        router.get('system/health', [ConsoleController, 'health']).use(middleware.can(['system.health.read']))
      })
      .use(middleware.auth())
  })
  .prefix('/api')
