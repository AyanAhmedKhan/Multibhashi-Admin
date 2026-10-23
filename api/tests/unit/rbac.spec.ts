import { test } from '@japa/runner'
import { ALL, MODULES, PERMISSIONS, effectivePermissions, isKnownPermission } from '#rbac/permissions'
import { SUPER_ADMIN, SYSTEM_ROLES } from '#rbac/roles'

const role = (slug: string) => SYSTEM_ROLES.find((r) => r.slug === slug)!
const perms = (slug: string) => effectivePermissions(role(slug).permissions)

test.group('Permission catalog', () => {
  test('keys are unique and follow module.resource.action', ({ assert }) => {
    const keys = PERMISSIONS.map((p) => p.key)
    assert.equal(new Set(keys).size, keys.length)
    for (const key of keys) assert.match(key, /^[a-z0-9]+(\.[a-z0-9_]+){1,2}$/)
  })

  test('every permission sits in its own module', ({ assert }) => {
    for (const module of MODULES) {
      for (const permission of module.permissions) {
        const prefix = permission.key.split('.')[0]
        assert.isTrue(prefix === module.key || (module.key === 'console' && prefix === 'system'), permission.key)
      }
    }
  })

  test('the wildcard expands to the whole catalog and unknown keys drop out', ({ assert }) => {
    assert.equal(effectivePermissions([ALL]).size, PERMISSIONS.length)
    assert.deepEqual([...effectivePermissions(['tutor.live.read', 'made.up.thing'])], ['tutor.live.read'])
  })
})

test.group('System roles', () => {
  test('only super_admin carries the wildcard', ({ assert }) => {
    for (const r of SYSTEM_ROLES) {
      assert.equal(r.permissions.includes(ALL), r.slug === SUPER_ADMIN, r.slug)
    }
  })

  test('every role permission exists in the catalog', ({ assert }) => {
    for (const r of SYSTEM_ROLES) {
      for (const p of r.permissions) {
        if (p !== ALL) assert.isTrue(isKnownPermission(p), `${r.slug}: ${p}`)
      }
    }
  })

  test('no legacy slug maps to two roles; nobody migrates into super_admin', ({ assert }) => {
    const seen = new Map<string, string>()
    for (const r of SYSTEM_ROLES) {
      for (const legacy of r.legacy) {
        assert.isFalse(seen.has(legacy), `${legacy} is in ${seen.get(legacy)} and ${r.slug}`)
        seen.set(legacy, r.slug)
      }
    }
    assert.lengthOf(role(SUPER_ADMIN).legacy, 0)
  })

  test('access control stays with super admins', ({ assert }) => {
    for (const r of SYSTEM_ROLES.filter((x) => x.slug !== SUPER_ADMIN)) {
      const p = perms(r.slug)
      for (const key of ['console.staff.manage', 'console.roles.manage', 'console.settings.manage']) {
        assert.isFalse(p.has(key), `${r.slug} must not have ${key}`)
      }
    }
  })

  test('separation of duties: raising and approving money movement are split', ({ assert }) => {
    // Sales can grant subscriptions; finance approves refunds and payouts; neither does both.
    assert.isFalse(perms('sales_manager').has('finance.refunds.approve'))
    assert.isFalse(perms('sales_agent').has('sales.coupons.manage'))
    assert.isFalse(perms('trainer_manager').has('finance.payouts.approve'))
    assert.isFalse(perms('support_agent').has('tutor.memory.erase'))
  })

  test('the read-only roles really are read-only', ({ assert }) => {
    for (const slug of ['auditor']) {
      for (const key of perms(slug)) {
        const def = PERMISSIONS.find((p) => p.key === key)!
        assert.oneOf(def.risk, ['read', 'sensitive'], `${slug}: ${key}`)
        assert.notEqual(key, 'learners.pii.read', `${slug} must work on masked data`)
      }
    }
  })
})
