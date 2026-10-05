const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

test('CMS-style server-created registration works without approval records and overlapping syncs retain identity', { skip: !process.env.USER_SYNC_FIRESTORE_SDK }, async () => {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:18089')
  const { Firestore } = require(process.env.USER_SYNC_FIRESTORE_SDK)
  const db = new Firestore({ projectId: 'demo-user-sync' })
  const localRequire = createRequire(path.join(__dirname, 'edgeFirebase.js'))
  const sdkRequire = createRequire(process.env.USER_SYNC_FIRESTORE_SDK)
  const configModule = { exports: {} }
  const services = {
    'firebase-functions': {}, '@google-cloud/pubsub': { PubSub: class {} },
    'firebase-admin': { initializeApp() {} }, '@google-cloud/storage': { Storage: class {} },
    'firebase-admin/firestore': { getFirestore: () => db }, 'twilio': {},
    'firebase-functions/v2': { setGlobalOptions() {}, logger: {} },
  }
  new Function('require', 'module', 'process', fs.readFileSync(path.join(__dirname, 'config.js'), 'utf8'))(
    id => id in services ? services[id] : id.startsWith('./') ? localRequire(id) : sdkRequire(id), configModule, process)
  const nativeTrigger = configModule.exports.onDocumentUpdatedWithAuthContext({ document: 'staged-users/{docId}' }, async () => {})
  assert.equal(nativeTrigger.__endpoint.eventTrigger.eventType, 'google.cloud.firestore.document.v1.updated.withAuthContext')
  const factory = (...args) => args.at(-1)
  const exports = {}
  const config = new Proxy({ db, HttpsError: class extends Error {}, admin: {} }, { get: (target, key) => target[key] || factory })
  new Function('require', 'exports', 'process', 'console', fs.readFileSync(path.join(__dirname, 'edgeFirebase.js'), 'utf8'))(id => id === './config.js' ? config : localRequire(id), exports, process, console)
  const roles = {
    'organizations-org-sites-site-audience-users-member': { collectionPath: 'organizations-org-sites-site-audience-users-member', role: 'user' },
    'organizations-org-sites-site-audience-users-member-data': { collectionPath: 'organizations-org-sites-site-audience-users-member-data', role: 'editor' },
  }
  const stageRef = db.collection('staged-users').doc('cms-registration')
  const targetRef = db.collection('users').doc('cms-user')
  try {
    // Matches the existing restricted-content CMS writer: an Admin SDK staging
    // record with roles, followed by registration linking it to the Auth UID.
    await stageRef.set({ docId: stageRef.id, uid: '', userId: '', meta: { name: 'CMS user', email: 'cms@example.test' }, roles, collectionPaths: Object.keys(roles), specialPermissions: {} })
    assert.equal((await db.collection('events').doc(`user-sync-approval-${stageRef.id}`).get()).exists, false)
    const unclaimed = await stageRef.get()
    await stageRef.update({ uid: 'cms-user', userId: 'cms-user' })
    const claimed = await stageRef.get()
    await stageRef.update({ 'meta.name': 'Updated CMS user' })
    const edited = await stageRef.get()
    await Promise.all([
      exports.updateUser({ authType: 'api_key', id: 'cms-claim', params: { docId: stageRef.id }, data: { before: unclaimed, after: claimed } }),
      exports.updateUser({ authType: 'service_account', id: 'cms-edit', params: { docId: stageRef.id }, data: { before: claimed, after: edited } }),
    ])
    const stored = (await targetRef.get()).data()
    assert.equal(stored.userId, targetRef.id)
    assert.equal(stored.stagedDocId, stageRef.id)
    assert.deepEqual(stored.roles, roles)
    assert.deepEqual(stored.specialPermissions, {})
    assert.equal((await db.collection('events').doc(`user-sync-approval-${stageRef.id}`).get()).exists, false)
    // A browser cannot promote its own role, even if the bad value remains in
    // staging and a later profile edit submits the same permissions again.
    const trustedBefore = await stageRef.get()
    await stageRef.update({ roles: { '-': { collectionPath: '-', role: 'admin' } } })
    const poison = await stageRef.get()
    await assert.rejects(exports.updateUser({ authType: 'api_key', id: 'self-promote', params: { docId: stageRef.id }, data: { before: trustedBefore, after: poison } }), { code: 'permission-denied' })
    await stageRef.update({ 'meta.name': 'Poison retry' })
    await assert.rejects(exports.updateUser({ authType: 'api_key', id: 'self-promote-retry', params: { docId: stageRef.id }, data: { before: poison, after: await stageRef.get() } }), { code: 'permission-denied' })
    assert.deepEqual((await targetRef.get()).data().roles, roles)
    // Existing CMS server assignments still work with the recipient's uid.
    const serverBefore = await stageRef.get()
    const serverRoles = { ...roles, 'organizations-org-sites-site-other': { collectionPath: 'organizations-org-sites-site-other', role: 'user' } }
    await stageRef.update({ roles: serverRoles })
    await exports.updateUser({ authType: 'service_account', id: 'cms-assignment', params: { docId: stageRef.id }, data: { before: serverBefore, after: await stageRef.get() } })
    assert.deepEqual((await targetRef.get()).data().roles, serverRoles)
    // Preserve the established template registration path as well.
    const templateRef = db.collection('staged-users').doc('legacy-template')
    await templateRef.set({ uid: 'creator', userId: '', templateUserId: '', isTemplate: true, meta: {}, roles, specialPermissions: {}, collectionPaths: Object.keys(roles), subCreate: {} })
    const templateBefore = await templateRef.get()
    await templateRef.update({ uid: 'template-user', templateUserId: 'template-user', templateMeta: { name: 'Template user' } })
    await exports.updateUser({ authType: 'api_key', id: 'template-claim', params: { docId: templateRef.id }, data: { before: templateBefore, after: await templateRef.get() } })
    assert.equal((await db.collection('users').doc('template-user').get()).data().userId, 'template-user')
    console.log('Verified existing CMS-style and template registrations without approval records, including overlapping actual mirror handlers.')
  } finally { await db.terminate() }
})
