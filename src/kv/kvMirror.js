// kvMirror.js
// Generic Firestore→Cloudflare KV mirroring helper.
// - Writes a canonical KV key per Firestore doc (value = serialized data).
// - Optionally writes index keys that carry JSON in **metadata** (value = '1').
// - Index-key metadata always includes { canonical: <canonicalKey> }.
// - Keeps a small manifest per canonical key to clean up all index keys on delete.

const { onDocumentWritten, db, Firestore, logger } = require('../config.js')
const kv = require('./kvClient')

function json(x) {
  return JSON.stringify(x)
}

const KV_RETRY_TOPIC = process.env.KV_RETRY_TOPIC || 'kv-mirror-retry'
const INDEX_WRITE_CONCURRENCY = Number(process.env.KV_MIRROR_INDEX_CONCURRENCY || 20)

function toSortedUniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter(Boolean)
    .map(String))]
    .sort()
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function areSameStrings(a = [], b = []) {
  if (a.length !== b.length)
    return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i])
      return false
  }
  return true
}

function normalizeConcurrency(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1)
    return 1
  return Math.floor(n)
}

async function runWithConcurrency(items, limit, worker) {
  const values = Array.isArray(items) ? items : []
  if (!values.length)
    return
  const max = normalizeConcurrency(limit)
  let cursor = 0
  const workers = Array.from({ length: Math.min(max, values.length) }, async () => {
    for (;;) {
      const idx = cursor
      cursor += 1
      if (idx >= values.length)
        return
      await worker(values[idx], idx)
    }
  })
  await Promise.all(workers)
}

async function enqueueKvRetry(payload, minuteDelay = 1) {
  const safePayload = payload && typeof payload === 'object' ? payload : {}
  await db.collection('topic-queue').add({
    topic: KV_RETRY_TOPIC,
    payload: {
      ...safePayload,
      attempt: Number(safePayload.attempt || 0),
    },
    minuteDelay: Number(minuteDelay || 0),
    retry: 0,
    timestamp: Firestore.FieldValue.serverTimestamp(),
  })
}

async function safeKvOperation({
  run,
  payload,
  label,
}) {
  try {
    await run()
    return true
  }
  catch (err) {
    const message = String(err?.message || err || 'KV operation failed')
    logger.warn('KV operation failed; queued for retry', {
      label,
      error: message.slice(0, 500),
      key: payload?.key,
      op: payload?.op,
    })
    try {
      await enqueueKvRetry(payload)
    }
    catch (queueErr) {
      logger.error('Failed to enqueue KV retry', {
        label,
        key: payload?.key,
        op: payload?.op,
        error: String(queueErr?.message || queueErr || 'enqueue failed').slice(0, 500),
      })
    }
    return false
  }
}

function slugIndexValue(value, maxLength = 80) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
}

function setDiff(oldArr = [], newArr = []) {
  const A = new Set(oldArr)
  const B = new Set(newArr)
  const toRemove = [...A].filter(x => !B.has(x))
  const toAdd = [...B].filter(x => !A.has(x))
  return { toRemove, toAdd }
}

/**
 * createKvMirrorHandler({
 *   document: 'organizations/{orgId}/sites/{siteId}/published_posts/{postId}',
 *   makeCanonicalKey: (params, data) => `post:${params.orgId}:${params.siteId}:${params.postId}`,
 *   makeIndexKeys: (params, data) => [...],                  // optional
 *   makeMetadata: (data, params) => ({ title: data.title }), // optional, merged with { canonical }
 *   serialize: (data) => JSON.stringify(data),               // optional
 *   timeoutSeconds: 180                                      // optional
 * })
 */
