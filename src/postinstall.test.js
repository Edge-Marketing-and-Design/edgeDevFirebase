/* eslint-env node */
/* eslint-disable @typescript-eslint/no-var-requires */
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')

const workerSource = 'module.exports = { kvMirrorRetryWorker: { edgeOwned: true } }\n'
const edgeBlock = `// START EXTRA EDGE functions
exports.kvMirrorRetryWorker = require('./kv/kvRetryWorker').kvMirrorRetryWorker
// END EXTRA EDGE functions
`

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'firebase-postinstall-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const packageDir = path.join(root, 'node_modules/@edgedev/firebase')
  fs.cpSync(__dirname, path.join(packageDir, 'src'), { recursive: true })
  const functionsDir = path.join(root, 'functions')
  const indexPath = path.join(functionsDir, 'index.js')
  return {
    functionsDir,
    indexPath,
    install() {
      execFileSync('bash', ['./src/postinstall.sh'], { cwd: packageDir, stdio: 'pipe' })
    },
    provisionKV() {
      fs.mkdirSync(path.join(functionsDir, 'kv'), { recursive: true })
      fs.writeFileSync(path.join(functionsDir, 'kv/kvRetryWorker.js'), workerSource)
      fs.writeFileSync(path.join(functionsDir, 'kv/kvMirror.js'), '// Edge mirror sentinel\n')
      fs.writeFileSync(path.join(functionsDir, 'kv/kvClient.js'), '// Edge client sentinel\n')
    },
    verify({ hasEdgeRegistration = true, hasKVFiles = true } = {}) {
      const source = fs.readFileSync(indexPath, 'utf8')
      assert.equal(source.split('// START @edge/firebase functions').length - 1, 1)
      const firebaseBlock = source.split('// START @edge/firebase functions')[1].split('// END @edge/firebase functions')[0]
      assert.doesNotMatch(firebaseBlock, /kvMirrorRetryWorker|\.\/kv\//)
      if (hasEdgeRegistration) {
        assert.ok(source.includes(edgeBlock))
        assert.equal(source.split('exports.kvMirrorRetryWorker').length - 1, 1)
      }
      if (hasKVFiles) {
        assert.equal(fs.readFileSync(path.join(functionsDir, 'kv/kvRetryWorker.js'), 'utf8'), workerSource)
        assert.equal(fs.readFileSync(path.join(functionsDir, 'kv/kvMirror.js'), 'utf8'), '// Edge mirror sentinel\n')
        assert.equal(fs.readFileSync(path.join(functionsDir, 'kv/kvClient.js'), 'utf8'), '// Edge client sentinel\n')
      }
      const worker = hasKVFiles ? require(path.join(functionsDir, 'kv/kvRetryWorker.js')).kvMirrorRetryWorker : undefined
      const edgeFirebase = {}
      const exports = {}
      vm.runInNewContext(source, {
        exports,
        process: { env: {} },
        require(id) {
          if (id === './kv/kvRetryWorker' && hasEdgeRegistration) return { kvMirrorRetryWorker: worker }
          if (id === './edgeFirebase') return edgeFirebase
          if (id === './cms') return {}
          if (id === 'dotenv') return { config() {} }
          throw new Error(`Unexpected consumer dependency: ${id}`)
        },
      })
      assert.equal(exports.kvMirrorRetryWorker, hasEdgeRegistration ? worker : undefined)
      assert.equal(exports.edgeFirebase, edgeFirebase)
      return exports
    },
  }
}

test('fresh installation neither supplies nor registers KV', (t) => {
  for (const file of ['kvClient.js', 'kvMirror.js', 'kvRetryWorker.js']) {
    assert.equal(fs.existsSync(path.join(__dirname, 'kv', file)), false)
  }
  const consumer = fixture(t)
  consumer.install()
  assert.equal(fs.existsSync(path.join(consumer.functionsDir, 'kv')), false)
  consumer.verify({ hasEdgeRegistration: false, hasKVFiles: false })
})

test('repeated upgrades replace the managed block and preserve Edge KV files and custom exports', (t) => {
  const consumer = fixture(t)
  consumer.provisionKV()
  fs.writeFileSync(consumer.indexPath, `exports.custom = true
// START @edge/firebase functions
const { kvMirrorRetryWorker } = require('./kv/kvRetryWorker')
exports.kvMirrorRetryWorker = kvMirrorRetryWorker
exports.edgeFirebase = require('./edgeFirebase')
// END @edge/firebase functions
${edgeBlock}`)
  for (let run = 0; run < 2; run++) {
    consumer.install()
    assert.equal(consumer.verify().custom, true)
  }
})

test('Edge registration added after a fresh installation survives subsequent installs', (t) => {
  const consumer = fixture(t)
  consumer.provisionKV()
  consumer.install()
  fs.appendFileSync(consumer.indexPath, `\n${edgeBlock}`)
  consumer.verify()
  consumer.install()
  consumer.verify()
  assert.ok(fs.readFileSync(consumer.indexPath, 'utf8').includes(edgeBlock))
})

test('upgrade removes legacy Firebase registration even without an Edge migration', (t) => {
  const consumer = fixture(t)
  consumer.provisionKV()
  fs.writeFileSync(consumer.indexPath, `// START @edge/firebase functions
const { kvMirrorRetryWorker } = require('./kv/kvRetryWorker')
exports.kvMirrorRetryWorker = kvMirrorRetryWorker
exports.edgeFirebase = require('./edgeFirebase')
// END @edge/firebase functions
`)
  consumer.install()
  consumer.verify({ hasEdgeRegistration: false })
})
