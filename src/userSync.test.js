/* eslint-env node */
/* eslint-disable @typescript-eslint/no-var-requires */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

// Exercise the actual helper copied into consumer Functions, without initializing
// Firebase or registering unrelated triggers.
const source = fs.readFileSync(path.join(__dirname, 'edgeFirebase.js'), 'utf8')
const helper = source.slice(source.indexOf('async function setUser('), source.indexOf('\nfunction markProcessed('))
function load(db) {
  const context = { db }
  vm.runInNewContext(helper, context)
  return context.setUser
}
const clone = data => JSON.parse(JSON.stringify(data))
function apply(existing, update, options) {
  if (!options) return clone(update)
  const result = { ...existing }
  for (const field of options.mergeFields) result[field] = clone(update[field])
  return result
}

for (const reverse of [false, true]) {
  test(`overlapping first writes retain destination identity in ${reverse ? 'reverse' : 'forward'} order`, async () => {
    const writes = []
    let stored = {}
    const ref = {
      id: 'target-user',
      // Model both calls seeing the same stale missing-document snapshot.
      get: async () => ({ exists: false }),
      set: (data, options) => new Promise(resolve => writes.push(() => {
        stored = apply(stored, data, options)
        resolve()
      })),
    }
    const setUser = load()
    const tasks = [
      setUser(ref, { uid: 'target-user', userId: 'target-user', meta: { revision: 1 } }, {}, 'stage'),
      setUser(ref, { uid: 'admin-editor', userId: 'target-user', meta: { revision: 2 } }, { userId: 'target-user' }, 'stage'),
    ]
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(writes.length, 2)
    for (const write of reverse ? writes.reverse() : writes) write()
    await Promise.all(tasks)
    assert.equal(stored.userId, 'target-user')
  })
}

test('template path without newData.userId uses destination identity, not actor uid', async () => {
  let stored
  const ref = { id: 'template-target', get: async () => ({ exists: false }), set: async data => { stored = clone(data) } }
  await load()(ref, { uid: 'admin-creator', meta: {} }, {}, 'stage')
  assert.equal(stored.userId, 'template-target')
})

test('repairs missing identity, replaces permissions maps, and preserves unrelated fields', async () => {
  let stored = { favorites: ['listing-1'], meta: { obsolete: true }, roles: { revoked: { role: 'admin' }, kept: { role: 'editor' } }, specialPermissions: { revoked: { write: true }, kept: { read: true } } }
  const ref = {
    id: 'target-user', get: async () => ({ exists: true }),
    set: async (data, options) => { stored = apply(stored, data, options) },
    update: async data => { stored = { ...stored, ...clone(data) } },
  }
  const setUser = load()
  await setUser(ref, { uid: 'editor', meta: { current: true }, roles: { kept: { role: 'user' } }, specialPermissions: { kept: { read: true } } }, { userId: 'target-user' }, 'stage')
  assert.equal(stored.userId, 'target-user')
  assert.deepEqual(stored.favorites, ['listing-1'])
  assert.deepEqual(stored.roles, { kept: { role: 'user' } })
  assert.deepEqual(stored.specialPermissions, { kept: { read: true } })
  assert.deepEqual(stored.meta, { current: true })
  await setUser(ref, { meta: {}, roles: {}, specialPermissions: {} }, {}, 'stage')
  assert.deepEqual(stored.roles, {})
  assert.deepEqual(stored.specialPermissions, {})
})

test('omitted permission maps remain untouched', async () => {
  let stored = { roles: { kept: { role: 'user' } }, specialPermissions: { kept: { read: true } } }
  const ref = { id: 'target-user', get: async () => ({ exists: true }), set: async (data, options) => { stored = apply(stored, data, options) } }
  await load()(ref, { meta: {} }, {}, 'stage')
  assert.deepEqual(stored.roles, { kept: { role: 'user' } })
  assert.deepEqual(stored.specialPermissions, { kept: { read: true } })
})

test('real Firestore upsert preserves identity and removes revoked map entries', { skip: !process.env.USER_SYNC_FIRESTORE_SDK }, async () => {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:18089')
  const { Firestore } = require(process.env.USER_SYNC_FIRESTORE_SDK)
  const db = new Firestore({ projectId: 'demo-user-sync' })
  try {
    const setUser = load(db)
    const ref = db.collection('users').doc('target-user')
    await Promise.all([
      setUser(ref, { uid: 'actor', meta: {} }, {}, 'stage'),
      setUser(ref, { uid: 'actor', userId: 'target-user', meta: {} }, { userId: 'target-user' }, 'stage'),
    ])
    assert.equal((await ref.get()).data().userId, ref.id)
    await ref.set({ favorites: ['listing-1'], roles: { revoked: { role: 'admin' }, kept: { role: 'editor' } }, specialPermissions: { revoked: { write: true }, kept: { read: true } } })
    await setUser(ref, { uid: 'editor', meta: {}, roles: { kept: { role: 'user' } }, specialPermissions: { kept: { read: true } } }, { userId: ref.id }, 'stage')
    const stored = (await ref.get()).data()
    assert.equal(stored.userId, ref.id)
    assert.deepEqual(stored.favorites, ['listing-1'])
    assert.deepEqual(stored.roles, { kept: { role: 'user' } })
    assert.deepEqual(stored.specialPermissions, { kept: { read: true } })
  } finally { await db.terminate() }
})
