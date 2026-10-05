const test = require('node:test')
const assert = require('node:assert/strict')
const { checkUserMirrorWrite, canAssign } = require('./userMirrorPermissionCheck')
const role = (collectionPath, value = 'user') => ({ collectionPath, role: value })
const registered = { userId: 'alice', stagedDocId: 'stage', meta: {}, roles: { 'organizations-a': role('organizations-a') }, specialPermissions: {} }
function fixture() {
  const users = {
    alice: structuredClone(registered),
    admin: { roles: { 'organizations-a': role('organizations-a', 'admin') } },
    delegated: { specialPermissions: { 'organizations-a': { collectionPath: 'organizations-a', permissions: { assign: true } } } },
  }
  const db = { collection: () => ({ doc: id => ({ get: async () => ({ exists: Boolean(users[id]), data: () => users[id] }) }) }) }
  const stage = { ...structuredClone(registered), uid: 'alice' }
  const event = (after, before = stage, authType = 'api_key') => ({ authType, data: { before: { data: () => before }, after: { data: () => after } } })
  return { db, stage, event }
}
for (const changed of [
  { roles: { '-': role('-', 'admin') } },
  { roles: { 'organizations-a': role('organizations-a', 'admin') } },
  { specialPermissions: { 'organizations-a': { collectionPath: 'organizations-a', permissions: { assign: true } } } },
]) {
  test(`client cannot add/promote its own ${Object.keys(changed)[0]}, including a later unchanged poisoned staging snapshot`, async () => {
    const { db, stage, event } = fixture()
    const poison = { ...stage, ...changed }
    await assert.rejects(checkUserMirrorWrite(db, event(poison), 'stage'), { code: 'permission-denied' })
    await assert.rejects(checkUserMirrorWrite(db, event({ ...poison, meta: { name: 'Retry' } }, poison), 'stage'), { code: 'permission-denied' })
  })
}
test('profile edits, own removals, scoped admin and delegated assign remain valid', async () => {
  const { db, stage, event } = fixture()
  await checkUserMirrorWrite(db, event({ ...stage, meta: { name: 'Alice' } }), 'stage')
  await checkUserMirrorWrite(db, event({ ...stage, roles: {} }), 'stage')
  for (const uid of ['admin', 'delegated']) await checkUserMirrorWrite(db, event({ ...stage, uid, roles: { 'organizations-a': role('organizations-a', 'writer') } }), 'stage')
  await assert.rejects(checkUserMirrorWrite(db, event({ ...stage, uid: 'admin', roles: { 'organizations-ab': role('organizations-ab', 'admin') } }), 'stage'), { code: 'permission-denied' })
})
test('CMS service-account writes remain valid without approval records; a data flag cannot grant that exemption', async () => {
  const { db, stage, event } = fixture()
  const serverRoles = { ...stage, roles: { 'organizations-a': role('organizations-a', 'editor') } }
  await checkUserMirrorWrite(db, event(serverRoles, stage, 'service_account'), 'stage')
  await assert.rejects(checkUserMirrorWrite(db, event({ ...serverRoles, authType: 'service_account' }), 'stage'), { code: 'permission-denied' })
})
test('existing invitation claim requires no approval but cannot change grants in that write', async () => {
  const { db, stage, event } = fixture()
  const before = { ...stage, uid: '', userId: '', isTemplate: false }
  await checkUserMirrorWrite(db, event({ ...before, userId: 'new-user', uid: 'new-user' }, before), 'stage')
  await assert.rejects(checkUserMirrorWrite(db, event({ ...before, userId: 'new-user', uid: 'new-user', roles: { '-': role('-', 'admin') } }, before), 'stage'), { code: 'permission-denied' })
})
test('scope boundary is exact; non-admin root does not confer assign', () => {
  assert.equal(canAssign({ roles: { a: role('organizations-a', 'admin') } }, 'organizations-ab'), false)
  assert.equal(canAssign({ roles: { a: role('-', 'user') } }, 'organizations-a'), false)
})