function createKvMirrorHandler({
  document,
  makeCanonicalKey,
  makeIndexKeys,
  makeMetadata,
  serialize = json,
  timeoutSeconds = 180,
}) {
  return onDocumentWritten({ document, timeoutSeconds }, async (event) => {
    const after = event.data?.after
    const params = event.params || {}
    const data = after?.exists ? after.data() : null

    const canonicalKey = makeCanonicalKey(params, data)
    if (!canonicalKey) {
      logger.warn('KV mirror skipped due to missing canonical key', { document })
      return
    }
    const indexingEnabled = typeof makeIndexKeys === 'function'
    const manifestKey = indexingEnabled ? `idx:manifest:${canonicalKey}` : null

    if (!after?.exists) {
      if (indexingEnabled) {
        let prev = null
        try {
          prev = await kv.get(manifestKey, 'json')
        }
        catch (_) {
          prev = null
        }
        const keys = toSortedUniqueStrings([
          ...(Array.isArray(prev?.indexKeys) ? prev.indexKeys : []),
          canonicalKey,
          manifestKey,
        ])
        await runWithConcurrency(keys, INDEX_WRITE_CONCURRENCY, async (key) => {
          await safeKvOperation({
            run: () => kv.del(key),
            payload: { op: 'del', key, source: 'kvMirror' },
            label: `del:${key}`,
          })
        })
      }
      else {
        await safeKvOperation({
          run: () => kv.del(canonicalKey),
          payload: { op: 'del', key: canonicalKey, source: 'kvMirror' },
          label: `del:${canonicalKey}`,
        })
      }
      return
    }

    const baseMeta = { canonical: canonicalKey }
    const customMetaCandidate = typeof makeMetadata === 'function' ? (makeMetadata(data, params) || null) : null
    const metaValue = (customMetaCandidate && typeof customMetaCandidate === 'object')
      ? { ...customMetaCandidate, canonical: canonicalKey }
      : baseMeta

    const serializedData = serialize(data)
    await safeKvOperation({
      run: () => kv.put(canonicalKey, serializedData, { metadata: metaValue }),
      payload: {
        op: 'put',
        key: canonicalKey,
        value: serializedData,
        opts: { metadata: metaValue },
        source: 'kvMirror',
      },
      label: `put:${canonicalKey}`,
    })

    if (!indexingEnabled) {
      return
    }

    const resolvedIndexKeys = await Promise.resolve(makeIndexKeys(params, data))
    const nextIndexKeys = toSortedUniqueStrings(resolvedIndexKeys || [])

    let prev = null
    try {
      prev = await kv.get(manifestKey, 'json')
    }
    catch (_) {
      prev = null
    }

    const oldIndexKeys = toSortedUniqueStrings(Array.isArray(prev?.indexKeys) ? prev.indexKeys : [])
    const previousMetaHash = typeof prev?.metadataHash === 'string' ? prev.metadataHash : ''
    const currentMetaHash = stableStringify(metaValue)
    const { toRemove, toAdd } = setDiff(oldIndexKeys, nextIndexKeys)
    const shouldRewriteAllIndexKeys = previousMetaHash !== currentMetaHash
    const keysToUpsert = shouldRewriteAllIndexKeys ? nextIndexKeys : toAdd

    await runWithConcurrency(keysToUpsert, INDEX_WRITE_CONCURRENCY, async (key) => {
      await safeKvOperation({
        run: () => kv.putIndexMeta(key, metaValue),
        payload: {
          op: 'putIndexMeta',
          key,
          metadata: metaValue,
          source: 'kvMirror',
        },
        label: `putIndexMeta:${key}`,
      })
    })

    await runWithConcurrency(toRemove, INDEX_WRITE_CONCURRENCY, async (key) => {
      await safeKvOperation({
        run: () => kv.del(key),
        payload: { op: 'del', key, source: 'kvMirror' },
        label: `del:${key}`,
      })
    })

    const manifestUnchanged = areSameStrings(oldIndexKeys, nextIndexKeys)
      && previousMetaHash === currentMetaHash
    if (!manifestUnchanged) {
      const manifestValue = { indexKeys: nextIndexKeys, metadataHash: currentMetaHash }
      await safeKvOperation({
        run: () => kv.put(manifestKey, manifestValue),
        payload: {
          op: 'put',
          key: manifestKey,
          value: manifestValue,
          source: 'kvMirror',
        },
        label: `put:${manifestKey}`,
      })
    }
  })
}

function createKvMirrorHandlerFromFields({
  documentPath,
  uniqueKey,
  indexKeys = [],
  metadataKeys = [],
  metaKeyTruncate = {},
  serialize = json,
}) {
  if (!uniqueKey || typeof uniqueKey !== 'string') {
    throw new Error('createKvMirrorHandlerFromFields requires uniqueKey (e.g. "{orgId}:{siteId}")')
  }
  const docIdParam = 'docId'
  const basePath = documentPath || ''
  const document = basePath.includes(`{${docIdParam}}`) ? basePath : `${basePath}/{${docIdParam}}`
  const collection = String(basePath || '')
    .replace(new RegExp(`/{${docIdParam}}$`), '')
    .split('/')
    .filter(Boolean)
    .pop()

  const resolveUniqueKey = (params) => {
    const template = String(uniqueKey || '').trim()
    if (!template)
      return ''
    const tokens = template.match(/\{[^}]+\}/g) || []
    let missing = false
    const value = template.replace(/\{([^}]+)\}/g, (_, key) => {
      const resolved = params?.[key]
      if (resolved === undefined || resolved === null || resolved === '') {
        missing = true
        return ''
      }
      return String(resolved)
    })
    if (missing)
      return ''
    if (tokens.length === 0)
      return value
    return value
  }

  const makeCanonicalKey = (params) => {
    const resolvedKey = resolveUniqueKey(params)
    const docId = params?.[docIdParam]
    if (!collection || !docId || !resolvedKey)
      return ''
    return `${collection}:${resolvedKey}:${docId}`
  }

  const makeIndexKeys = (params, data) => {
    const docId = params?.[docIdParam]
    const resolvedKey = resolveUniqueKey(params)

    if (!collection || !docId || !resolvedKey)
      return []

    const keys = []
    const fields = Array.isArray(indexKeys) ? indexKeys : []
    for (const field of fields) {
      if (!field || typeof field !== 'string')
        continue
      const rawValue = data?.[field]
      const values = Array.isArray(rawValue) ? rawValue : [rawValue]
      for (const value of values) {
        if (value === undefined || value === null || value === '')
          continue
        const slug = slugIndexValue(value)
        if (!slug)
          continue
        keys.push(`idx:${collection}:${field}:${resolvedKey}:${slug}:${docId}`)
      }
    }
    return keys
  }

  const makeMetadata = (data) => {
    const meta = {}
    const keys = Array.isArray(metadataKeys) ? metadataKeys : []
    const truncateMap = metaKeyTruncate && typeof metaKeyTruncate === 'object'
      ? metaKeyTruncate
      : {}
    for (const key of keys) {
      const raw = data?.[key] ?? ''
      const truncateLength = Number(truncateMap?.[key])
      if (Number.isFinite(truncateLength) && truncateLength >= 0 && typeof raw === 'string') {
        meta[key] = raw.slice(0, Math.floor(truncateLength))
      }
      else {
        meta[key] = raw
      }
    }
    return meta
  }

  return createKvMirrorHandler({
    document,
    makeCanonicalKey,
    makeIndexKeys: indexKeys.length ? makeIndexKeys : undefined,
    makeMetadata: metadataKeys.length ? makeMetadata : undefined,
    serialize,
    timeoutSeconds: 180,
  })
}

module.exports = { createKvMirrorHandler, createKvMirrorHandlerFromFields }
