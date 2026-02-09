// kvMirror.js
// Generic Firestore→Cloudflare KV mirroring helper.
// - Writes a canonical KV key per Firestore doc (value = serialized data).
// - Optionally writes index keys that carry JSON in **metadata** (value = '1').
// - Index-key metadata always includes { canonical: <canonicalKey> }.
// - Keeps a small manifest per canonical key to clean up all index keys on delete.

const { onDocumentWritten } = require('../config.js')
const kv = require('./kvClient')

function json(x) {
  return JSON.stringify(x)
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
        const keys = Array.isArray(prev?.indexKeys) ? prev.indexKeys : []
        const deletions = [
          ...keys.map(k => kv.del(k)),
          kv.del(canonicalKey),
          kv.del(manifestKey),
        ]
        await Promise.allSettled(deletions)
      }
      else {
        await kv.del(canonicalKey)
      }
      return
    }

    const baseMeta = { canonical: canonicalKey }
    const customMetaCandidate = typeof makeMetadata === 'function' ? (makeMetadata(data, params) || null) : null
    const metaValue = (customMetaCandidate && typeof customMetaCandidate === 'object')
      ? { ...customMetaCandidate, canonical: canonicalKey }
      : baseMeta

    await kv.put(canonicalKey, serialize(data), { metadata: metaValue })

    if (!indexingEnabled) {
      return
    }

    const nextIndexKeys = (await Promise.resolve(makeIndexKeys(params, data)) || [])
      .filter(Boolean)
      .map(String)

    let prev = null
    try {
      prev = await kv.get(manifestKey, 'json')
    }
    catch (_) {
      prev = null
    }

    const oldIndexKeys = Array.isArray(prev?.indexKeys) ? prev.indexKeys : []
    const { toRemove } = setDiff(oldIndexKeys, nextIndexKeys)

    const upserts = nextIndexKeys.map(k => kv.putIndexMeta(k, metaValue))
    await Promise.allSettled(upserts)

    const removals = toRemove.map(k => kv.del(k))
    await Promise.allSettled(removals)

    await kv.put(manifestKey, { indexKeys: nextIndexKeys })
  })
}

function createKvMirrorHandlerFromFields({
  documentPath,
  uniqueKey,
  indexKeys = [],
  metadataKeys = [],
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
    for (const key of keys) {
      meta[key] = data?.[key] ?? ''
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
