/* eslint-env node */
/* eslint-disable @typescript-eslint/no-var-requires */
const { createHash } = require('node:crypto')
const RETENTION_MS = 60 * 24 * 60 * 60 * 1000
const messages = {
  'auth/invalid-credential': 'Invalid login credentials.',
  'auth/invalid-login-credentials': 'Invalid login credentials.',
  'auth/wrong-password': 'Incorrect password.',
  'auth/user-not-found': 'Account not found.',
  'auth/invalid-email': 'Invalid email address.',
  'auth/user-disabled': 'Account disabled.',
  'auth/too-many-requests': 'Too many login attempts. Try again later.',
  'auth/network-request-failed': 'Could not reach the authentication service.',
  'auth/popup-closed-by-user': 'Sign-in window closed.',
  'auth/popup-blocked': 'Sign-in window blocked.',
  'auth/cancelled-popup-request': 'Another sign-in window replaced this one.',
  'auth/invalid-action-code': 'Sign-in link is invalid or already used.',
  'auth/expired-action-code': 'Sign-in link expired.',
  'auth/missing-email-context': 'Email address is missing for this sign-in link.',
  'auth/invalid-custom-token': 'Invalid sign-in token.',
  'auth/custom-token-mismatch': 'Sign-in token belongs to a different project.',
  'auth/account-exists-with-different-credential': 'Account uses a different sign-in method.',
  'auth/operation-not-allowed': 'Sign-in method is not enabled.',
  'auth/invalid-verification-code': 'Invalid phone verification code.',
  'app/no-permissions': 'Signed in but has no application permissions.',
  'app/user-not-found': 'Signed in but the application user profile is missing.',
  'app/profile-read-failed': 'Could not load application permissions.',
}
const clean = (value, length) => typeof value === 'string'
  ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, length) : ''

function normalizeAttempt(data, request, now) {
  if (!data || !['password', 'microsoft', 'phone', 'custom-token', 'email-link'].includes(data.method)
    || !['success', 'failed'].includes(data.outcome)
    || !['authentication', 'application-access'].includes(data.stage)) return null
  const errorCode = data.outcome === 'success' ? ''
    : (/^(auth|app)\/[a-z-]{1,80}$/.test(data.errorCode) ? data.errorCode : 'auth/unknown')
  let site = ''
  try {
    const url = new URL(data.site)
    if (['http:', 'https:'].includes(url.protocol)) site = url.origin.slice(0, 250)
  } catch {}
  return {
    attemptedIdentifier: clean(data.attemptedIdentifier, 254).toLowerCase(),
    method: data.method,
    stage: data.stage,
    outcome: data.outcome,
    errorCode,
    // Do not accept arbitrary client error text, stacks, passwords or tokens.
    errorMessage: errorCode ? messages[errorCode] || 'Sign-in failed. See errorCode.' : '',
    site,
    authenticatedUid: request.auth?.uid || null,
    source: 'client-reported',
    environment: process.env.FUNCTIONS_EMULATOR === 'true' ? 'development' : 'production',
    createdAt: now,
    expiresAt: new Date(now.getTime() + RETENTION_MS),
  }
}

function createLoginAuditHandlers({ db, HttpsError, now = () => new Date() }) {
  return {
    async record(request) {
      if (process.env.EDGE_LOGIN_AUDIT === 'false') return { recorded: false }
      const time = now()
      const record = normalizeAttempt(request.data, request, time)
      if (!record) return { recorded: false }
      // Fixed per-IP and global counters bound writes across all function instances.
      // Never accept an IP supplied in callable data or keep the raw IP in records.
      const ip = request.rawRequest?.ip || 'unknown'
      const key = createHash('sha256').update(ip).digest('hex')
      const hour = Math.floor(time.getTime() / 3600000)
      const day = Math.floor(time.getTime() / 86400000)
      const ipRef = db.collection('login-log-limits').doc(key)
      const globalRef = db.collection('login-log-limits').doc('global')
      const logRef = db.collection('login-log').doc()
      return db.runTransaction(async tx => {
        const [ipDoc, globalDoc] = await Promise.all([tx.get(ipRef), tx.get(globalRef)])
        const ipCount = ipDoc.data()?.window === hour ? ipDoc.data().count : 0
        const globalCount = globalDoc.data()?.window === day ? globalDoc.data().count : 0
        if (ipCount >= 120 || globalCount >= 10000) return { recorded: false }
        const expiresAt = new Date(time.getTime() + 2 * 86400000)
        tx.set(ipRef, { window: hour, count: ipCount + 1, expiresAt })
        tx.set(globalRef, { window: day, count: globalCount + 1, expiresAt })
        tx.set(logRef, record)
        return { recorded: true }
      })
    },
    async list(request) {
      if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in required.')
      const user = await db.collection('users').doc(request.auth.uid).get()
      const roles = Object.values(user.data()?.roles || {})
      if (!roles.some(role => role?.collectionPath === '-' && role.role === 'admin'))
        throw new HttpsError('permission-denied', 'Root administrator required.')
      const identifier = clean(request.data?.attemptedIdentifier, 254).toLowerCase()
      let query = db.collection('login-log')
      if (identifier) query = query.where('attemptedIdentifier', '==', identifier)
      query = query.where('expiresAt', '>', now()).orderBy('expiresAt', 'desc')
      const snapshot = await query.limit(100).get()
      return { records: snapshot.docs.map(doc => {
        const data = doc.data()
        return { id: doc.id, ...data, createdAt: data.createdAt.toDate().toISOString(), expiresAt: data.expiresAt.toDate().toISOString() }
      }) }
    },
  }
}
module.exports = { createLoginAuditHandlers, normalizeAttempt, RETENTION_MS }
