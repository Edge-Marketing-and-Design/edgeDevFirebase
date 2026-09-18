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
function client({ failure, emulatorAuth, rejectAudit = false, profileExists = true, profileFailure = false } = {}) {
  const sent = []
  const dependencies = {
    './loginAudit': { createLoginAttempt },
    './errorReporting': { getBrowserErrorReporter: () => ({ captureCallableError() { throw new Error('Unexpected Monitor call') } }) },
    'vue': { reactive: value => value },
    'firebase/app': { initializeApp: () => ({}) },
    'firebase/auth': {
      initializeAuth: () => ({}), onAuthStateChanged() {}, connectAuthEmulator() {},
      signOut: async () => {},
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
        return { data: {} }
      },
    },
  }
  const { EdgeFirebase } = load('edgeFirebase.ts', dependencies)
  return { instance: new EdgeFirebase({ projectId: 'demo-test', emulatorAuth }, false, false), sent }
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
