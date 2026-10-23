/**
 * The permission catalog: the single source of truth for what a staff member can do.
 * Roles (system and custom) are bundles of these strings; anything not in this list is
 * ignored even if a role row carries it.
 *
 * Naming: `<module>.<resource>.<action>`.
 * Risk:
 *   read      — view non-sensitive data
 *   sensitive — view personal or confidential data; every use is audited, a reason is asked
 *   write     — change data
 *   critical  — money, deletion, privacy or access control; needs a fresh MFA check
 *               (step-up) and a reason, and some actions also a second approver
 * `available: false` marks modules that are planned (docs/PLAN.md) but not built yet: the
 * roles already carry them, so a module goes live without re-planning access.
 * `scoped` permissions are narrowed per role to own / team / all records (phase 2).
 */

export type Risk = 'read' | 'sensitive' | 'write' | 'critical'

export interface PermissionDef {
  key: string
  label: string
  risk: Risk
  available: boolean
  scoped?: boolean
}

export interface ModuleDef {
  key: string
  label: string
  phase: number
  permissions: PermissionDef[]
}

const p = (
  key: string,
  label: string,
  risk: Risk,
  available: boolean,
  scoped = false
): PermissionDef => ({ key, label, risk, available, ...(scoped ? { scoped } : {}) })

