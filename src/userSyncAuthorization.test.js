const test = require('node:test')
const assert = require('node:assert/strict')
const { authorizeStage, approvalRef, canAssign } = require('./userSyncAuthorization')
const role = (path, value = 'user') => ({ collectionPath: path, role: value })
const ordinary = { stagedDocId: 'alice-stage', roles: { 'organizations-a': role('organizations-a') }, specialPermissions: {}, meta: { name: 'Alice' } }
function memoryDb(initial = {}) {
  const data = structuredClone(initial)
  const db = {
    collection: collection => ({ doc: id => ({ id, path: `${collection}/${id}` }) }),
    runTransaction: async callback => {
      const pending = []
      const tx = {
        get: async ref => ({ exists: Boolean(data[ref.path]), data: () => structuredClone(data[ref.path]) }),
        set: (ref, value, options) => pending.push(() => { data[ref.path] = options ? { ...data[ref.path], ...structuredClone(value) } : structuredClone(value) }),
      }
      const result = await callback(tx)
      pending.forEach(write => write())
      return result
    },
  }
  return { db, data }
}
function fixture(extra = {}) {
  const { db, data } = memoryDb({ 'users/alice': ordinary, 'users/admin': { roles: { 'organizations-a': role('organizations-a', 'admin') } }, ...extra })
  const stage = { ...structuredClone(ordinary), userId: 'alice', uid: 'alice', templateUserId: '', isTemplate: false }
  const mirror = (tx, ref, safe) => tx.set(ref, { meta: safe.meta, roles: safe.roles, specialPermissions: safe.specialPermissions, userId: ref.id, stagedDocId: 'alice-stage' }, { merge: true })
  return { db, data, stage, mirror }
}
for (const field of ['roles', 'specialPermissions']) {
  test(`self escalation through ${field} is rejected, including a later unchanged poisoned snapshot`, async () => {
    const { db, data, stage, mirror } = fixture()
    const poisoned = { ...stage, [field]: { ...stage[field], '-': field === 'roles' ? role('-', 'admin') : { collectionPath: '-', permissions: { assign: true, write: true } } } }
    await assert.rejects(authorizeStage(db, 'alice-stage', poisoned, stage, mirror), { code: 'permission-denied' })
    await assert.rejects(authorizeStage(db, 'alice-stage', { ...poisoned, meta: { name: 'Retry' } }, poisoned, mirror), { code: 'permission-denied' })
    assert.deepEqual(data['users/alice'], ordinary)
  })
}
test('forged templateUserId cannot edit a victim or redirect registered identity', async () => {
  const { db, stage, mirror } = fixture({ 'users/victim': { ...ordinary, stagedDocId: 'victim-stage' } })
  await assert.rejects(authorizeStage(db, 'victim-stage', { ...stage, userId: 'victim', templateUserId: 'alice' }, { ...stage, userId: 'victim' }, mirror), { code: 'permission-denied' })
  await assert.rejects(authorizeStage(db, 'alice-stage', { ...stage, userId: 'victim' }, stage, mirror), { code: 'permission-denied' })
})
test('self profile edit and self grant removal work; scoped admin can assign within scope', async () => {
  const { db, data, stage, mirror } = fixture()
  await authorizeStage(db, 'alice-stage', { ...stage, meta: { name: 'Updated' } }, stage, mirror)
  assert.equal(data['users/alice'].meta.name, 'Updated')
  await authorizeStage(db, 'alice-stage', { ...stage, roles: {} }, stage, mirror)
  assert.deepEqual(data['users/alice'].roles, {})
  await authorizeStage(db, 'alice-stage', { ...stage, uid: 'admin', roles: { 'organizations-a': role('organizations-a', 'writer') } }, stage, mirror)
  assert.equal(data['users/alice'].roles['organizations-a'].role, 'writer')
})
test('scope boundaries, old scope, special assign and root roles are checked', () => {
  const scoped = { roles: { a: role('organizations-a', 'admin') } }
  assert.equal(canAssign(scoped, 'organizations-a-files'), true)
  assert.equal(canAssign(scoped, 'organizations-ab'), false)
  assert.equal(canAssign({ roles: { a: role('-', 'user') } }, 'organizations-a'), false)
  assert.equal(canAssign({ roles: { a: role('-', 'admin') } }, '-'), true)
  assert.equal(canAssign({ specialPermissions: { a: { collectionPath: 'organizations-a', permissions: { assign: true } } } }, 'organizations-a-files'), true)
})
test('changing a role scope checks both old and new scope; modifying special permissions requires assign', async () => {
  const { db, stage, mirror } = fixture()
  await assert.rejects(authorizeStage(db, 'alice-stage', { ...stage, uid: 'admin', roles: { 'organizations-ab': role('organizations-ab', 'admin') } }, stage, mirror), { code: 'permission-denied' })
  await assert.rejects(authorizeStage(db, 'alice-stage', { ...stage, specialPermissions: { 'organizations-a': { collectionPath: 'organizations-a', permissions: { write: true } } } }, stage, mirror), { code: 'permission-denied' })
})
for (const template of [false, true]) {
  test(`${template ? 'template' : 'invitation'} registration inherits approved grants and rejects poisoned grants/configuration`, async () => {
    const { db, data, mirror } = fixture()
    const invitation = { userId: '', templateUserId: '', uid: 'admin', isTemplate: template, meta: {}, roles: { 'organizations-a': role('organizations-a') }, specialPermissions: {}, subCreate: {} }
    await authorizeStage(db, 'invite', invitation, {}, mirror)
    assert.ok(data[approvalRef(db, 'invite').path])
    const claim = { ...invitation, uid: 'bob', [template ? 'templateUserId' : 'userId']: 'bob' }
    for (const poison of [{ roles: { '-': role('-', 'admin') } }, { subCreate: { rootPath: 'users', role: 'admin' } }, { uid: 'alice' }]) {
      await assert.rejects(authorizeStage(db, 'invite', { ...claim, ...poison }, invitation, mirror), { code: 'permission-denied' })
    }
    const result = await authorizeStage(db, 'invite', claim, invitation, mirror)
    assert.equal(result.mirrored, !template)
    assert.deepEqual(result.data.roles, invitation.roles)
    if (!template) await assert.rejects(authorizeStage(db, 'invite', { ...claim, userId: 'charlie', uid: 'charlie' }, invitation, mirror), { code: 'permission-denied' })
  })
}
test('legacy unapproved invitations fail closed until admin approves all grants; rejected poisoning cannot create approval', async () => {
  const { db, data, mirror } = fixture()
  const invitation = { uid: 'alice', userId: '', templateUserId: '', roles: { '-': role('-', 'admin') } }
  await assert.rejects(authorizeStage(db, 'invite', invitation, invitation, mirror), { code: 'permission-denied' })
  assert.equal(data[approvalRef(db, 'invite').path], undefined)
  await assert.rejects(authorizeStage(db, 'invite', { ...invitation, roles: {}, userId: 'bob', uid: 'bob' }, invitation, mirror), { code: 'permission-denied' })
})

