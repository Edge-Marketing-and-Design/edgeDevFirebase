// Requires firebase CLI, Java, and USER_SYNC_FIRESTORE_SDK pointing to the
// consumer's @google-cloud/firestore module. Uses a demo project only.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { spawnSync } = require('node:child_process')
async function main() {
  assert.ok(process.env.USER_SYNC_FIRESTORE_SDK, 'Set USER_SYNC_FIRESTORE_SDK to the installed Firestore SDK module.')
  await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(18089, '127.0.0.1', () => server.close(resolve))
  })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'user-sync-emulator-'))
  const quote = value => `'${value.replace(/'/g, "'\\''")}'`
  try {
    fs.copyFileSync(path.join(__dirname, '../src/firestore.rules'), path.join(directory, 'firestore.rules'))
    fs.writeFileSync(path.join(directory, 'firebase.json'), JSON.stringify({ firestore: { rules: 'firestore.rules' }, emulators: { firestore: { host: '127.0.0.1', port: 18089 }, ui: { enabled: false }, hub: { port: 18090 }, logging: { port: 18091 } } }))
    const command = `${quote(process.execPath)} --test ${quote(path.join(__dirname, '../src/userSync.test.js'))} ${quote(path.join(__dirname, '../src/userSync.integration.test.js'))}`
    const result = spawnSync('firebase', ['emulators:exec', '--only', 'firestore', '--project', 'demo-user-sync', command], { cwd: directory, stdio: 'inherit', env: { ...process.env, FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true' } })
    if (result.error) throw result.error
    assert.equal(result.status, 0, 'User sync emulator tests failed')
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
