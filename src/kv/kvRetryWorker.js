const { onMessagePublished, db, Firestore, logger } = require('../config.js')
const kv = require('./kvClient')

const KV_RETRY_TOPIC = process.env.KV_RETRY_TOPIC || 'kv-mirror-retry'
const KV_RETRY_MAX_ATTEMPTS = Number(process.env.KV_RETRY_MAX_ATTEMPTS || 8)
const KV_RETRY_BASE_MIN_DELAY = Number(process.env.KV_RETRY_BASE_MIN_DELAY || 1)
const KV_RETRY_MAX_MIN_DELAY = Number(process.env.KV_RETRY_MAX_MIN_DELAY || 60)

function toPositiveInt(value, fallback = 1) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1)
    return fallback
  return Math.floor(n)
}

function parseTopicPayload(event) {
  const message = event?.data?.message || {}
  if (message.json && typeof message.json === 'object')
    return message.json
  if (message.data) {
    try {
      const text = Buffer.from(message.data, 'base64').toString('utf8')
      const parsed = JSON.parse(text)
      return parsed && typeof parsed === 'object' ? parsed : {}
    }
    catch (_) {
      return {}
    }
  }
  return {}
}

function computeRetryDelayMinutes(attempt) {
  const safeAttempt = toPositiveInt(attempt, 1)
  const base = toPositiveInt(KV_RETRY_BASE_MIN_DELAY, 1)
  const max = toPositiveInt(KV_RETRY_MAX_MIN_DELAY, 60)
  return Math.min(max, base * (2 ** Math.max(0, safeAttempt - 1)))
}

async function enqueueKvRetry(payload, minuteDelay = 0) {
  await db.collection('topic-queue').add({
    topic: KV_RETRY_TOPIC,
    payload,
    minuteDelay: Number(minuteDelay || 0),
    retry: 0,
    timestamp: Firestore.FieldValue.serverTimestamp(),
  })
}

async function runKvOperation(payload) {
  const op = String(payload?.op || '')
  const key = String(payload?.key || '')
  if (!op || !key)
    throw new Error('Invalid KV retry payload: missing op/key')

  if (op === 'put')
    return kv.put(key, payload.value, payload.opts)
  if (op === 'putIndexMeta')
    return kv.putIndexMeta(key, payload.metadata, payload.opts)
  if (op === 'del')
    return kv.del(key)

  throw new Error(`Unsupported KV retry operation: ${op}`)
}

const kvMirrorRetryWorker = onMessagePublished(
  {
    topic: KV_RETRY_TOPIC,
    retry: false,
    timeoutSeconds: 180,
    memory: '512MiB',
    concurrency: 20,
  },
  async (event) => {
    const payload = parseTopicPayload(event)
    const op = String(payload?.op || '')
    const key = String(payload?.key || '')
    const attempt = Number(payload?.attempt || 0)

    if (!op || !key) {
      logger.warn('KV retry worker received invalid payload', { payload })
      return
    }

    try {
      await runKvOperation(payload)
    }
    catch (err) {
      const nextAttempt = attempt + 1
      const maxAttempts = toPositiveInt(KV_RETRY_MAX_ATTEMPTS, 8)
      const errorMessage = String(err?.message || err || 'KV retry failed')

      if (nextAttempt > maxAttempts) {
        logger.error('KV retry exhausted max attempts', { op, key, attempt: nextAttempt, error: errorMessage.slice(0, 500) })
        try {
          await db.collection('kv-retry-dead').add({
            topic: KV_RETRY_TOPIC,
            payload: {
              ...payload,
              attempt: nextAttempt,
            },
            error: errorMessage.slice(0, 1000),
            timestamp: Firestore.FieldValue.serverTimestamp(),
          })
        }
        catch (deadErr) {
          logger.error('KV retry dead-letter write failed', {
            op,
            key,
            attempt: nextAttempt,
            error: String(deadErr?.message || deadErr || 'dead-letter write failed').slice(0, 500),
          })
        }
        return
      }

      const minuteDelay = computeRetryDelayMinutes(nextAttempt)
      try {
        await enqueueKvRetry({
          ...payload,
          attempt: nextAttempt,
        }, minuteDelay)
        logger.warn('KV retry requeued', { op, key, attempt: nextAttempt, minuteDelay, error: errorMessage.slice(0, 500) })
      }
      catch (queueErr) {
        logger.error('KV retry requeue write failed', {
          op,
          key,
          attempt: nextAttempt,
          minuteDelay,
          error: String(queueErr?.message || queueErr || 'requeue write failed').slice(0, 500),
        })
      }
    }
  },
)

module.exports = { kvMirrorRetryWorker }
