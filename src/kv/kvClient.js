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
    const res = await axios.put(url, form, { headers })
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

  const res = await axios.put(url, data, { headers })
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
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      responseType: 'text',
      transformResponse: [x => x],
    })
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
  await Promise.allSettled([
    axios.delete(url, { headers: { Authorization: `Bearer ${apiKey}` } }),
  ])
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
  const res = await axios.get(u.toString(), { headers: { Authorization: `Bearer ${apiKey}` } })
  return res.data
}

module.exports = { put, putJson, putIndexMeta, get, del, listKeys }
