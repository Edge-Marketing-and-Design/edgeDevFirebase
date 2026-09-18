/* eslint-env node */
/* eslint-disable @typescript-eslint/no-var-requires */
const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { normalizeAttempt, createLoginAuditHandlers, RETENTION_MS } = require('./loginAudit')
const time = new Date('2026-09-18T12:00:00Z')
const data = { method: 'password', stage: 'authentication', outcome: 'failed', attemptedIdentifier: ' User@Example.com ', errorCode: 'auth/invalid-credential', site: 'https://example.com/login?token=secret' }

function fixture() {
  const records = new Map()
  const queries = []
  let sequence = 0
  let writes = 0
  class HttpsError extends Error { constructor(code, message) { super(message); this.code = code } }
  const db = {
    collection(name) {
      const query = {
        doc(id = `auto-${sequence++}`) {
          const key = `${name}/${id}`
          return { key, get: async () => ({ data: () => records.get(key) }) }
        },
        where(...args) { queries.push(['where', ...args]); return query },
        orderBy(...args) { queries.push(['orderBy', ...args]); return query },
        limit(...args) { queries.push(['limit', ...args]); return query },
        async get() { return { docs: [] } },
      }
      return query
    },
    async runTransaction(fn) {
      return fn({ get: ref => ref.get(), set(ref, value) { records.set(ref.key, value); writes++ } })
    },
  }
  return { records, queries, writes: () => writes, ...createLoginAuditHandlers({ db, HttpsError, now: () => time }) }
}

test('records only bounded audit fields, server timestamps, safe errors and 60-day expiry', () => {
  const record = normalizeAttempt({ ...data, password: 'secret', token: 'secret', errorMessage: 'secret', createdAt: 'spoof', uid: 'spoof' }, { auth: { uid: 'verified' } }, time)
  assert.equal(record.attemptedIdentifier, 'user@example.com')
  assert.equal(record.authenticatedUid, 'verified')
  assert.equal(record.site, 'https://example.com')
  assert.equal(record.errorMessage, 'Invalid login credentials.')
  assert.equal(record.expiresAt - record.createdAt, RETENTION_MS)
  assert.equal(JSON.stringify(record).includes('secret'), false)
  assert.equal(JSON.stringify(record).includes('spoof'), false)
  assert.equal(normalizeAttempt({ ...data, method: 'bad' }, {}, time), null)
  assert.equal(normalizeAttempt({ ...data, errorCode: 'token=secret' }, {}, time).errorCode, 'auth/unknown')
})

test('allows signed-out failures and limits writes to 120 records per IP per hour', async () => {
  const f = fixture()
  const request = { data, rawRequest: { ip: '127.0.0.1' } }
  for (let i = 0; i < 120; i++) assert.equal((await f.record(request)).recorded, true)
  const count = f.writes()
  assert.equal((await f.record(request)).recorded, false)
  assert.equal(f.writes(), count)
  assert.equal(f.records.get('login-log/auto-0').authenticatedUid, null)
  assert.equal(JSON.stringify([...f.records]).includes('127.0.0.1'), false)
})

test('global daily cap blocks new IPs without creating more documents', async () => {
  const f = fixture()
  f.records.set('login-log-limits/global', { window: Math.floor(time / 86400000), count: 10000 })
  assert.equal((await f.record({ data, rawRequest: { ip: 'new-ip' } })).recorded, false)
  assert.equal(f.writes(), 0)
})

test('expired windows reset and malformed requests do not write', async () => {
  const f = fixture()
  const hash = createHash('sha256').update('test-ip').digest('hex')
  f.records.set(`login-log-limits/${hash}`, { window: 0, count: 10000 })
  f.records.set('login-log-limits/global', { window: 0, count: 10000 })
  assert.equal((await f.record({ data: {} })).recorded, false)
  assert.equal(f.writes(), 0)
  assert.equal((await f.record({ data, rawRequest: { ip: 'test-ip' } })).recorded, true)
})

test('only root admins can query logs; filter is normalized and results bounded/unexpired', async () => {
  const f = fixture()
  await assert.rejects(f.list({ data: {} }), { code: 'unauthenticated' })
  for (const role of [{ collectionPath: 'organizations-one', role: 'admin' }, { collectionPath: '-', role: 'editor' }]) {
    f.records.set('users/test', { roles: { test: role } })
    await assert.rejects(f.list({ auth: { uid: 'test' }, data: {} }), { code: 'permission-denied' })
  }
  f.records.set('users/test', { roles: { '-': { collectionPath: '-', role: 'admin' } } })
  assert.deepEqual(await f.list({ auth: { uid: 'test' }, data: { attemptedIdentifier: ' USER@EXAMPLE.COM ' } }), { records: [] })
  assert.deepEqual(f.queries, [['where', 'attemptedIdentifier', '==', 'user@example.com'], ['where', 'expiresAt', '>', time], ['orderBy', 'expiresAt', 'desc'], ['limit', 100]])
})
