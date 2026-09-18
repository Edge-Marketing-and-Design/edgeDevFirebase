/* eslint-env node */
/* eslint-disable @typescript-eslint/no-var-requires */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
function load(file, dependencies) {
  const exports = {}
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  vm.runInNewContext(source, { exports, require: name => dependencies[name] || {}, console, setTimeout })
  return exports
}
const { createLoginAttempt } = load('loginAudit.ts', {})
const settle = () => new Promise(resolve => setImmediate(resolve))
function client({ failure, emulatorAuth, rejectAudit = false, profileExists = true, profileFailure = false, onAudit } = {}) {
  const sent = []
  const auditRequests = []
  const dependencies = {
    './loginAudit': { createLoginAttempt },
    './errorReporting': { getBrowserErrorReporter: () => ({ captureCallableError() { throw new Error('Unexpected Monitor call') } }) },
    'vue': { reactive: value => value },
    'firebase/app': { initializeApp: () => ({}) },
    'firebase/auth': {
      initializeAuth: () => ({}), onAuthStateChanged() {}, connectAuthEmulator() {},
      signOut: async () => {},
      OAuthProvider: class {
        setCustomParameters() {}
        addScope() {}
      },
      signInWithPopup: async () => { throw failure },
      signInWithCustomToken: async () => { if (failure) throw failure; return { user: { uid: 'test', email: 'resolved@example.com' } } },
      isSignInWithEmailLink: () => true,
      signInWithEmailLink: async () => { if (failure) throw failure; return { user: { uid: 'test' } } },
      signInWithEmailAndPassword: async () => { if (failure) throw failure; return { user: { uid: 'test' } } },
    },
    'firebase/firestore': {
      getFirestore: () => ({}), doc: () => ({}),
      getDoc: async () => { if (profileFailure) throw new Error('profile denied'); return { exists: () => profileExists } },
    },
    'firebase/functions': {
      getFunctions: () => ({}),
      httpsCallable: (functions, name) => async payload => {
        sent.push({ name, payload })
        if (rejectAudit) throw new Error('offline')
        if (onAudit && name === 'edgeFirebase-recordLoginAttempt') {
          const request = onAudit(JSON.parse(JSON.stringify(payload)))
          auditRequests.push(request)
          return { data: await request }
        }
        return { data: {} }
      },
    },
  }
  const { EdgeFirebase } = load('edgeFirebase.ts', dependencies)
  return { instance: new EdgeFirebase({ projectId: 'demo-test', emulatorAuth }, false, false), sent, auditRequests }
}

test('password failure keeps UI error, reports attempted email, never sends password/error text to audit', async () => {
  const { instance, sent } = client({ failure: { code: 'auth/invalid-credential', message: 'sensitive-message' } })
  instance.logIn({ email: 'typed@example.com', password: 'secret-password' })
  await settle()
  assert.equal(instance.user.logInError, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].name, 'edgeFirebase-recordLoginAttempt')
  assert.equal(sent[0].payload.attemptedIdentifier, 'typed@example.com')
  assert.equal(sent[0].payload.errorCode, 'auth/invalid-credential')
  assert.equal(JSON.stringify(sent).includes('secret-password'), false)
  assert.equal(JSON.stringify(sent).includes('sensitive-message'), false)
})

test('password success is logged and audit failure does not turn login into failure', async () => {
  const { instance, sent } = client({ rejectAudit: true })
  instance.logIn({ email: 'typed@example.com', password: 'secret' })
  await settle()
  assert.equal(sent[0].payload.outcome, 'success')
  assert.equal(instance.user.logInError, false)
})

test('local Auth cannot send audit events to production Functions', async () => {
  const { instance, sent } = client({ emulatorAuth: '9099' })
  instance.logIn({ email: 'typed@example.com', password: 'secret' })
  await settle()
  assert.equal(sent.length, 0)
})

test('access denial waits for authentication and repeated metadata updates do not duplicate it', () => {
  const records = []
  const attempt = createLoginAttempt(async record => records.push(record), 'microsoft')
  attempt.access('failed', 'app/no-permissions')
  assert.equal(records.length, 0)
  attempt.authentication('success', '', 'resolved@example.com')
  attempt.access('failed', 'app/no-permissions')
  attempt.authentication('success')
  assert.equal(records.length, 2)
  assert.equal(records[1].stage, 'application-access')
  assert.equal(records[1].attemptedIdentifier, 'resolved@example.com')
  assert.equal(records[1].errorCode, 'app/no-permissions')
})

test('synchronous audit transport failure is swallowed', () => {
  const attempt = createLoginAttempt(() => { throw new Error('offline') }, 'password')
  assert.doesNotThrow(() => attempt.authentication('failed'))
})

