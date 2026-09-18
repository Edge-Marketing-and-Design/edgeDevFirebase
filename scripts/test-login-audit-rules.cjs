// Run only through the Firestore emulator; never connects to a real project.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const net = require('node:net')
const project = 'demo-login-audit'
const port = 18089

async function checks() {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, `127.0.0.1:${port}`)
  const base = `http://127.0.0.1:${port}/v1/projects/${project}/databases/(default)/documents`
  const encode = value => {
    if (typeof value === 'string') return { stringValue: value }
    return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, value]) => [key, encode(value)])) } }
  }
  const put = async (name, data, token = 'owner') => fetch(`${base}/${name}`, {
    method: 'PATCH', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, encode(value)])) }),
  })
  const payload = { sub: 'root-admin', user_id: 'root-admin', aud: project, iss: `https://securetoken.google.com/${project}`, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, firebase: { sign_in_provider: 'custom' } }
  const token = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.`
  assert.equal((await put('users/root-admin', { roles: { '-': { collectionPath: '-', role: 'admin' } } })).status, 200)
  const helper = Object.fromEntries(['login-log', 'login-log-entry', 'login-log-limits', 'login-log-limits-entry'].map(key => [key, { permissionCheckPath: '-' }]))
  assert.equal((await put('rule-helpers/root-admin', helper)).status, 200)
  for (const collection of ['login-log', 'login-log-limits']) {
    assert.equal((await put(`${collection}/entry`, { uid: 'root-admin' })).status, 200)
    for (const auth of ['', token]) {
      const headers = auth ? { Authorization: `Bearer ${auth}` } : {}
      for (const suffix of [`${collection}/entry`, collection]) {
        assert.equal((await fetch(`${base}/${suffix}`, { headers })).status, 403, `Direct read denied: ${suffix}`)
      }
      assert.equal((await put(`${collection}/new`, { uid: 'root-admin' }, auth)).status, 403)
      assert.equal((await put(`${collection}/entry`, { uid: 'root-admin' }, auth)).status, 403)
      assert.equal((await fetch(`${base}/${collection}/entry`, { method: 'DELETE', headers })).status, 403)
    }
    assert.equal((await put(`${collection}/entry/nested/new`, { uid: 'root-admin' }, token)).status, 403)
  }
  console.log('Login audit rules verified: direct reads, lists, writes, deletes and nested writes denied, including root-admin bypass attempts.')
}

async function main() {
  if (process.argv.includes('--check')) return checks()
  // Fail rather than interrupt or duplicate an existing emulator.
  await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => server.close(resolve))
  })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'login-audit-rules-'))
  try {
    fs.copyFileSync(path.join(__dirname, '../src/firestore.rules'), path.join(directory, 'firestore.rules'))
    fs.writeFileSync(path.join(directory, 'firebase.json'), JSON.stringify({ firestore: { rules: 'firestore.rules' }, emulators: { firestore: { host: '127.0.0.1', port }, ui: { enabled: false }, hub: { port: 18090 }, logging: { port: 18091 } } }))
    const quote = value => `'${value.replace(/'/g, "'\\''")}'`
    const result = spawnSync('firebase', ['emulators:exec', '--only', 'firestore', '--project', project, `${quote(process.execPath)} ${quote(__filename)} --check`], { cwd: directory, stdio: 'inherit', env: { ...process.env, FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true' } })
    if (result.error) throw result.error
    assert.equal(result.status, 0, 'Firestore emulator checks failed')
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
