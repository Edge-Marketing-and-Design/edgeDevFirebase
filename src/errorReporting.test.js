/* eslint-env node */
/* eslint-disable @typescript-eslint/no-var-requires */
const assert = require('node:assert/strict')
const { createHmac } = require('node:crypto')
const test = require('node:test')
const { wrapTriggerFactory } = require('./errorReporting')

const ENVIRONMENT_KEYS = [
  'GCLOUD_PROJECT',
  'EDGE_ERROR_INGEST_KEY',
  'K_SERVICE',
  'FUNCTION_REGION',
]

const restoreEnvironment = original => {
  for (const key of ENVIRONMENT_KEYS) {
    if (original[key] === undefined)
      delete process.env[key]
    else
      process.env[key] = original[key]
  }
}

test('reports a sanitized trigger failure and rethrows the original error', async () => {
  const originalFetch = global.fetch
  const originalEnvironment = Object.fromEntries(
    ENVIRONMENT_KEYS.map(key => [key, process.env[key]]),
  )
  const requests = []
  global.fetch = async (url, options) => {
    requests.push({ url, options })
    return { ok: true }
  }
  process.env.GCLOUD_PROJECT = 'test-project'
  process.env.EDGE_ERROR_INGEST_KEY = 'test-ingest-key'
  process.env.K_SERVICE = 'syncResources'
  process.env.FUNCTION_REGION = 'us-west1'

  try {
    const failure = new Error('Sync failed token=private-value user@example.com')
    failure.code = 'sync-failed'
    const triggerFactory = handler => handler
    const wrappedFactory = wrapTriggerFactory(triggerFactory, 'pubsub.message.published')
    const handler = wrappedFactory(async event => {
      assert.equal(event.data.privateValue, 'never-send-this')
      throw failure
    })

    await assert.rejects(
      () => handler({ id: 'event-123', data: { privateValue: 'never-send-this' } }),
      error => error === failure,
    )

    assert.equal(requests.length, 1)
    const request = requests[0]
    const payload = JSON.parse(request.options.body)
    assert.equal(payload.projectId, 'test-project')
    assert.equal(payload.functionName, 'syncResources')
    assert.equal(payload.triggerType, 'pubsub.message.published')
    assert.equal(payload.eventId, 'event-123')
    assert.equal(payload.error.message, 'Sync failed token=[redacted] [redacted-email]')
    assert.equal(request.options.body.includes('never-send-this'), false)

    const timestamp = request.options.headers['x-edge-timestamp']
    const expectedSignature = createHmac('sha256', 'test-ingest-key')
      .update(`${timestamp}.${request.options.body}`)
      .digest('base64url')
    assert.equal(request.options.headers['x-edge-signature'], expectedSignature)
  }
  finally {
    global.fetch = originalFetch
    restoreEnvironment(originalEnvironment)
  }
})

test('does not report when a project ingest key is not configured', async () => {
  const originalFetch = global.fetch
  const originalEnvironment = Object.fromEntries(
    ENVIRONMENT_KEYS.map(key => [key, process.env[key]]),
  )
  let fetchCalls = 0
  global.fetch = async () => {
    fetchCalls += 1
    return { ok: true }
  }
  process.env.GCLOUD_PROJECT = 'test-project'
  delete process.env.EDGE_ERROR_INGEST_KEY

  try {
    const triggerFactory = handler => handler
    const wrappedFactory = wrapTriggerFactory(triggerFactory, 'scheduler.schedule')
    const handler = wrappedFactory(async () => {
      throw new Error('Expected test failure')
    })
    await assert.rejects(() => handler({ id: 'event-456' }), /Expected test failure/)
    assert.equal(fetchCalls, 0)
  }
  finally {
    global.fetch = originalFetch
    restoreEnvironment(originalEnvironment)
  }
})