export const MODULES: ModuleDef[] = [
  {
    key: 'overview',
    label: 'Overview',
    phase: 1,
    permissions: [p('overview.dashboard.read', 'See the overview dashboard', 'read', true)],
  },
  {
    key: 'tutor',
    label: 'AI Tutor',
    phase: 1,
    permissions: [
      p('tutor.classes.read', 'List classes and their minutes', 'read', true),
      p('tutor.transcripts.read', 'Read class transcripts', 'sensitive', true),
      p('tutor.live.read', 'See live classes', 'read', true),
      p('tutor.live.terminate', 'End a live class', 'write', true),
      p('tutor.minutes.read', 'See the minutes ledger', 'read', true),
      p('tutor.minutes.grant', 'Add or remove a class’s minutes', 'critical', true),
      p('tutor.access.read', 'See a learner’s AI Pro access', 'read', true),
      p('tutor.access.grant', 'Give AI Pro access without payment', 'critical', true),
      p('tutor.access.revoke', 'Extend, shorten or end complimentary AI Pro', 'critical', true),
      p('tutor.memory.read', 'Read learner memory', 'sensitive', true),
      p('tutor.memory.erase', 'Erase learner memory', 'critical', true),
      p('tutor.config.read', 'See tutor engines, voices, prompts', 'read', false),
      p('tutor.config.manage', 'Change tutor engines, voices, prompts', 'critical', false),
    ],
  },
  {
    key: 'learners',
    label: 'Learners',
    phase: 1,
    permissions: [
      p('learners.read', 'Search learners (contact details masked)', 'read', true),
      p('learners.pii.read', 'Reveal phone and email', 'sensitive', true),
      p('learners.export', 'Export a learner’s data (access request)', 'critical', true),
      p('learners.manage', 'Edit or block learners', 'write', false),
    ],
  },
  {
    key: 'analytics',
    label: 'Insights',
    phase: 1,
    permissions: [
      p('analytics.read', 'Users, engagement, screens and AI usage (aggregates only)', 'read', true),
      p('analytics.cost.read', 'AI cost, revenue and margins', 'sensitive', true),
      p('analytics.costs.manage', 'Edit the cost rate card', 'critical', true),
    ],
  },
  {
    key: 'crm',
    label: 'CRM & Leads',
    phase: 2,
    permissions: [
      p('crm.leads.read', 'See leads', 'read', false, true),
      p('crm.leads.manage', 'Create and update leads, remarks, status', 'write', false, true),
      p('crm.leads.assign', 'Assign and transfer leads', 'write', false),
      p('crm.leads.export', 'Export leads', 'critical', false),
      p('crm.recordings.read', 'Listen to call recordings', 'sensitive', false, true),
      p('crm.config.manage', 'Lead sources, statuses, remark options', 'write', false),
    ],
  },
  {
    key: 'sales',
    label: 'Bookings & Sales',
    phase: 2,
    permissions: [
      p('sales.bookings.read', 'See bookings and subscriptions', 'read', false, true),
      p('sales.bookings.manage', 'Create, renew, transfer bookings', 'write', false, true),
      p('sales.bookings.cancel', 'Cancel or mark bookings duplicate', 'critical', false),
      p('sales.coupons.manage', 'Create coupons', 'critical', false),
      p('sales.offers.manage', 'Offers, packages, prices', 'critical', false),
      p('sales.subscriptions.grant', 'Grant a subscription without payment', 'critical', false),
    ],
  },
  {
    key: 'finance',
    label: 'Finance',
    phase: 2,
    permissions: [
      p('finance.payments.read', 'See payments and invoices', 'sensitive', false),
      p('finance.refunds.request', 'Raise a refund', 'write', false),
      p('finance.refunds.approve', 'Approve a refund', 'critical', false),
      p('finance.payouts.read', 'See trainer payouts', 'sensitive', false),
      p('finance.payouts.approve', 'Approve a payout batch', 'critical', false),
      p('finance.export', 'Export financial reports', 'critical', false),
    ],
  },
  {
    key: 'teachers',
    label: 'Teachers',
    phase: 2,
    permissions: [
      p('teachers.read', 'See trainer profiles', 'read', false),
      p('teachers.pii.read', 'See trainer contact, address, bank details', 'sensitive', false),
      p('teachers.manage', 'Onboard, edit, deactivate trainers', 'write', false),
      p('teachers.availability.manage', 'Edit slots and availability', 'write', false),
      p('teachers.payrates.manage', 'Change a trainer’s pay rate', 'critical', false),
    ],
  },
  {
    key: 'classes',
    label: 'Live Classes',
    phase: 2,
    permissions: [
      p('classes.sessions.read', 'See 1:1 sessions and calls', 'read', false, true),
      p('classes.sessions.manage', 'Schedule, reschedule, change trainer', 'write', false, true),
      p('classes.webinars.read', 'See group batches and webinars', 'read', false, true),
      p('classes.webinars.manage', 'Create batches, classes, attendance', 'write', false, true),
      p('classes.recordings.read', 'Watch class recordings', 'sensitive', false, true),
      p('classes.recordings.delete', 'Delete recordings', 'critical', false),
      p('classes.chats.moderate', 'Read and moderate teacher–learner chats', 'sensitive', false),
    ],
  },
  {
    key: 'content',
    label: 'Content & Curriculum',
    phase: 3,
    permissions: [
      p('content.read', 'See courses, lessons, quizzes', 'read', false),
      p('content.manage', 'Edit courses, lessons, study material, quizzes', 'write', false),
      p('content.publish', 'Publish content to learners', 'critical', false),
    ],
  },
  {
    key: 'b2b',
    label: 'B2B & Institutes',
    phase: 3,
    permissions: [
      p('b2b.clients.read', 'See B2B clients and their learners', 'read', false, true),
      p('b2b.clients.manage', 'Manage clients, managers, batches', 'write', false, true),
      p('b2b.nsdc.manage', 'NSDC registrations and exports', 'critical', false),
    ],
  },
  {
    key: 'marketing',
    label: 'Marketing & Site',
    phase: 3,
    permissions: [
      p('marketing.blogs.manage', 'Write and publish blogs', 'write', false),
      p('marketing.site.manage', 'Home page, banners, promo bar', 'write', false),
      p('marketing.notifications.send', 'Send push/email campaigns', 'critical', false),
    ],
  },
  {
    key: 'reports',
    label: 'Reports',
    phase: 2,
    permissions: [
      p('reports.read', 'See reports', 'read', false),
      p('reports.export', 'Download report exports', 'critical', false),
    ],
  },
  {
    key: 'console',
    label: 'Administration',
    phase: 1,
    permissions: [
      p('console.staff.read', 'See staff accounts', 'read', true),
      p('console.staff.manage', 'Invite, edit, disable staff; reset access', 'critical', true),
      p('console.roles.read', 'See roles and permissions', 'read', true),
      p('console.roles.manage', 'Create and edit custom roles', 'critical', true),
      p('console.approvals.decide', 'Approve or reject requests', 'critical', true),
      p('console.audit.read', 'Read the audit log', 'sensitive', true),
      p('console.settings.manage', 'Change security policy and limits', 'critical', true),
      p('system.health.read', 'See system health', 'read', true),
    ],
  },
]

export const PERMISSIONS: PermissionDef[] = MODULES.flatMap((m) => m.permissions)

const BY_KEY = new Map(PERMISSIONS.map((perm) => [perm.key, perm]))

/** The super admin wildcard. Only the super_admin system role carries it. */
export const ALL = '*'

export function permissionDef(key: string): PermissionDef | undefined {
  return BY_KEY.get(key)
}

export function isKnownPermission(key: string) {
  return BY_KEY.has(key)
}

export function isCritical(key: string) {
  return BY_KEY.get(key)?.risk === 'critical'
}

/** Expands `*` and drops unknown strings, so callers only ever see catalog keys. */
export function effectivePermissions(granted: Iterable<string>): Set<string> {
  const result = new Set<string>()
  for (const key of granted) {
    if (key === ALL) return new Set(PERMISSIONS.map((perm) => perm.key))
    if (BY_KEY.has(key)) result.add(key)
  }
  return result
}
