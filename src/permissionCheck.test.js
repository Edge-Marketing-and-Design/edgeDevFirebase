/* eslint-env node */
/* eslint-disable @typescript-eslint/no-var-requires */
const assert = require('node:assert/strict')
const test = require('node:test')
const { canPerformActionForRoles } = require('./permissionCheck')

test('root admin grants every supported admin action globally', () => {
  const roles = {
    '-': { collectionPath: '-', role: 'admin' },
  }

  for (const action of ['read', 'write', 'delete', 'assign']) {
    assert.equal(
      canPerformActionForRoles(roles, action, 'organizations/example-org/sites'),
      true,
    )
  }
})

test('non-admin root roles do not grant global access', () => {
  for (const role of ['editor', 'writer', 'user']) {
    for (const action of ['read', 'write', 'delete', 'assign']) {
      assert.equal(
        canPerformActionForRoles(
          { '-': { collectionPath: '-', role } },
          action,
          'organizations/example-org/sites',
        ),
        false,
      )
    }
  }
})

test('scoped roles continue to apply to matching descendant paths', () => {
  const roles = {
    org: { collectionPath: 'organizations-example-org', role: 'editor' },
  }

  assert.equal(
    canPerformActionForRoles(roles, 'read', 'organizations/example-org/sites'),
    true,
  )
  assert.equal(
    canPerformActionForRoles(roles, 'write', 'organizations/example-org/sites/site-1'),
    true,
  )
  assert.equal(
    canPerformActionForRoles(roles, 'assign', 'organizations/example-org/sites'),
    false,
  )
  assert.equal(
    canPerformActionForRoles(roles, 'read', 'organizations/other-org/sites'),
    false,
  )
})
