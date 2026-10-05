const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

test('real Firestore: staged attacks never reach canonical/public/org users; profile, admin edits and registration work', { skip: !process.env.USER_SYNC_FIRESTORE_SDK }, async () => {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:18089')
  const { Firestore } = require(process.env.USER_SYNC_FIRESTORE_SDK)
  const db = new Firestore({ projectId: 'demo-user-sync' })
  const localRequire = createRequire(path.join(__dirname, 'edgeFirebase.js'))
  const factory = (...args) => args.at(-1)
  const exports = {}
  const config = new Proxy({ db, HttpsError: class extends Error {}, admin: {} }, { get: (target, key) => target[key] || factory })
  // Use the same JS realm as the SDK, whose transactions require native Promises.
  new Function('require', 'exports', 'process', 'console', fs.readFileSync(path.join(__dirname, 'edgeFirebase.js'), 'utf8'))(id => id === './config.js' ? config : localRequire(id), exports, process, console)
  const r = (collectionPath, role = 'user') => ({ collectionPath, role })
  const stageRef = db.collection('staged-users').doc('alice-stage')
  const userRef = db.collection('users').doc('alice')
  const original = { userId: 'alice', stagedDocId: 'alice-stage', meta: { name: 'Alice' }, roles: { 'organizations-a': r('organizations-a') }, specialPermissions: {} }
  const initialStage = { ...original, uid: 'alice', templateUserId: '', isTemplate: false }
  let eventNumber = 0
  async function update(after) {
    const before = await stageRef.get()
    await stageRef.set(after)
    const snapshot = await stageRef.get()
    return { id: `test-${++eventNumber}`, params: { docId: stageRef.id }, data: { before, after: snapshot } }
  }
  try {
    await userRef.set(original)
    await stageRef.set(initialStage)
    await db.collection('rule-helpers').doc('alice').set({})
    await db.collection('users').doc('admin').set({ roles: { 'organizations-a': r('organizations-a', 'admin') } })
    const poisoned = { ...initialStage, roles: { ...original.roles, '-': r('-', 'admin') } }
    const payload = { sub: 'alice', user_id: 'alice', aud: 'demo-user-sync', iss: 'https://securetoken.google.com/demo-user-sync', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, firebase: { sign_in_provider: 'custom' } }
    const token = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.`
    const encode = value => typeof value === 'string' ? { stringValue: value } : typeof value === 'boolean' ? { booleanValue: value } : { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, val]) => [key, encode(val)])) } }
    const put = (document, value) => fetch(`http://127.0.0.1:18089/v1/projects/demo-user-sync/databases/(default)/documents/${document}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(value).map(([key, val]) => [key, encode(val)])) }),
    })
    assert.equal((await put('users/alice', { ...original, uid: 'alice' })).status, 403)
    assert.equal((await put('events/user-sync-approval-forged', { uid: 'alice' })).status, 403)
    const beforeAttack = await stageRef.get()
    assert.equal((await put('staged-users/alice-stage', poisoned)).status, 200)
    await assert.rejects(exports.updateUser({ id: 'client-attack', params: { docId: stageRef.id }, data: { before: beforeAttack, after: await stageRef.get() } }), { code: 'permission-denied' })
    await assert.rejects(exports.updateUser(await update({ ...poisoned, meta: { name: 'Poison retry' } })), { code: 'permission-denied' })
    assert.deepEqual((await userRef.get()).data(), original)
    assert.equal((await db.collection('public-users').doc('alice-stage').get()).exists, false)
    const profile = { ...initialStage, meta: { name: 'Updated' } }
    await exports.updateUser(await update(profile))
    assert.equal((await userRef.get()).data().meta.name, 'Updated')
    assert.equal((await db.collection('public-users').doc('alice-stage').get()).data().userId, 'alice')
    const adminEdit = { ...profile, uid: 'admin', roles: { 'organizations-a': r('organizations-a', 'writer') } }
    await exports.updateUser(await update(adminEdit))
    assert.equal((await userRef.get()).data().roles['organizations-a'].role, 'writer')
    const stale = await update({ ...adminEdit, meta: { name: 'Stale' } })
    await update({ ...adminEdit, meta: { name: 'Newer staging' } })
    await exports.updateUser(stale)
    assert.equal((await userRef.get()).data().meta.name, 'Updated')
    for (const isTemplate of [false, true]) {
      const ref = db.collection('staged-users').doc(isTemplate ? 'template-invite' : 'simple-invite')
      const invitation = { userId: '', uid: 'admin', templateUserId: '', isTemplate, meta: {}, roles: { 'organizations-a': r('organizations-a') }, specialPermissions: {}, subCreate: {} }
      await ref.set(invitation)
      await exports.approveUserInvitation({ params: { docId: ref.id }, data: await ref.get() })
      const before = await ref.get()
      const uid = isTemplate ? 'template-bob' : 'bob'
      await ref.update({ uid, [isTemplate ? 'templateUserId' : 'userId']: uid, ...(isTemplate ? { templateMeta: { name: 'Bob' } } : { meta: { name: 'Bob' } }) })
      await exports.updateUser({ id: `claim-${uid}`, params: { docId: ref.id }, data: { before, after: await ref.get() } })
      const result = (await db.collection('users').doc(uid).get()).data()
      assert.equal(result.userId, uid)
      assert.deepEqual(result.roles, invitation.roles)
    }
    const extraRef = db.collection('staged-users').doc('callable-invite')
    const extraInvite = { userId: '', uid: 'admin', templateUserId: '', isTemplate: false, meta: {}, roles: { 'organizations-a-files': r('organizations-a-files', 'writer') }, specialPermissions: {}, subCreate: {} }
    await extraRef.set(extraInvite)
    await exports.approveUserInvitation({ params: { docId: extraRef.id }, data: await extraRef.get() })
    // The callable must consume the approval, even if mutable staging was poisoned.
    await extraRef.update({ roles: { '-': r('-', 'admin') } })
    const result = await exports.currentUserRegister({ auth: { uid: 'alice' }, data: { uid: 'alice', registrationCode: extraRef.id } })
    assert.equal(result.success, true)
    assert.equal((await userRef.get()).data().roles['-'], undefined)
    assert.equal((await userRef.get()).data().roles['organizations-a-files'].role, 'writer')
    assert.equal((await extraRef.get()).exists, false)
    await db.collection('users').doc('root').set({ roles: { '-': r('-', 'admin') } })
    const orgTemplateRef = db.collection('staged-users').doc('org-template')
    const orgTemplate = { uid: 'root', userId: '', templateUserId: '', isTemplate: true, meta: {}, roles: {}, specialPermissions: {}, subCreate: { rootPath: 'organizations', role: 'admin', dynamicDocumentField: 'name', documentStructure: { name: '' } } }
    await orgTemplateRef.set(orgTemplate)
    await exports.approveUserInvitation({ params: { docId: orgTemplateRef.id }, data: await orgTemplateRef.get() })
    const templateBefore = await orgTemplateRef.get()
    await orgTemplateRef.update({ uid: 'new-org-owner', templateUserId: 'new-org-owner', templateMeta: { name: 'Owner' }, requestedOrgId: 'new-organization', dynamicDocumentFieldValue: 'New organization' })
    await exports.updateUser({ id: 'org-claim', params: { docId: orgTemplateRef.id }, data: { before: templateBefore, after: await orgTemplateRef.get() } })
    const owner = (await db.collection('users').doc('new-org-owner').get()).data()
    assert.equal(owner.roles['organizations-new-organization'].role, 'admin')
    assert.equal((await db.collection('organizations').doc('new-organization').get()).data().name, 'New organization')
    await exports.currentUserRegister({ auth: { uid: 'alice' }, data: { uid: 'alice', registrationCode: orgTemplateRef.id, dynamicDocumentFieldValue: 'Additional organization' } })
    assert.ok(Object.values((await userRef.get()).data().roles).some(role => role.role === 'admin'))
    const canonicalBefore = await userRef.get()
    await userRef.update({ meta: { name: 'Org profile' } })
    await exports.userSyncMetaToOrg({ data: { before: canonicalBefore, after: await userRef.get() } })
    assert.equal((await db.collection('organizations/a/users').doc('alice-stage').get()).data().name, 'Org profile')
    console.log('Verified real canonical/public/organization document readback and both registration handlers.')
  } finally { await db.terminate() }
})
