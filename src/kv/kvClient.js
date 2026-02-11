// kvClient.js
const axios = require('axios')
const FormData = require('form-data')

const accountId = process.env.CF_ACCOUNT_ID
const namespaceId = process.env.CLOUDFLARE_NAMESPACE_ID
const apiKey = process.env.CLOUDFLARE_API_KEY

if (!accountId || !namespaceId || !apiKey) {
  console.warn('[kvClient] Missing CF env vars: CF_ACCOUNT_ID, CLOUDFLARE_NAMESPACE_ID, CLOUDFLARE_API_KEY')
}

const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`
const MAX_RETRIES = Number(process.env.KV_HTTP_MAX_RETRIES || 5)
const BASE_DELAY_MS = Number(process.env.KV_HTTP_BASE_DELAY_MS || 250)
const MAX_DELAY_MS = Number(process.env.KV_HTTP_MAX_DELAY_MS || 5000)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function parseRetryAfterMs(retryAfterHeader) {
  if (!retryAfterHeader)
    return 0
  const raw = Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader
  const asNumber = Number(raw)
  if (Number.isFinite(asNumber) && asNumber >= 0)
    return asNumber * 1000
  const asDate = Date.parse(String(raw))
  if (!Number.isNaN(asDate))
    return Math.max(0, asDate - Date.now())
  return 0
}

function shouldRetryError(err) {
  const status = Number(err?.response?.status || 0)
  if (status === 429 || status === 408)
    return true
  if (status >= 500 && status <= 599)
    return true
  if (!status && (err?.code || err?.message))
    return true
  return false
}

async function requestWithRetry(run, label = 'kv-request') {
  let attempt = 0
  for (;;) {
    try {
      return await run()
    }
    catch (err) {
      if (!shouldRetryError(err) || attempt >= MAX_RETRIES)
        throw err
      const retryAfterMs = parseRetryAfterMs(err?.response?.headers?.['retry-after'])
      const expo = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * (2 ** attempt))
      const jitter = Math.floor(Math.random() * 200)
      const delayMs = Math.max(retryAfterMs, expo + jitter)
      const status = err?.response?.status || 'network'
      console.warn(`[kvClient] retrying ${label} (attempt ${attempt + 1}/${MAX_RETRIES}, status ${status}) in ${delayMs}ms`)
      await sleep(delayMs)
      attempt += 1
    }
  }
}

function parseJsonIfNeeded(body) {
  if (body === null || body === undefined) {
    return null
  }
  if (typeof body === 'object') {
    return body
  }
  if (typeof body === 'string' && body.trim().length > 0) {
    try {
      return JSON.parse(body)
    }
    catch (e) {
      console.warn('[kvClient] Failed to parse JSON body:', body.slice(0, 200))
      return null
    }
  }
  return null
}

function withWriteParams(url, opts) {
  if (!opts) {
    return url
  }
  const u = new URL(url)
  if (opts.expiration_ttl != null) {
    u.searchParams.set('expiration_ttl', String(opts.expiration_ttl))
  }
  if (opts.expiration != null) {
    u.searchParams.set('expiration', String(opts.expiration))
  }
  return u.toString()
}

/**
 * put(key, value, opts?)
 * opts: { metadata?: object, expiration?: number, expiration_ttl?: number }
 */
async function put(key, value, opts = undefined) {
  const url0 = `${base}/values/${encodeURIComponent(key)}`
  const url = withWriteParams(url0, opts)
  const headers = { Authorization: `Bearer ${apiKey}` }

  if (opts && opts.metadata) {
    const form = new FormData()
    const val = value instanceof Buffer ? value : (typeof value === 'string' ? value : JSON.stringify(value))
    form.append('value', val)
    form.append('metadata', JSON.stringify(opts.metadata))
    const formHeaders = form.getHeaders()
    Object.assign(headers, formHeaders)
    const res = await requestWithRetry(() => axios.put(url, form, { headers }), `put:${key}`)
    if (res.status !== 200) {
      throw new Error(`KV put failed: ${res.status} ${res.statusText}`)
    }
    return
  }

  let data = value
  if (typeof value === 'object' && !(value instanceof Buffer)) {
    data = JSON.stringify(value)
    headers['Content-Type'] = 'application/json'
  }
  else {
    headers['Content-Type'] = 'text/plain'
  }

  const res = await requestWithRetry(() => axios.put(url, data, { headers }), `put:${key}`)
  if (res.status !== 200) {
    throw new Error(`KV put failed: ${res.status} ${res.statusText}`)
  }
}

async function putJson(key, obj, opts = undefined) {
  return put(key, JSON.stringify(obj), opts)
}

/**
 * Convenience for writing only metadata on an index key.
 * Stores a tiny value ('1') and attaches the real JSON to metadata.
 */
async function putIndexMeta(key, metadata, opts = undefined) {
  const meta = metadata && typeof metadata === 'object' ? metadata : {}
  return put(key, '1', { ...(opts || {}), metadata: meta })
}

async function get(key, type = 'text') {
  const url = `${base}/values/${encodeURIComponent(key)}`
  try {
    const res = await requestWithRetry(() => axios.get(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      responseType: 'text',
      transformResponse: [x => x],
    }), `get:${key}`)
    if (type === 'json') {
      return parseJsonIfNeeded(res.data)
    }
    return res.data
  }
  catch (err) {
    if (err?.response?.status === 404) {
      return null
    }
    throw new Error(`KV get failed for ${key}: ${err.message}`)
  }
}

async function del(key) {
  const url = `${base}/values/${encodeURIComponent(key)}`
  try {
    await requestWithRetry(
      () => axios.delete(url, { headers: { Authorization: `Bearer ${apiKey}` } }),
      `del:${key}`,
    )
  }
  catch (err) {
    if (err?.response?.status === 404)
      return
    throw err
  }
}

/**
 * List keys with optional prefix/limit/cursor.
 * Returns { result, success, errors, messages } where result[i] has { name, expiration, metadata }.
 */
async function listKeys({ prefix = '', limit = 1000, cursor = '' } = {}) {
  const u = new URL(`${base}/keys`)
  if (prefix) {
    u.searchParams.set('prefix', prefix)
  }
  if (limit != null) {
    u.searchParams.set('limit', String(limit))
  }
  if (cursor) {
    u.searchParams.set('cursor', cursor)
  }
  const res = await requestWithRetry(
    () => axios.get(u.toString(), { headers: { Authorization: `Bearer ${apiKey}` } }),
    `list:${prefix || 'all'}`,
  )
  return res.data
}

module.exports = { put, putJson, putIndexMeta, get, del, listKeys }