for (const method of ['microsoft', 'phone', 'custom-token', 'email-link']) {
  test(`${method} failure is audited without credentials`, async () => {
    const failure = { code: 'auth/invalid-credential', message: 'private error' }
    const { instance, sent } = client({ failure })
    if (method === 'microsoft') {
      instance.signInWithMicrosoft = async () => failure
      await instance.logInWithMicrosoft()
    } else if (method === 'phone') {
      instance.runFunction = async () => ({ data: { success: false, error: 'Invalid code' } })
      await instance.logInWithPhone('+15551234567', 'private-code')
    } else if (method === 'custom-token') {
      await instance.loginWithCustomToken('private-token')
    } else {
      await instance.signInWithEmailLink('typed@example.com', 'https://site.test/?oobCode=private-code')
    }
    await settle()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].payload.method, method)
    assert.equal(sent[0].payload.outcome, 'failed')
    const expectedIdentifier = { microsoft: '', phone: '+15551234567', 'custom-token': '', 'email-link': 'typed@example.com' }
    assert.equal(sent[0].payload.attemptedIdentifier, expectedIdentifier[method])
    assert.equal(JSON.stringify(sent).includes('private-'), false)
  })
}

test('custom-token profile failure is separate from authentication success', async () => {
  const { instance, sent } = client({ profileFailure: true })
  await instance.loginWithCustomToken('private-token')
  await settle()
  assert.equal(sent.length, 2)
  assert.equal(sent[0].payload.outcome, 'success')
  assert.equal(sent[1].payload.stage, 'application-access')
  assert.equal(sent[1].payload.errorCode, 'app/profile-read-failed')
})

test('missing profile and application permission denial are audited', async () => {
  const { instance, sent } = client({ profileExists: false })
  await instance.loginWithCustomToken('private-token')
  await settle()
  assert.equal(sent[1].payload.errorCode, 'app/user-not-found')
  instance.logIn({ email: 'typed@example.com', password: 'secret' })
  await settle()
  instance.initUserMetaPermissions = async () => {}
  await instance.startUserMetaSync({})
  await settle()
  assert.equal(sent.at(-1).payload.errorCode, 'app/no-permissions')
  assert.equal(instance.user.loggedIn, false)
})


test('Microsoft account conflict records the SDK email without OAuth credentials', async () => {
  const failure = {
    code: 'auth/account-exists-with-different-credential',
    customData: {
      email: 'Attempted@Example.com',
      _tokenResponse: { oauthAccessToken: 'secret-access-token', oauthIdToken: 'secret-id-token' },
    },
  }
  const { instance, sent } = client({ failure })
  await instance.logInWithMicrosoft()
  await settle()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].payload.attemptedIdentifier, 'Attempted@Example.com')
  assert.equal(sent[0].payload.errorCode, failure.code)
  assert.equal(instance.user.logInError, true)
  assert.equal(JSON.stringify(sent).includes('secret-'), false)
  const { normalizeAttempt } = require('./loginAudit')
  const stored = normalizeAttempt(sent[0].payload, {}, new Date())
  assert.equal(stored.attemptedIdentifier, 'attempted@example.com')
  assert.equal(stored.authenticatedUid, null)
})

for (const email of [undefined, { unexpected: 'value' }]) {
  test(`Microsoft failure without a usable email remains blank (${typeof email})`, async () => {
    const { instance, sent } = client({ failure: { code: 'auth/popup-closed-by-user', customData: { email } } })
    await instance.logInWithMicrosoft()
    await settle()
    assert.equal(sent[0].payload.attemptedIdentifier, '')
    assert.equal(instance.user.logInError, true)
  })
}


test('Microsoft failure email survives client transport, collector transaction and Firestore readback', {
  skip: !process.env.LOGIN_AUDIT_FIRESTORE_SDK,
}, async () => {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:18089')
  const { Firestore } = require(process.env.LOGIN_AUDIT_FIRESTORE_SDK)
  const db = new Firestore({ projectId: 'demo-login-audit' })
  const { createLoginAuditHandlers } = require('./loginAudit')
  const handler = createLoginAuditHandlers({ db, HttpsError: Error })
  try {
    const failure = {
      code: 'auth/account-exists-with-different-credential',
      customData: { email: 'Microsoft.Attempt@Example.com', _tokenResponse: { oauthAccessToken: 'do-not-store-token' } },
    }
    const { instance, auditRequests } = client({
      failure,
      onAudit: data => handler.record({ data, rawRequest: { ip: '127.0.0.1' } }),
    })
    await instance.logInWithMicrosoft()
    await settle()
    assert.equal(auditRequests.length, 1)
    assert.deepEqual(await Promise.all(auditRequests), [{ recorded: true }])
    const snapshot = await db.collection('login-log').where('attemptedIdentifier', '==', 'microsoft.attempt@example.com').get()
    assert.equal(snapshot.size, 1)
    const record = snapshot.docs[0].data()
    assert.equal(record.method, 'microsoft')
    assert.equal(record.errorCode, failure.code)
    assert.equal(record.attemptedIdentifier, 'microsoft.attempt@example.com')
    assert.equal(record.authenticatedUid, null)
    assert.equal(record.outcome, 'failed')
    assert.equal(record.expiresAt.toMillis() - record.createdAt.toMillis(), 60 * 86400000)
    assert.equal(JSON.stringify(record).includes('do-not-store-token'), false)
    console.log('Firestore emulator readback:', JSON.stringify({ attemptedIdentifier: record.attemptedIdentifier, method: record.method, errorCode: record.errorCode, outcome: record.outcome }))
  } finally {
    await db.terminate()
  }
})
