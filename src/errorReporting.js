/* eslint-env node */
/* eslint-disable @typescript-eslint/no-var-requires, no-control-regex */
const { createHmac, randomUUID } = require('node:crypto')

const DEFAULT_INGEST_URL = 'https://ingest.monitor.edgemarketingdesign.com/v1/errors/server'
const REPORT_TIMEOUT_MS = 3000

const wrapTriggerFactory = (factory, triggerType) => (...args) => {
  const handlerIndex = findHandlerIndex(args)
  if (handlerIndex < 0)
    return factory(...args)

  const handler = args[handlerIndex]
  const wrappedHandler = async (...handlerArgs) => {
    try {
      return await handler(...handlerArgs)
    }
    catch (error) {
      await reportFirebaseFunctionError(error, {
        event: handlerArgs[0],
        fallbackFunctionName: handler.name,
        triggerType,
      })
      throw error
    }
  }
  const wrappedArgs = [...args]
  wrappedArgs[handlerIndex] = wrappedHandler
  return factory(...wrappedArgs)
}

const reportFirebaseFunctionError = async (error, context) => {
  const ingestKey = process.env.EDGE_ERROR_INGEST_KEY
  const projectId = firebaseProjectId()
  if (!ingestKey || !projectId || process.env.EDGE_ERROR_REPORTING === 'false')
    return false

  const functionName = safeIdentifier(
    process.env.K_SERVICE
      || process.env.FUNCTION_TARGET
      || context.fallbackFunctionName
      || 'unknown-function',
    160,
  ) || 'unknown-function'
  const normalized = normalizeError(error)
  const body = JSON.stringify({
    version: 1,
    projectId,
    runtime: 'firebase-function',
    environment: errorEnvironment(),
    functionName,
    triggerType: context.triggerType,
    region: safeIdentifier(
      process.env.FUNCTION_REGION
        || process.env.FIREBASE_STORE_REGION
        || process.env.FUNCTIONS_REGION
        || 'us-west1',
      80,
    ),
    eventId: eventId(context.event),
    occurredAt: new Date().toISOString(),
    handled: false,
    release: safeText(process.env.EDGE_RELEASE || process.env.K_REVISION, 160) || undefined,
    error: normalized,
  })
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = createHmac('sha256', ingestKey)
    .update(`${timestamp}.${body}`)
    .digest('base64url')

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS)
    try {
      const response = await fetch(process.env.EDGE_ERROR_INGEST_URL || DEFAULT_INGEST_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-edge-source-id': projectId,
          'x-edge-timestamp': String(timestamp),
          'x-edge-signature': signature,
        },
        body,
        signal: controller.signal,
      })
      return response.ok
    }
    finally {
      clearTimeout(timeout)
    }
  }
  catch {
    return false
  }
}

const findHandlerIndex = args => {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (typeof args[index] === 'function')
      return index
  }
  return -1
}

const firebaseProjectId = () => {
  const direct = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT
  if (direct)
    return safeIdentifier(direct, 120)
  try {
    const config = JSON.parse(process.env.FIREBASE_CONFIG || '{}')
    return safeIdentifier(config.projectId || config.project_id, 120)
  }
  catch {
    return ''
  }
}

const errorEnvironment = () => {
  if (process.env.EDGE_ERROR_ENVIRONMENT)
    return safeIdentifier(process.env.EDGE_ERROR_ENVIRONMENT, 40) || 'production'
  return process.env.FUNCTIONS_EMULATOR === 'true' ? 'development' : 'production'
}

const eventId = event => {
  const candidate = event?.id
    || event?.eventId
    || headerValue(event?.rawRequest?.headers, 'function-execution-id')
    || headerValue(event?.headers, 'function-execution-id')
    || headerValue(event?.headers, 'x-cloud-trace-context')
  return safeIdentifier(candidate, 160) || randomUUID()
}

const headerValue = (headers, name) => {
  if (!headers)
    return ''
  if (typeof headers.get === 'function')
    return headers.get(name) || ''
  return headers[name] || ''
}

const normalizeError = error => ({
  name: safeText(error?.name, 160) || 'Error',
  code: safeText(error?.code, 160) || undefined,
  message: safeText(error?.message, 1200) || 'Unknown Firebase Function error',
  stack: safeStack(error?.stack, 8000) || undefined,
})

const safeIdentifier = (value, maximum) => {
  if (typeof value !== 'string' || value.length > maximum)
    return ''
  const trimmed = value.trim()
  return /^[\w.:-]+$/.test(trimmed) ? trimmed : ''
}

const safeText = (value, maximum) => {
  if (typeof value !== 'string')
    return ''
  return redact(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum)
}

const safeStack = (value, maximum) => {
  if (typeof value !== 'string')
    return ''
  return redact(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .split(/\r?\n/)
    .map(line => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, maximum)
}

const redact = value => value
  .replace(/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted]')
  .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, '[redacted-email]')
  .replace(/\b(password|passwd|token|api[_-]?key|secret)=[^\s&]+/gi, '$1=[redacted]')

module.exports = {
  reportFirebaseFunctionError,
  wrapTriggerFactory,
}