test('changing the value of an existing role cannot promote a user; explicit trusted special assign permits assignment', async () => {
  const { db, stage, mirror } = fixture({ 'users/delegated': { specialPermissions: { 'organizations-a': { collectionPath: 'organizations-a', permissions: { assign: true } } } } })
  const promoted = { ...stage, roles: { 'organizations-a': role('organizations-a', 'admin') } }
  await assert.rejects(authorizeStage(db, 'alice-stage', promoted, stage, mirror), { code: 'permission-denied' })
  await authorizeStage(db, 'alice-stage', { ...promoted, uid: 'delegated' }, stage, mirror)
  assert.equal(canAssign({ specialPermissions: { '-': { collectionPath: '-', permissions: { assign: true } } } }, 'organizations-b'), true)
})

test('empty invitations from scoped admins are approved; making multi-scope invitations reusable requires every scope', async () => {
  const { db, data, mirror } = fixture({ 'users/root': { roles: { '-': role('-', 'admin') } } })
  const invitation = { uid: 'admin', userId: '', templateUserId: '', roles: {}, specialPermissions: {}, subCreate: {}, isTemplate: false }
  await authorizeStage(db, 'empty-invite', invitation, {}, mirror)
  assert.ok(data[approvalRef(db, 'empty-invite').path])
  const multiScope = { ...invitation, uid: 'root', roles: { 'organizations-a': role('organizations-a'), 'organizations-b': role('organizations-b') } }
  await authorizeStage(db, 'multi-invite', multiScope, {}, mirror)
  await assert.rejects(authorizeStage(db, 'multi-invite', { ...multiScope, uid: 'admin', isTemplate: true }, multiScope, mirror), { code: 'permission-denied' })
})
