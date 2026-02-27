const axios = require('axios')
const {
  logger,
  admin,
  db,
  pubsub,
  onCall,
  HttpsError,
  onDocumentUpdated,
  onDocumentWritten,
  onDocumentDeleted,
  onDocumentCreated,
  onMessagePublished,
  onRequest,
  Firestore,
  permissionCheck,
} = require('./config.js')

const { createKvMirrorHandler } = require('./kv/kvMirror')

const SITE_AI_TOPIC = 'site-ai-bootstrap'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'
const HISTORY_API_KEY = process.env.HISTORY_API_KEY || ''
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || ''
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || ''
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || ''
const CLOUDFLARE_PAGES_API_TOKEN = process.env.CLOUDFLARE_PAGES_API_TOKEN || ''
const CLOUDFLARE_PAGES_PROJECT = process.env.CLOUDFLARE_PAGES_PROJECT || ''
const DOMAIN_REGISTRY_COLLECTION = 'domain-registry'

const SITE_STRUCTURED_DATA_TEMPLATE = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  '@id': '{{cms-site}}#website',
  'name': '',
  'url': '{{cms-site}}',
  'description': '',
  'publisher': {
    '@type': 'Organization',
    'name': '',
    'logo': {
      '@type': 'ImageObject',
      'url': '{{cms-logo}}',
    },
  },
  'sameAs': [],
}, null, 2)

const PAGE_STRUCTURED_DATA_TEMPLATE = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  '@id': '{{cms-site}}#webpage',
  'name': '',
  'url': '{{cms-url}}',
  'description': '',
  'isPartOf': {
    '@id': '{{cms-site}}#website',
  },
}, null, 2)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const allowCors = (req, res) => {
  res.set('Access-Control-Allow-Origin', '*')
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key')
  if (req.method === 'OPTIONS') {
    res.status(204).send('')
    return true
  }
  return false
}

const parseBody = (req) => {
  if (!req?.body)
    return null
  if (typeof req.body === 'object')
    return req.body
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body)
    }
    catch {
      return null
    }
  }
  return null
}

const getForwardedFor = (req) => {
  const forwarded = req.headers['x-forwarded-for']
  if (!forwarded)
    return ''
  if (Array.isArray(forwarded))
    return forwarded.join(', ')
  return String(forwarded)
}

const getClientIp = (req) => {
  const forwarded = getForwardedFor(req)
  if (forwarded)
    return forwarded.split(',')[0].trim()
  return req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || ''
}

const parseBrowser = (ua) => {
  if (!ua)
    return ''
  if (/Edg\//i.test(ua))
    return 'Edge'
  if (/OPR\//i.test(ua))
    return 'Opera'
  if (/Chrome\//i.test(ua))
    return 'Chrome'
  if (/Firefox\//i.test(ua))
    return 'Firefox'
  if (/Safari\//i.test(ua) && /Version\//i.test(ua))
    return 'Safari'
  return 'Other'
}

const parseOs = (ua) => {
  if (!ua)
    return ''
  if (/Windows NT/i.test(ua))
    return 'Windows'
  if (/Mac OS X/i.test(ua))
    return 'macOS'
  if (/Android/i.test(ua))
    return 'Android'
  if (/iPhone|iPad|iPod/i.test(ua))
    return 'iOS'
  if (/Linux/i.test(ua))
    return 'Linux'
  return 'Other'
}

const SITE_USER_META_FIELDS = [
  'contactEmail',
  'contactPhone',
  'socialFacebook',
  'socialInstagram',
  'socialTwitter',
  'socialLinkedIn',
  'socialYouTube',
  'socialTikTok',
]

const pickSyncFields = (source = {}) => {
  const payload = {}
  for (const field of SITE_USER_META_FIELDS) {
    payload[field] = source?.[field] ?? ''
  }
  return payload
}

const buildUpdateDiff = (current = {}, next = {}) => {
  const update = {}
  for (const [key, value] of Object.entries(next)) {
    if (current?.[key] !== value) {
      update[key] = value
    }
  }
  return update
}

const resolveStagedUserRef = async (userIdOrDocId) => {
  if (!userIdOrDocId)
    return null

  const byDocRef = db.collection('staged-users').doc(userIdOrDocId)
  const byDocSnap = await byDocRef.get()
  if (byDocSnap.exists)
    return byDocRef

  const querySnap = await db.collection('staged-users')
    .where('userId', '==', userIdOrDocId)
    .limit(1)
    .get()

  if (querySnap.empty)
    return null

  return querySnap.docs[0].ref
}

const parseDevice = (ua, headers) => {
  const mobileHint = headers['sec-ch-ua-mobile']
  if (mobileHint === '?1')
    return 'mobile'
  if (mobileHint === '?0')
    return 'desktop'
  if (/Mobile|Android|iPhone|iPad|iPod/i.test(ua || ''))
    return 'mobile'
  return 'desktop'
}

const getOrgIdFromPath = (path) => {
  const trimmed = String(path || '').split('?')[0]
  const parts = trimmed.split('/').filter(Boolean)
  if (parts[0] !== 'api' || parts[1] !== 'history')
    return ''
  return parts[2] || ''
}

const getApiKey = (req) => {
  const headers = req.headers || {}
  const headerKey = String(headers['x-api-key'] || '').trim()
  const authHeader = String(headers.authorization || '').trim()
  if (authHeader.toLowerCase().startsWith('bearer '))
    return authHeader.slice(7).trim()
  return headerKey
}

const normalizeEmail = (value) => {
  if (!value)
    return ''
  const trimmed = String(value).trim()
  return trimmed.includes('@') ? trimmed : ''
}

const normalizeDomain = (value) => {
  if (!value)
    return ''
  let normalized = String(value).trim().toLowerCase()
  if (!normalized)
    return ''
  if (normalized.includes('://')) {
    try {
      normalized = new URL(normalized).host
    }
    catch {
      normalized = normalized.split('://').pop() || normalized
    }
  }
  normalized = normalized.split('/')[0] || ''
  if (normalized.startsWith('[')) {
    const closingIndex = normalized.indexOf(']')
    if (closingIndex !== -1)
      normalized = normalized.slice(0, closingIndex + 1)
  }
  if (normalized.includes(':') && !normalized.startsWith('[')) {
    normalized = normalized.split(':')[0] || ''
  }
  return normalized.replace(/\.+$/g, '')
}

const stripIpv6Brackets = (value) => {
  const text = String(value || '').trim()
  if (text.startsWith('[') && text.endsWith(']'))
    return text.slice(1, -1)
  return text
}

const isIpv4Address = (value) => {
  const parts = String(value || '').split('.')
  if (parts.length !== 4)
    return false
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part))
      return false
    const num = Number(part)
    return num >= 0 && num <= 255
  })
}

const isIpv6Address = (value) => {
  const normalized = String(value || '').toLowerCase()
  if (!normalized.includes(':'))
    return false
  return /^[0-9a-f:]+$/.test(normalized)
}

const isIpAddress = (value) => {
  if (!value)
    return false
  const normalized = stripIpv6Brackets(value)
  return isIpv4Address(normalized) || isIpv6Address(normalized)
}

const getCloudflareApexDomain = (domain) => {
  if (!domain)
    return ''
  if (domain.startsWith('www.'))
    return domain.slice(4)
  return domain
}

const shouldDisplayDomainDnsRecords = (domain) => {
  const normalizedDomain = normalizeDomain(domain)
  const apexDomain = getCloudflareApexDomain(normalizedDomain)
  if (!apexDomain)
    return false
  if (apexDomain === 'localhost' || apexDomain.endsWith('.localhost'))
    return false
  if (isIpAddress(apexDomain))
    return false
  if (apexDomain.endsWith('.dev'))
    return false
  return true
}

const shouldSyncCloudflareDomain = (domain) => {
  if (!domain)
    return false
  if (!shouldDisplayDomainDnsRecords(domain))
    return false
  if (CLOUDFLARE_PAGES_PROJECT) {
    const pagesDomain = `${CLOUDFLARE_PAGES_PROJECT}.pages.dev`
    if (domain === pagesDomain || domain === `www.${pagesDomain}`)
      return false
  }
  return true
}

const getCloudflarePagesDomain = (domain) => {
  if (!domain)
    return ''
  if (domain.startsWith('www.'))
    return domain
  return `www.${domain}`
}

const getCloudflarePagesTarget = () => {
  if (!CLOUDFLARE_PAGES_PROJECT)
    return ''
  return `${CLOUDFLARE_PAGES_PROJECT}.pages.dev`
}

const buildDomainDnsPayload = (domain, pagesTarget = '') => {
  const normalizedDomain = normalizeDomain(domain)
  const apexDomain = getCloudflareApexDomain(normalizedDomain)
  const wwwDomain = getCloudflarePagesDomain(apexDomain)
  const target = pagesTarget || getCloudflarePagesTarget()
  const dnsEligible = shouldDisplayDomainDnsRecords(apexDomain)

  return {
    domain: normalizedDomain,
    apexDomain,
    wwwDomain,
    dnsEligible,
    dnsRecords: {
      target,
      www: {
        type: 'CNAME',
        name: 'www',
        host: wwwDomain,
        value: target,
        enabled: dnsEligible && !!target,
      },
      apex: {
        type: 'CNAME',
        name: '@',
        host: apexDomain,
        value: target,
        enabled: dnsEligible && !!target,
      },
    },
  }
}

const isCloudflareDomainAlreadyExistsError = (status, errors = [], message = '') => {
  if (status === 409)
    return true
  const errorMessages = errors.map(err => String(err?.message || '').toLowerCase())
  if (errorMessages.some(text => text.includes('already exists')))
    return true
  if (errorMessages.some(text => text.includes('already added')))
    return true
  const lowerMessage = String(message || '').toLowerCase()
  return lowerMessage.includes('already exists') || lowerMessage.includes('already added')
}

const addCloudflarePagesDomain = async (domain, context = {}) => {
  if (!CF_ACCOUNT_ID || !CLOUDFLARE_PAGES_API_TOKEN || !CLOUDFLARE_PAGES_PROJECT) {
    logger.warn('Cloudflare Pages domain sync skipped: missing env vars', {
      domain,
      missingAccount: !CF_ACCOUNT_ID,
      missingToken: !CLOUDFLARE_PAGES_API_TOKEN,
      missingProject: !CLOUDFLARE_PAGES_PROJECT,
      ...context,
    })
    return { ok: false, error: 'Cloudflare Pages env vars missing.' }
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/pages/projects/${CLOUDFLARE_PAGES_PROJECT}/domains`
  try {
    const response = await axios.post(url, { name: domain }, {
      headers: {
        'Authorization': `Bearer ${CLOUDFLARE_PAGES_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    })
    if (response?.data?.success) {
      logger.log('Cloudflare Pages domain added', { domain, ...context })
      return { ok: true }
    }
    logger.warn('Cloudflare Pages domain add response not successful', {
      domain,
      errors: response?.data?.errors || [],
      ...context,
    })
    return { ok: false, error: 'Cloudflare Pages domain add response not successful.' }
  }
  catch (error) {
    const status = error?.response?.status || 0
    const errors = error?.response?.data?.errors || []
    const message = error?.message || 'Unknown error'
    const alreadyExists = isCloudflareDomainAlreadyExistsError(status, errors, message)
    if (alreadyExists) {
      logger.log('Cloudflare Pages domain already exists', { domain, ...context })
      return { ok: true }
    }
    logger.error('Cloudflare Pages domain add error', { domain, status, errors, message, ...context })
    const errorMessage = errors.length
      ? errors.map(err => err?.message).filter(Boolean).join('; ')
      : message
    return { ok: false, error: errorMessage || 'Cloudflare Pages domain add error.' }
  }
}

const removeCloudflarePagesDomain = async (domain, context = {}) => {
  if (!CF_ACCOUNT_ID || !CLOUDFLARE_PAGES_API_TOKEN || !CLOUDFLARE_PAGES_PROJECT) {
    logger.warn('Cloudflare Pages domain removal skipped: missing env vars', {
      domain,
      missingAccount: !CF_ACCOUNT_ID,
      missingToken: !CLOUDFLARE_PAGES_API_TOKEN,
      missingProject: !CLOUDFLARE_PAGES_PROJECT,
      ...context,
    })
    return { ok: false, error: 'Cloudflare Pages env vars missing.' }
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/pages/projects/${CLOUDFLARE_PAGES_PROJECT}/domains/${domain}`
  try {
    const response = await axios.delete(url, {
      headers: {
        'Authorization': `Bearer ${CLOUDFLARE_PAGES_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    })
    if (response?.data?.success) {
      logger.log('Cloudflare Pages domain removed', { domain, ...context })
      return { ok: true }
    }
    logger.warn('Cloudflare Pages domain removal response not successful', {
      domain,
      errors: response?.data?.errors || [],
      ...context,
    })
    return { ok: false, error: 'Cloudflare Pages domain removal response not successful.' }
  }
  catch (error) {
    const status = error?.response?.status || 0
    const errors = error?.response?.data?.errors || []
    const message = error?.message || 'Unknown error'
    const alreadyMissing = status === 404
      || errors.some(err => String(err?.message || '').toLowerCase().includes('not found'))
    if (alreadyMissing) {
      logger.log('Cloudflare Pages domain already removed', { domain, ...context })
      return { ok: true }
    }
    logger.error('Cloudflare Pages domain removal error', { domain, status, errors, message, ...context })
    const errorMessage = errors.length
      ? errors.map(err => err?.message).filter(Boolean).join('; ')
      : message
    return { ok: false, error: errorMessage || 'Cloudflare Pages domain removal error.' }
  }
}

const collectFormEntries = (data) => {
  if (!data || typeof data !== 'object')
    return []

  const entries = []
  const seen = new Set()
  const ignore = new Set(['orgId', 'siteId', 'pageId', 'blockId'])

  const addEntry = (key, value) => {
    if (!key)
      return
    const normalizedKey = String(key).trim()
    if (!normalizedKey)
      return
    const lowerKey = normalizedKey.toLowerCase()
    if (ignore.has(normalizedKey) || ignore.has(lowerKey))
      return
    if (value === undefined || value === null || value === '')
      return
    if (seen.has(lowerKey))
      return
    entries.push({ key: normalizedKey, value })
    seen.add(lowerKey)
  }

  const addArrayFields = (fields) => {
    if (!Array.isArray(fields))
      return
    for (const field of fields) {
      if (!field)
        continue
      const name = field.field || field.name || field.fieldName || field.label || field.title
      const value = field.value ?? field.fieldValue ?? field.val
      addEntry(name, value)
    }
  }

  addArrayFields(data.fields)
  addArrayFields(data.formFields)
  addArrayFields(data.formData)

  if (data.fields && typeof data.fields === 'object' && !Array.isArray(data.fields)) {
    for (const [key, value] of Object.entries(data.fields)) {
      addEntry(key, value)
    }
  }

  for (const [key, value] of Object.entries(data)) {
    if (key === 'fields' || key === 'formFields' || key === 'formData')
      continue
    addEntry(key, value)
  }

  return entries
}

const getReplyToEmail = (data, entries) => {
  if (data && typeof data === 'object') {
    const directKey = Object.keys(data).find(key => key.toLowerCase() === 'email')
    if (directKey) {
      const direct = normalizeEmail(data[directKey])
      if (direct)
        return direct
    }
  }

  const entry = entries.find(item => item.key.toLowerCase() === 'email')
  return normalizeEmail(entry?.value)
}

const escapeHtml = (value) => {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const formatValue = (value) => {
  if (value === undefined || value === null)
    return ''
  if (typeof value === 'string')
    return value
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  try {
    return JSON.stringify(value, null, 2)
  }
  catch {
    return String(value)
  }
}

const getPublishedEmailTo = async (orgId, siteId, pageId, blockId) => {
  if (!orgId || !siteId || !pageId || !blockId)
    return ''
  const publishedRef = db.collection('organizations').doc(orgId).collection('sites').doc(siteId).collection('published').doc(pageId)
  const snap = await publishedRef.get()
  if (!snap.exists)
    return ''
  const data = snap.data() || {}
  const content = Array.isArray(data.content) ? data.content : []
  const block = content.find(item => String(item?.id || '') === blockId || String(item?.blockId || '') === blockId)
  if (!block)
    return ''
  const emailTo = block?.values?.emailTo || block?.emailTo || ''
  return String(emailTo || '').trim()
}

const getSiteSettingsEmail = async (orgId, siteId) => {
  if (!orgId || !siteId)
    return ''
  const publishedRef = db.collection('organizations').doc(orgId).collection('published-site-settings').doc(siteId)
  const publishedSnap = await publishedRef.get()
  const publishedEmail = normalizeEmail(publishedSnap?.data()?.contactEmail)
  if (publishedEmail)
    return publishedEmail
  const siteRef = db.collection('organizations').doc(orgId).collection('sites').doc(siteId)
  const siteSnap = await siteRef.get()
  return normalizeEmail(siteSnap?.data()?.contactEmail)
}

const sendContactFormEmail = async ({
  to,
  replyTo,
  entries,
  orgId,
  siteId,
  pageId,
  blockId,
}) => {
  if (!SENDGRID_API_KEY || !SENDGRID_FROM_EMAIL) {
    logger.error('SendGrid config missing')
    return
  }

  const fieldLines = entries.length
    ? entries.map(entry => `- ${entry.key}: ${formatValue(entry.value)}`)
    : ['- (no fields provided)']
  const textBody = fieldLines.join('\n')

  const htmlFields = entries.length
    ? entries
      .map(entry => `<li><strong>${escapeHtml(entry.key)}:</strong> ${escapeHtml(formatValue(entry.value))}</li>`)
      .join('')
    : '<li>(no fields provided)</li>'
  const htmlBody = `
    <div>
      <h2>Contact Form Submission</h2>
      <ul>${htmlFields}</ul>
    </div>
  `

  await axios.post('https://api.sendgrid.com/v3/mail/send', {
    personalizations: [{ to: [{ email: to }], subject: 'Contact Form Submission' }],
    from: { email: SENDGRID_FROM_EMAIL },
    reply_to: { email: replyTo || SENDGRID_FROM_EMAIL },
    content: [
      { type: 'text/plain', value: textBody },
      { type: 'text/html', value: htmlBody },
    ],
  }, {
    headers: {
      'Authorization': `Bearer ${SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
  })
}

exports.trackHistory = onRequest(async (req, res) => {
  if (allowCors(req, res))
    return

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  if (!HISTORY_API_KEY) {
    logger.error('HISTORY_API_KEY not configured')
    res.status(500).json({ error: 'Server misconfigured' })
    return
  }

  if (getApiKey(req) !== HISTORY_API_KEY) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const orgId = getOrgIdFromPath(req.path || req.url || '')
  if (!orgId) {
    res.status(400).json({ error: 'Missing org id in route' })
    return
  }

  const payload = parseBody(req)
  if (!payload) {
    res.status(400).json({ error: 'Invalid JSON payload' })
    return
  }

  const uuid = typeof payload.uuid === 'string' ? payload.uuid.trim() : ''
  const action = typeof payload.action === 'string' ? payload.action.trim() : ''
  const data = payload.data ?? null

  if (!action) {
    res.status(400).json({ error: 'Missing action' })
    return
  }

  const historyRef = db.collection('organizations').doc(orgId).collection('lead-history')
  const docRef = uuid ? historyRef.doc(uuid) : historyRef.doc()
  const now = Firestore.FieldValue.serverTimestamp()

  const headers = req.headers || {}
  const userAgent = String(headers['user-agent'] || '')
  const historyBase = {
    ip: getClientIp(req),
    ipForwardedFor: getForwardedFor(req),
    userAgent,
    browser: parseBrowser(userAgent),
    os: parseOs(userAgent),
    device: parseDevice(userAgent, headers),
    platformHint: String(headers['sec-ch-ua-platform'] || ''),
    browserHint: String(headers['sec-ch-ua'] || ''),
    acceptLanguage: String(headers['accept-language'] || ''),
    referrer: String(headers.referer || headers.referrer || ''),
  }

  try {
    let exists = false
    if (uuid) {
      const snap = await docRef.get()
      exists = snap.exists
    }

    const updateData = {
      ...historyBase,
      updatedAt: now,
      lastActionAt: now,
      lastAction: action,
      lastData: data,
    }
    if (!exists) {
      updateData.createdAt = now
      updateData.firstActionAt = now
    }

    await docRef.set(updateData, { merge: true })
    await docRef.collection('actions').add({
      action,
      data,
      timestamp: now,
    })
    const siteId = typeof data?.siteId === 'string' ? data.siteId.trim() : ''
    if (siteId) {
      await db.collection('organizations').doc(orgId)
        .collection('sites').doc(siteId)
        .collection('lead-actions')
        .add({
          action,
          data,
          timestamp: now,
          uuid: docRef.id,
        })
    }

    if (action === 'Contact Form' && data && typeof data === 'object') {
      const siteId = typeof data.siteId === 'string' ? data.siteId.trim() : ''
      const pageId = typeof data.pageId === 'string' ? data.pageId.trim() : ''
      const blockId = typeof data.blockId === 'string' ? data.blockId.trim() : ''

      if (!siteId) {
        logger.warn('Contact form missing siteId', { siteId, pageId, blockId })
      }
      else {
        try {
          const entries = collectFormEntries(data)
          const replyTo = getReplyToEmail(data, entries)
          const blockEmail = normalizeEmail(await getPublishedEmailTo(orgId, siteId, pageId, blockId))
          const fallbackEmail = await getSiteSettingsEmail(orgId, siteId)
          const emailTo = blockEmail || fallbackEmail

          if (!emailTo) {
            logger.warn('Contact form email not found', { orgId, siteId, pageId, blockId })
          }
          else {
            await sendContactFormEmail({
              to: emailTo,
              replyTo,
              entries,
              orgId,
              siteId,
              pageId,
              blockId,
            })
          }
        }
        catch (err) {
          logger.error('Contact form email failed', err)
        }
      }
    }

    res.json({ uuid: docRef.id })
  }
  catch (err) {
    logger.error('trackHistory failed', err)
    res.status(500).json({ error: 'Failed to record history' })
  }
})

const getTimestampMillis = (value) => {
  if (!value)
    return null
  if (typeof value.toMillis === 'function')
    return value.toMillis()
  if (typeof value === 'number')
    return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  if (typeof value === 'object') {
    if (admin?.firestore?.Timestamp && value instanceof admin.firestore.Timestamp)
      return value.toMillis()
    if (typeof value.seconds === 'number' && typeof value.nanoseconds === 'number')
      return value.seconds * 1000 + value.nanoseconds / 1e6
  }
  return null
}

const cloneValue = (val) => {
  if (val === null || typeof val !== 'object')
    return val
  if (admin?.firestore?.Timestamp && val instanceof admin.firestore.Timestamp)
    return val
  if (val instanceof Date)
    return new Date(val.getTime())
  if (Array.isArray(val))
    return val.map(cloneValue)
  const cloned = {}
  for (const [key, value] of Object.entries(val)) {
    cloned[key] = cloneValue(value)
  }
  return cloned
}

const replaceSyncedBlockIfOlder = (blocks, blockId, sourceBlock, sourceMillis) => {
  let updated = false
  for (let i = 0; i < blocks.length; i++) {
    const currentBlock = blocks[i]
    if (currentBlock?.blockId !== blockId)
      continue
    const currentMillis = getTimestampMillis(currentBlock.blockUpdatedAt)
    if (currentMillis !== null && currentMillis >= sourceMillis)
      continue
    const cloned = cloneValue(sourceBlock)
    // Preserve the per-page block instance id so layout references remain valid.
    cloned.id = currentBlock?.id || cloned.id
    blocks[i] = cloned
    updated = true
  }
  return updated
}

const collectSyncedBlocks = (content, postContent) => {
  const syncedBlocks = new Map()
  const blocks = [
    ...(Array.isArray(content) ? content : []),
    ...(Array.isArray(postContent) ? postContent : []),
  ]

  for (const block of blocks) {
    if (!block?.synced || !block.blockId)
      continue
    const millis = getTimestampMillis(block.blockUpdatedAt)
    if (millis === null)
      continue
    const existing = syncedBlocks.get(block.blockId)
    if (!existing || millis > existing.millis)
      syncedBlocks.set(block.blockId, { block, millis })
  }

  return syncedBlocks
}

const BLOCK_META_EXCLUDE_KEYS = new Set(['queryItems', 'limit'])

const updateBlocksInArray = (blocks, blockId, afterData) => {
  let touched = false
  for (const block of blocks) {
    if (block?.blockId !== blockId)
      continue

    if (afterData.content !== undefined)
      block.content = afterData.content

    block.meta = block.meta || {}
    const srcMeta = afterData.meta || {}
    for (const key of Object.keys(srcMeta)) {
      block.meta[key] = block.meta[key] || {}
      const src = srcMeta[key] || {}
      for (const metaKey of Object.keys(src)) {
        if (BLOCK_META_EXCLUDE_KEYS.has(metaKey))
          continue
        block.meta[key][metaKey] = src[metaKey]
      }
    }

    touched = true
  }
  return touched
}

const buildPageBlockUpdate = (pageData, blockId, afterData) => {
  const pageContent = Array.isArray(pageData.content) ? [...pageData.content] : []
  const pagePostContent = Array.isArray(pageData.postContent) ? [...pageData.postContent] : []

  const contentTouched = updateBlocksInArray(pageContent, blockId, afterData)
  const postContentTouched = updateBlocksInArray(pagePostContent, blockId, afterData)

  return {
    touched: contentTouched || postContentTouched,
    content: pageContent,
    postContent: pagePostContent,
  }
}

exports.blockUpdated = onDocumentUpdated({ document: 'organizations/{orgId}/blocks/{blockId}', timeoutSeconds: 180 }, async (event) => {
  const change = event.data
  const blockId = event.params.blockId
  const orgId = event.params.orgId
  const afterData = change.after.data() || {}

  const sites = await db.collection('organizations').doc(orgId).collection('sites').get()
  if (sites.empty)
    logger.log(`No sites found in org ${orgId}`)

  const processedSiteIds = new Set()

  const updatePagesForSite = async (siteId, { updatePublished = true, scopeLabel }) => {
    const pagesSnap = await db.collection('organizations').doc(orgId)
      .collection('sites').doc(siteId)
      .collection('pages')
      .where('blockIds', 'array-contains', blockId)
      .get()

    if (pagesSnap.empty) {
      logger.log(`No pages found using block ${blockId} in ${scopeLabel}`)
      return
    }

    for (const pageDoc of pagesSnap.docs) {
      const pageData = pageDoc.data() || {}
      const { touched, content, postContent } = buildPageBlockUpdate(pageData, blockId, afterData)

      if (!touched) {
        logger.log(`Page ${pageDoc.id} has no matching block ${blockId} in ${scopeLabel}`)
        continue
      }

      await pageDoc.ref.update({ content, postContent })

      if (updatePublished) {
        const publishedRef = db.collection('organizations').doc(orgId)
          .collection('sites').doc(siteId)
          .collection('published').doc(pageDoc.id)

        const publishedDoc = await publishedRef.get()
        if (publishedDoc.exists) {
          await publishedRef.update({ content, postContent })
        }
      }

      logger.log(`Updated page ${pageDoc.id} in ${scopeLabel} with new block ${blockId} content`)
    }
  }

  for (const siteDoc of sites.docs) {
    const siteId = siteDoc.id
    processedSiteIds.add(siteId)
    await updatePagesForSite(siteId, {
      updatePublished: siteId !== 'templates',
      scopeLabel: siteId === 'templates'
        ? `templates site (org ${orgId})`
        : `site ${siteId} (org ${orgId})`,
    })
  }

  if (!processedSiteIds.has('templates')) {
    await updatePagesForSite('templates', {
      updatePublished: false,
      scopeLabel: `templates site (org ${orgId})`,
    })
  }
})

exports.fontFileUpdated = onDocumentUpdated({ document: 'organizations/{orgId}/files/{fileId}', timeoutSeconds: 180 }, async (event) => {
  const before = event.data.before.data() || {}
  const after = event.data.after.data() || {}
  const orgId = event.params.orgId

  if (!after?.uploadCompletedToR2 || !after?.r2URL)
    return

  // Only act on font uploads that were tagged for themes
  const meta = after.meta || {}
  const themeId = meta.themeId
  if (!themeId || !meta.cmsFont)
    return

  if (meta.autoLink === false)
    return

  if (before.uploadCompletedToR2 === after.uploadCompletedToR2 && before.r2URL === after.r2URL)
    return

  try {
    const themeRef = db.collection('organizations').doc(orgId).collection('themes').doc(themeId)
    const themeSnap = await themeRef.get()
    if (!themeSnap.exists) {
      logger.warn(`fontFileUpdated: theme ${themeId} not found in org ${orgId}`)
      return
    }

    const themeData = themeSnap.data() || {}
    let headJson = {}
    try {
      headJson = JSON.parse(themeData.headJSON || '{}') || {}
    }
    catch (e) {
      headJson = {}
    }

    const links = Array.isArray(headJson.link) ? [...headJson.link] : []
    const href = after.r2URL
    const alreadyLinked = links.some(link => link && link.href === href)
    if (alreadyLinked)
      return

    const linkEntry = {
      rel: 'preload',
      as: 'font',
      href,
      crossorigin: '',
    }
    if (after.contentType)
      linkEntry.type = after.contentType

    links.push(linkEntry)
    headJson.link = links

    await themeRef.set({
      headJSON: JSON.stringify(headJson, null, 2),
    }, { merge: true })

    logger.log(`fontFileUpdated: appended font link for ${href} to theme ${themeId} in org ${orgId}`)
  }
  catch (error) {
    logger.error('fontFileUpdated error', error)
  }
})

const slug = s => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
const yyyyMM = (d) => {
  const dt = d ? new Date(d) : new Date()
  const y = dt.getUTCFullYear()
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const h = String(dt.getUTCHours()).padStart(2, '0')
  const min = String(dt.getUTCMinutes()).padStart(2, '0')
  return `${y}${m}${h}${min}`
}
// Canonical + indices for posts
exports.onPostWritten = createKvMirrorHandler({
  document: 'organizations/{orgId}/sites/{siteId}/published_posts/{postId}',

  makeCanonicalKey: ({ orgId, siteId, postId }) =>
    `posts:${orgId}:${siteId}:${postId}`,

  makeIndexKeys: ({ orgId, siteId, postId }, data) => {
    const keys = []

    // by tag
    const tags = Array.isArray(data?.tags) ? data.tags : []
    for (const t of tags) {
      const st = slug(t)
      if (st)
        keys.push(`idx:posts:tags:${orgId}:${siteId}:${st}:${postId}`)
    }

    // by date (archive buckets)
    const pub = data?.publishedAt || data?.doc_created_at || data?.createdAt || null
    if (pub)
      keys.push(`idx:posts:dates:${orgId}:${siteId}:${yyyyMM(pub)}:${postId}`)

    // by slug (direct lookup)
    if (data?.name)
      keys.push(`idx:posts:slugs:${orgId}:${siteId}:${data.name}`)

    return keys
  },

  // store full document as-is
  serialize: data => JSON.stringify(data),

  // tiny metadata so you can render lists without N GETs (stored in meta:{key})
  makeMetadata: data => ({
    title: data?.title || '',
    blurb: data?.blurb || '',
    doc_created_at: data?.doc_created_at || '',
    featuredImage: data?.featuredImage || '',
    name: data?.name || '',
  }),

  timeoutSeconds: 180,
})

exports.onSiteWritten = createKvMirrorHandler({
  document: 'organizations/{orgId}/published-site-settings/{siteId}',
  makeCanonicalKey: ({ orgId, siteId }) =>
    `sites:${orgId}:${siteId}`,
  makeIndexKeys: ({ orgId, siteId }, data) => {
    const keys = []
    const siteDocId = slug(siteId)
    if (siteDocId)
      keys.push(`idx:sites:docId:${orgId}:${siteDocId}:${siteId}`)
    const domains = Array.isArray(data?.domains) ? data.domains : []
    for (const domain of domains) {
      const st = slug(domain)
      keys.push(`idx:sites:domains:${st}`)
    }
    return keys
  },
  serialize: data => JSON.stringify(data),
  timeoutSeconds: 180,
})

exports.onUserWritten = createKvMirrorHandler({
  document: 'organizations/{orgId}/users/{userId}',
  makeCanonicalKey: ({ orgId, userId }) =>
    `users:${orgId}:${userId}`,
  makeIndexKeys: async ({ orgId, userId }, data) => {
    const keys = []
    const resolvedUserId = slug(data?.userId) || slug(userId)
    if (resolvedUserId)
      keys.push(`idx:users:userId:${orgId}:${resolvedUserId}`)
    return keys
  },
  serialize: data => JSON.stringify(data),
  makeMetadata: data => ({
    title: data?.title || '',
    contactPhone: data?.contactPhone || data?.phone || '',
    contactEmail: data?.contactEmail || data?.email || '',
    doc_created_at: data?.doc_created_at || '',
    featuredImage: data?.featuredImage || '',
    name: data?.name || '',
  }),
  timeoutSeconds: 180,
})

exports.onThemeWritten = createKvMirrorHandler({
  document: 'organizations/{orgId}/themes/{themeId}',
  makeCanonicalKey: ({ orgId, themeId }) =>
    `themes:${orgId}:${themeId}`,
  serialize: data => JSON.stringify({ theme: JSON.parse(data.theme), headJSON: JSON.parse(data.headJSON), extraCSS: data.extraCSS }),
  timeoutSeconds: 180,
})

exports.onPublishedPageWritten = createKvMirrorHandler({
  document: 'organizations/{orgId}/sites/{siteId}/published/{pageId}',
  makeCanonicalKey: ({ orgId, siteId, pageId }) =>
    `pages:${orgId}:${siteId}:${pageId}`,
  timeoutSeconds: 180,
})

exports.syncPublishedSyncedBlocks = onDocumentWritten({ document: 'organizations/{orgId}/sites/{siteId}/published/{pageId}', timeoutSeconds: 180 }, async (event) => {
  const change = event.data
  if (!change.after.exists)
    return

  const orgId = event.params.orgId
  const siteId = event.params.siteId
  const pageId = event.params.pageId
  const data = change.after.data() || {}
  const syncedBlocks = collectSyncedBlocks(data.content, data.postContent)

  if (!syncedBlocks.size)
    return

  const publishedRef = db.collection('organizations').doc(orgId).collection('sites').doc(siteId).collection('published')
  const draftRef = db.collection('organizations').doc(orgId).collection('sites').doc(siteId).collection('pages')

  for (const [blockId, { block: sourceBlock, millis: sourceMillis }] of syncedBlocks.entries()) {
    const publishedSnap = await publishedRef.where('blockIds', 'array-contains', blockId).get()
    if (publishedSnap.empty)
      continue

    for (const publishedDoc of publishedSnap.docs) {
      if (publishedDoc.id === pageId)
        continue

      const publishedData = publishedDoc.data() || {}
      const publishedContent = Array.isArray(publishedData.content) ? [...publishedData.content] : []
      const publishedPostContent = Array.isArray(publishedData.postContent) ? [...publishedData.postContent] : []

      const updatedContent = replaceSyncedBlockIfOlder(publishedContent, blockId, sourceBlock, sourceMillis)
      const updatedPostContent = replaceSyncedBlockIfOlder(publishedPostContent, blockId, sourceBlock, sourceMillis)

      if (!updatedContent && !updatedPostContent)
        continue

      await publishedDoc.ref.update({ content: publishedContent, postContent: publishedPostContent })

      logger.log(`Synced published block ${blockId} from page ${pageId} to published page ${publishedDoc.id} in site ${siteId} (org ${orgId})`)
    }

    const draftSnap = await draftRef.where('blockIds', 'array-contains', blockId).get()
    if (!draftSnap.empty) {
      for (const draftDoc of draftSnap.docs) {
        if (draftDoc.id === pageId)
          continue

        const draftData = draftDoc.data() || {}
        const draftContent = Array.isArray(draftData.content) ? [...draftData.content] : []
        const draftPostContent = Array.isArray(draftData.postContent) ? [...draftData.postContent] : []

        const updatedDraftContent = replaceSyncedBlockIfOlder(draftContent, blockId, sourceBlock, sourceMillis)
        const updatedDraftPostContent = replaceSyncedBlockIfOlder(draftPostContent, blockId, sourceBlock, sourceMillis)

        if (!updatedDraftContent && !updatedDraftPostContent)
          continue

        await draftDoc.ref.update({ content: draftContent, postContent: draftPostContent })
        logger.log(`Synced published block ${blockId} from page ${pageId} to draft page ${draftDoc.id} in site ${siteId} (org ${orgId})`)
      }
    }
  }
})

exports.onPageUpdated = onDocumentWritten({ document: 'organizations/{orgId}/sites/{siteId}/pages/{pageId}', timeoutSeconds: 180 }, async (event) => {
  const change = event.data
  const orgId = event.params.orgId
  const siteId = event.params.siteId
  const pageId = event.params.pageId
  const siteRef = db.collection('organizations').doc(orgId).collection('sites').doc(siteId)
  const pageData = change.after.exists ? (change.after.data() || {}) : {}

  if (change.after.exists) {
    const lastModified = pageData.last_updated
      ?? pageData.doc_updated_at
      ?? pageData.updatedAt
      ?? pageData.doc_created_at
      ?? (change.after.updateTime ? change.after.updateTime.toMillis() : Date.now())

    await siteRef.set({
      pageLastModified: {
        [pageId]: lastModified,
      },
    }, { merge: true })
  }

  if (!change.after.exists)
    return

  const content = Array.isArray(pageData.content) ? pageData.content : []
  const postContent = Array.isArray(pageData.postContent) ? pageData.postContent : []

  const syncedBlocks = collectSyncedBlocks(content, postContent)

  if (!syncedBlocks.size)
    return

  const pagesRef = db.collection('organizations').doc(orgId).collection('sites').doc(siteId).collection('pages')

  for (const [blockId, { block: sourceBlock, millis: sourceMillis }] of syncedBlocks.entries()) {
    const pagesSnap = await pagesRef.where('blockIds', 'array-contains', blockId).get()
    if (pagesSnap.empty)
      continue

    for (const pageDoc of pagesSnap.docs) {
      if (pageDoc.id === pageId)
        continue

      const pageData = pageDoc.data() || {}
      const pageContent = Array.isArray(pageData.content) ? [...pageData.content] : []
      const pagePostContent = Array.isArray(pageData.postContent) ? [...pageData.postContent] : []

      const updatedContent = replaceSyncedBlockIfOlder(pageContent, blockId, sourceBlock, sourceMillis)
      const updatedPostContent = replaceSyncedBlockIfOlder(pagePostContent, blockId, sourceBlock, sourceMillis)

      if (!updatedContent && !updatedPostContent)
        continue

      await pageDoc.ref.update({ content: pageContent, postContent: pagePostContent })

      logger.log(`Synced block ${blockId} to page ${pageDoc.id} in site ${siteId} (org ${orgId})`)
    }
  }
})

exports.onPageDeleted = onDocumentDeleted({ document: 'organizations/{orgId}/sites/{siteId}/pages/{pageId}', timeoutSeconds: 180 }, async (event) => {
  const orgId = event.params.orgId
  const siteId = event.params.siteId
  const pageId = event.params.pageId
  const publishedRef = db.collection('organizations').doc(orgId).collection('sites').doc(siteId).collection('published').doc(pageId)
  await publishedRef.delete()
  const siteRef = db.collection('organizations').doc(orgId).collection('sites').doc(siteId)
  try {
    await siteRef.update({
      [`pageLastModified.${pageId}`]: Firestore.FieldValue.delete(),
    })
  }
  catch (error) {
    logger.warn('Failed to remove pageLastModified for deleted page', { orgId, siteId, pageId, error: error?.message })
  }
})

exports.onSiteDeleted = onDocumentDeleted({ document: 'organizations/{orgId}/sites/{siteId}', timeoutSeconds: 180 }, async (event) => {
  // delete documents in sites/{siteId}/published
  const orgId = event.params.orgId
  const siteId = event.params.siteId

  // delete documents in sites/{siteId}/pages
  const pagesRef = db.collection('organizations').doc(orgId).collection('sites').doc(siteId).collection('pages')
  const pagesDocs = await pagesRef.listDocuments()
  for (const doc of pagesDocs) {
    await doc.delete()
  }

  // delete the published-site-settings document
  const siteSettingsRef = db.collection('organizations').doc(orgId).collection('published-site-settings').doc(siteId)
  await siteSettingsRef.delete()
})

const isFillableMeta = (meta) => {
  if (!meta)
    return false
  if (meta.api || meta.collection)
    return false
  return true
}

const normalizeOptionValue = (value, options = [], valueKey = 'value', titleKey = 'title') => {
  if (value === null || value === undefined)
    return null
  const stringVal = String(value).trim().toLowerCase()
  for (const option of options) {
    const optValue = option?.[valueKey]
    const optTitle = option?.[titleKey]
    if (stringVal === String(optValue).trim().toLowerCase() || stringVal === String(optTitle).trim().toLowerCase())
      return optValue
  }
  return null
}

const sanitizeArrayWithSchema = (schema = [], arr) => {
  if (!Array.isArray(arr))
    return []
  return arr
    .map((item) => {
      if (!item || typeof item !== 'object')
        return null
      const clean = {}
      for (const schemaItem of schema) {
        const val = item[schemaItem.field]
        if (val === null || val === undefined)
          continue
        if (typeof val === 'string')
          clean[schemaItem.field] = val
        else if (typeof val === 'number')
          clean[schemaItem.field] = val
        else if (typeof val === 'boolean')
          clean[schemaItem.field] = val
        else
          clean[schemaItem.field] = JSON.stringify(val)
      }
      return Object.keys(clean).length ? clean : null
    })
    .filter(Boolean)
}

const sanitizeValueForMeta = (type, value, meta) => {
  switch (type) {
    case 'number': {
      const num = Number(value)
      return Number.isFinite(num) ? num : null
    }
    case 'json': {
      if (value == null)
        return null
      if (typeof value === 'object')
        return JSON.stringify(value)
      const str = String(value).trim()
      if (!str)
        return null
      try {
        JSON.parse(str)
        return str
      }
      catch {
        return str
      }
    }
    case 'array': {
      if (meta?.schema)
        return sanitizeArrayWithSchema(meta.schema, value)
      if (!Array.isArray(value))
        return []
      return value.map(v => String(v || '')).filter(Boolean)
    }
    case 'option': {
      if (meta?.option?.options)
        return normalizeOptionValue(value, meta.option.options, meta.option.optionsValue, meta.option.optionsKey)
      return typeof value === 'string' ? value : null
    }
    case 'richtext':
    case 'textarea':
    case 'text':
    default:
      return typeof value === 'string' ? value : ((value === null || value === undefined) ? null : String(value))
  }
}

const clampText = (value, max) => {
  if (!value)
    return ''
  const str = String(value).replace(/\s+/g, ' ').trim()
  if (str.length <= max)
    return str
  return `${str.slice(0, max)}...`
}

const normalizePromptValue = (value) => {
  if (value === null || value === undefined)
    return ''
  if (typeof value === 'string')
    return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  try {
    return JSON.stringify(value)
  }
  catch {
    return String(value)
  }
}

const summarizeBlocksForSeo = (blocks = []) => {
  if (!Array.isArray(blocks) || blocks.length === 0)
    return ''
  const summaries = []
  blocks.forEach((block, index) => {
    const values = block?.values || {}
    const lines = []
    const blockLabel = block?.name || block?.title || block?.heading || block?.label || block?.blockId || block?.id || ''

    const inlineFields = {
      name: block?.name,
      title: block?.title,
      heading: block?.heading,
      label: block?.label,
      text: block?.text,
      body: block?.body,
      content: block?.content,
    }

    for (const [key, val] of Object.entries(inlineFields)) {
      const normalized = normalizePromptValue(val)
      if (!normalized)
        continue
      lines.push(`- ${key}: ${clampText(normalized, 280)}`)
    }

    for (const [key, val] of Object.entries(values)) {
      const normalized = normalizePromptValue(val)
      if (!normalized)
        continue
      lines.push(`- ${key}: ${clampText(normalized, 280)}`)
    }
    if (!lines.length)
      return
    const label = blockLabel || `block-${index + 1}`
    summaries.push(`Block ${index + 1} (${label})\n${lines.join('\n')}`)
  })
  return summaries.join('\n\n')
}

const shouldUpdateSiteStructuredData = (siteData = {}) => {
  const raw = siteData?.structuredData
  if (!raw || (typeof raw === 'string' && !raw.trim()))
    return true
  let parsed = null
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    }
    catch {
      return false
    }
  }
  else if (typeof raw === 'object') {
    parsed = raw
  }
  if (!parsed)
    return false
  const name = String(parsed.name || '').trim()
  const url = String(parsed.url || '').trim()
  const description = String(parsed.description || '').trim()
  const publisherName = String(parsed.publisher?.name || '').trim()
  const logoUrl = String(parsed.publisher?.logo?.url || '').trim()
  const sameAs = Array.isArray(parsed.sameAs) ? parsed.sameAs.filter(Boolean) : []
  return !name && !url && !description && !publisherName && !logoUrl && sameAs.length === 0
}

const callOpenAiForPageSeo = async ({
  siteData,
  pageData,
  pageId,
  blockSummary,
  includeSiteStructuredData,
}) => {
  if (!OPENAI_API_KEY)
    throw new Error('OPENAI_API_KEY not set')

  const pageStructuredTemplate = PAGE_STRUCTURED_DATA_TEMPLATE
  const siteStructuredTemplate = includeSiteStructuredData ? SITE_STRUCTURED_DATA_TEMPLATE : ''

  const responseShape = includeSiteStructuredData
    ? '{"metaTitle":"...","metaDescription":"...","structuredData":{...},"siteStructuredData":{...}}'
    : '{"metaTitle":"...","metaDescription":"...","structuredData":{...}}'

  const system = [
    'You are an SEO assistant updating a CMS page.',
    'Use the provided page content and block values.',
    'Base the meta description and structured data description on the block content summary.',
    'Return JSON only using the specified response shape.',
    'Meta title: concise, <= 60 characters.',
    'Meta description: <= 160 characters, sentence case.',
    'Structured data must match the provided template shape.',
    'Preserve CMS tokens like {{cms-site}}, {{cms-url}}, and {{cms-logo}} exactly as-is.',
  ].join(' ')

  const user = [
    `Site name: ${siteData?.name || 'n/a'}`,
    `Domains: ${(Array.isArray(siteData?.domains) ? siteData.domains.join(', ') : '') || 'n/a'}`,
    `Page name: ${pageData?.name || pageId || 'n/a'}`,
    `Page slug/id: ${pageId || 'n/a'}`,
    `Existing meta title: ${pageData?.metaTitle || ''}`,
    `Existing meta description: ${pageData?.metaDescription || ''}`,
    `Existing structured data: ${pageData?.structuredData || ''}`,
    '',
    'Structured data templates (keep keys; fill in values):',
    `Page: ${pageStructuredTemplate}`,
    includeSiteStructuredData ? `Site: ${siteStructuredTemplate}` : '',
    '',
    'Block content summary:',
    clampText(blockSummary || 'n/a', 8000),
    '',
    `Return JSON only with this shape: ${responseShape}`,
  ].filter(Boolean).join('\n')

  const body = {
    model: OPENAI_MODEL,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  }

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '')
    throw new Error(`OpenAI error ${resp.status}: ${txt}`)
  }

  const json = await resp.json()
  const content = json?.choices?.[0]?.message?.content || '{}'
  try {
    return JSON.parse(content)
  }
  catch (err) {
    logger.error('Failed to parse OpenAI response', err)
    return {}
  }
}

const buildFieldsList = (pagesSnap, siteData = {}) => {
  const descriptors = []
  const descriptorMap = new Map()

  const siteMetaTargets = [
    ['metaTitle', 'text', 'Site Meta Title'],
    ['metaDescription', 'text', 'Site Meta Description'],
    ['structuredData', 'json', 'Site Structured Data (JSON-LD)'],
  ]
  for (const [field, type, title] of siteMetaTargets) {
    const path = `site.meta.${field}`
    const descriptor = {
      path,
      pageId: null,
      pageName: siteData?.name || 'Site',
      location: 'siteMeta',
      blockIndex: -1,
      blockId: 'meta',
      field,
      type,
      title,
      option: null,
      schema: null,
    }
    descriptors.push(descriptor)
    descriptorMap.set(path, descriptor)
  }

  for (const pageDoc of pagesSnap.docs) {
    const pageId = pageDoc.id
    const pageData = pageDoc.data() || {}
    const pageName = pageData.name || pageId
    const metaTargets = [
      ['metaTitle', 'text', 'Meta Title'],
      ['metaDescription', 'text', 'Meta Description'],
      ['structuredData', 'json', 'Structured Data (JSON-LD)'],
    ]
    for (const [field, type, title] of metaTargets) {
      const path = `${pageId}.meta.${field}`
      const descriptor = {
        path,
        pageId,
        pageName,
        location: 'pageMeta',
        blockIndex: -1,
        blockId: 'meta',
        field,
        type,
        title,
        option: null,
        schema: null,
      }
      descriptors.push(descriptor)
      descriptorMap.set(path, descriptor)
    }

    const locations = [
      ['content', Array.isArray(pageData.content) ? pageData.content : []],
      ['postContent', Array.isArray(pageData.postContent) ? pageData.postContent : []],
    ]

    for (const [location, blocks] of locations) {
      blocks.forEach((block, blockIndex) => {
        const meta = block?.meta || {}
        const values = block?.values || {}
        const blockId = block?.blockId || `block-${blockIndex}`
        for (const [field, cfg] of Object.entries(meta)) {
          if (!isFillableMeta(cfg))
            continue
          const type = cfg.type || 'text'
          const path = `${pageId}.${location}.${blockId}.${field}`
          const descriptor = {
            path,
            pageId,
            pageName,
            location,
            blockIndex,
            blockId,
            field,
            type,
            title: cfg.title || field,
            option: cfg.option || null,
            schema: Array.isArray(cfg.schema) ? cfg.schema : null,
          }
          descriptors.push(descriptor)
          descriptorMap.set(path, descriptor)
        }
      })
    }
  }

  return { descriptors, descriptorMap }
}

const formatFieldPrompt = (descriptor) => {
  const parts = [
    `- path: ${descriptor.path}`,
    `  page: ${descriptor.pageName}`,
    `  field: ${descriptor.title || descriptor.field}`,
    `  type: ${descriptor.type}`,
  ]
  if (descriptor.option?.options?.length) {
    const opts = descriptor.option.options
      .map(opt => `${opt?.[descriptor.option.optionsValue || 'value']} (${opt?.[descriptor.option.optionsKey || 'title'] || ''})`)
      .join(', ')
    parts.push(`  options: ${opts}`)
  }
  if (descriptor.schema?.length) {
    const schemaFields = descriptor.schema.map(s => `${s.field}:${s.type}`).join(', ')
    parts.push(`  array schema: ${schemaFields}`)
  }
  return parts.join('\n')
}

const summarizeAgentMeta = (meta = {}) => {
  const entries = []
  for (const [key, val] of Object.entries(meta)) {
    if (val == null)
      continue
    const str = typeof val === 'object' ? JSON.stringify(val) : String(val)
    if (!str.trim())
      continue
    // Trim extremely long fields to avoid prompt bloat
    const trimmed = str.length > 400 ? `${str.slice(0, 400)}...` : str
    entries.push(`${key}: ${trimmed}`)
  }
  return entries
}

const summarizeAgentRoot = (agent = {}) => {
  const entries = []
  for (const [key, val] of Object.entries(agent)) {
    if (key === 'meta' || key === 'userId' || key === 'uid')
      continue
    if (val == null)
      continue
    const str = typeof val === 'object' ? JSON.stringify(val) : String(val)
    if (!str.trim())
      continue
    const trimmed = str.length > 400 ? `${str.slice(0, 400)}...` : str
    entries.push(`${key}: ${trimmed}`)
  }
  return entries
}

const callOpenAiForSiteBootstrap = async ({ siteData, agentData, instructions, fields }) => {
  if (!OPENAI_API_KEY)
    throw new Error('OPENAI_API_KEY not set')
  if (!fields || fields.length === 0)
    return {}

  const siteSummary = [
    `Site name: ${siteData?.name || 'n/a'}`,
    `Domains: ${(Array.isArray(siteData?.domains) ? siteData.domains.join(', ') : '') || 'n/a'}`,
  ].join('\n')

  const rootLines = agentData ? summarizeAgentRoot(agentData) : []
  const metaLines = agentData ? summarizeAgentMeta(agentData.meta || {}) : []
  const agentSummary = agentData
    ? [
    `Agent name: ${agentData.meta?.name || agentData.name || agentData.userId || ''}`,
    `Title: ${agentData.meta?.title || ''}`,
    `Bio: ${agentData.meta?.bio || ''}`,
    `Phone: ${agentData.meta?.phone || ''}`,
    `Email: ${agentData.meta?.email || ''}`,
    rootLines.length ? 'Additional agent fields:' : '',
    ...rootLines,
    metaLines.length ? 'Additional agent meta:' : '',
    ...metaLines,
      ].filter(Boolean).join('\n')
    : 'Agent data: n/a'

  const fieldPrompts = fields.map(formatFieldPrompt).join('\n')
  const structuredDataInstructions = [
    'Structured data templates (keep keys; fill in values):',
    `Site: ${SITE_STRUCTURED_DATA_TEMPLATE}`,
    `Page: ${PAGE_STRUCTURED_DATA_TEMPLATE}`,
  ].join('\n')

  const system = [
    'You are a website copywriter tasked with pre-filling CMS blocks for a brand-new site.',
    'Use the provided site/agent context and instructions.',
    'Keep outputs concise, professional, and free of placeholder words like "lorem ipsum".',
    'Return JSON only, with this shape: {"fields": {"<path>": <value>}}.',
    'For text/richtext/textarea: short, readable copy. For numbers: numeric only.',
    'For arrays without schema: array of short strings. For arrays with schema: array of objects matching the schema fields.',
    'For option fields: return one of the allowed option values (not the label).',
    'If you truly cannot infer a value, return an empty string for that key.',
    'For structuredData fields: return a JSON object matching the provided template shape.',
    'Preserve CMS tokens like {{cms-site}}, {{cms-url}}, and {{cms-logo}} exactly as-is.',
    'All content, including meta titles/descriptions and structured data, should be optimized for maximum SEO performance.',
  ].join(' ')

  const user = [
    siteSummary,
    `AI instructions: ${instructions || 'n/a'}`,
    agentSummary,
    '',
    structuredDataInstructions,
    '',
    'Fields to fill:',
    fieldPrompts,
  ].join('\n')

  const body = {
    model: OPENAI_MODEL,
    temperature: 0.4,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  }

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '')
    throw new Error(`OpenAI error ${resp.status}: ${txt}`)
  }

  const json = await resp.json()
  const content = json?.choices?.[0]?.message?.content || '{}'
  try {
    return JSON.parse(content)
  }
  catch (err) {
    logger.error('Failed to parse OpenAI response', err)
    return {}
  }
}

const applyAiResults = (descriptorMap, pagesSnap, aiResults, siteData = {}) => {
  if (!aiResults || typeof aiResults.fields !== 'object')
    return { pageUpdates: {}, siteUpdates: {} }

  const pageUpdates = {}
  const siteUpdates = {}
  const pageDocsMap = new Map()
  for (const doc of pagesSnap.docs)
    pageDocsMap.set(doc.id, doc.data() || {})

  for (const [path, value] of Object.entries(aiResults.fields)) {
    const descriptor = descriptorMap.get(path)
    if (!descriptor)
      continue

    const sanitized = sanitizeValueForMeta(descriptor.type, value, { option: descriptor.option, schema: descriptor.schema })
    if (sanitized === null || sanitized === undefined)
      continue
    if (Array.isArray(sanitized) && sanitized.length === 0)
      continue
    if (typeof sanitized === 'string' && sanitized.trim().length === 0)
      continue

    if (descriptor.location === 'siteMeta') {
      if (descriptor.field === 'structuredData')
        siteUpdates.structuredData = sanitized
      else if (descriptor.field === 'metaTitle')
        siteUpdates.metaTitle = sanitized
      else if (descriptor.field === 'metaDescription')
        siteUpdates.metaDescription = sanitized
      continue
    }

    const pageData = pageDocsMap.get(descriptor.pageId) || {}
    if (!pageUpdates[descriptor.pageId]) {
      pageUpdates[descriptor.pageId] = {
        content: Array.isArray(pageData.content) ? JSON.parse(JSON.stringify(pageData.content)) : [],
        postContent: Array.isArray(pageData.postContent) ? JSON.parse(JSON.stringify(pageData.postContent)) : [],
        metaTitle: pageData.metaTitle || '',
        metaDescription: pageData.metaDescription || '',
        structuredData: pageData.structuredData || '',
      }
    }

    if (descriptor.location === 'pageMeta') {
      if (descriptor.field === 'metaTitle')
        pageUpdates[descriptor.pageId].metaTitle = sanitized
      else if (descriptor.field === 'metaDescription')
        pageUpdates[descriptor.pageId].metaDescription = sanitized
      else if (descriptor.field === 'structuredData')
        pageUpdates[descriptor.pageId].structuredData = sanitized
      continue
    }

    const targetBlocks = descriptor.location === 'postContent' ? pageUpdates[descriptor.pageId].postContent : pageUpdates[descriptor.pageId].content
    const block = targetBlocks[descriptor.blockIndex]
    if (!block)
      continue
    block.values = block.values || {}
    block.values[descriptor.field] = sanitized
  }

  return { pageUpdates, siteUpdates }
}

const stripCodeFences = (text) => {
  if (!text)
    return ''
  return text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim()
}

const extractJsonFromText = (text) => {
  const cleaned = stripCodeFences(text)
  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace)
    return null
  const candidate = cleaned.slice(firstBrace, lastBrace + 1)
  try {
    return JSON.parse(candidate)
  }
  catch {
    return null
  }
}

const parseAiJson = (text) => {
  if (!text)
    return null
  try {
    return JSON.parse(stripCodeFences(text))
  }
  catch {
    return extractJsonFromText(text)
  }
}

const buildBlockAiPrompt = ({
  blockId,
  blockName,
  content,
  fields,
  currentValues,
  meta,
  instructions,
}) => {
  const fieldLines = fields
    .map(field => `- ${field.id} (${field.type || 'text'}): ${field.label || ''}`)
    .join('\n')

  return [
    `Block ID: ${blockId}`,
    `Block Name: ${blockName || 'n/a'}`,
    '',
    'Selected fields:',
    fieldLines || '- none',
    '',
    'Block content (reference only):',
    content || 'n/a',
    '',
    'Field metadata (JSON):',
    JSON.stringify(meta || {}),
    '',
    'Current field values (JSON):',
    JSON.stringify(currentValues || {}),
    '',
    `Instructions: ${instructions || 'n/a'}`,
    '',
    'Return ONLY valid JSON.',
    'The response should be a JSON object where keys are the selected field ids.',
    'You must return values for every selected field. Do not omit any field.',
    'If unsure, make a best-guess value instead of leaving it blank.',
    'For richtext, return HTML strings. For textarea, return plain text.',
    'For arrays, return an array that matches the schema when possible.',
  ].join('\n')
}

const assertCallableUser = (request) => {
  if (!request?.auth?.uid)
    throw new HttpsError('unauthenticated', 'Authentication required.')
  if (request?.data?.uid !== request.auth.uid)
    throw new HttpsError('permission-denied', 'UID mismatch.')
}

exports.updateSeoFromAi = onCall({ timeoutSeconds: 180 }, async (request) => {
  assertCallableUser(request)
  const data = request.data || {}
  const auth = request.auth
  const { orgId, siteId, pageId } = data
  if (!orgId || !siteId || !pageId)
    throw new HttpsError('invalid-argument', 'Missing orgId, siteId, or pageId')
  const allowed = await permissionCheck(auth.uid, 'write', `organizations/${orgId}/sites/${siteId}/pages`)
  if (!allowed)
    throw new HttpsError('permission-denied', 'Not allowed to update page SEO')

  const pageRef = db.collection('organizations').doc(orgId).collection('sites').doc(siteId).collection('pages').doc(pageId)
  const siteRef = db.collection('organizations').doc(orgId).collection('sites').doc(siteId)
  const [pageSnap, siteSnap] = await Promise.all([pageRef.get(), siteRef.get()])
  if (!pageSnap.exists)
    throw new HttpsError('not-found', 'Page not found')
  const pageData = pageSnap.data() || {}
  const siteData = siteSnap.exists ? (siteSnap.data() || {}) : {}

  const blockSummary = [
    'Index blocks:',
    summarizeBlocksForSeo(pageData.content),
    '',
    'Post blocks:',
    summarizeBlocksForSeo(pageData.postContent),
  ].filter(Boolean).join('\n')

  const includeSiteStructuredData = shouldUpdateSiteStructuredData(siteData)
  const aiResults = await callOpenAiForPageSeo({
    siteData,
    pageData,
    pageId,
    blockSummary,
    includeSiteStructuredData,
  })

  const pageUpdates = {}
  const metaTitle = sanitizeValueForMeta('text', aiResults?.metaTitle)
  const metaDescription = sanitizeValueForMeta('text', aiResults?.metaDescription)
  const structuredData = sanitizeValueForMeta('json', aiResults?.structuredData)
  if (metaTitle)
    pageUpdates.metaTitle = metaTitle
  if (metaDescription)
    pageUpdates.metaDescription = metaDescription
  if (structuredData)
    pageUpdates.structuredData = structuredData

  const siteUpdates = {}
  if (includeSiteStructuredData) {
    const siteStructuredData = sanitizeValueForMeta('json', aiResults?.siteStructuredData)
    if (siteStructuredData)
      siteUpdates.structuredData = siteStructuredData
  }

  if (Object.keys(pageUpdates).length > 0)
    await pageRef.set(pageUpdates, { merge: true })
  if (includeSiteStructuredData && Object.keys(siteUpdates).length > 0)
    await siteRef.set(siteUpdates, { merge: true })

  return {
    pageId,
    metaTitle: pageUpdates.metaTitle || '',
    metaDescription: pageUpdates.metaDescription || '',
    structuredData: pageUpdates.structuredData || '',
    siteStructuredDataUpdated: includeSiteStructuredData && !!siteUpdates.structuredData,
    siteStructuredData: siteUpdates.structuredData || '',
  }
})

exports.getCloudflarePagesProject = onCall(async (request) => {
  assertCallableUser(request)
  const data = request.data || {}
  const orgId = String(data.orgId || '').trim()
  const siteId = String(data.siteId || '').trim()
  const rawDomains = Array.isArray(data.domains) ? data.domains : []
  const normalizedDomains = Array.from(new Set(rawDomains.map(normalizeDomain).filter(Boolean)))
  const pagesTarget = getCloudflarePagesTarget()

  if (!CLOUDFLARE_PAGES_PROJECT)
    logger.warn('CLOUDFLARE_PAGES_PROJECT is not set.')

  const domainRegistry = {}
  if (orgId && siteId && normalizedDomains.length) {
    const allowed = await permissionCheck(request.auth.uid, 'read', `organizations/${orgId}/sites`)
    if (!allowed)
      throw new HttpsError('permission-denied', 'Not allowed to read site settings')

    await Promise.all(normalizedDomains.map(async (domain) => {
      const registryRef = db.collection(DOMAIN_REGISTRY_COLLECTION).doc(domain)
      const registrySnap = await registryRef.get()
      const fallback = buildDomainDnsPayload(domain, pagesTarget)
      if (!registrySnap.exists) {
        domainRegistry[domain] = {
          ...fallback,
          apexAttempted: false,
          apexAdded: false,
          apexError: '',
          dnsGuidance: fallback.dnsEligible
            ? 'Add the www CNAME. Apex is unavailable; forward apex to www.'
            : 'DNS records are not shown for localhost, IP addresses, or .dev domains.',
        }
        return
      }

      const value = registrySnap.data() || {}
      domainRegistry[domain] = {
        ...fallback,
        ...value,
        dnsRecords: {
          ...fallback.dnsRecords,
          ...(value.dnsRecords || {}),
          www: {
            ...fallback.dnsRecords.www,
            ...(value?.dnsRecords?.www || {}),
          },
          apex: {
            ...fallback.dnsRecords.apex,
            ...(value?.dnsRecords?.apex || {}),
          },
        },
      }
    }))
  }

  return {
    project: CLOUDFLARE_PAGES_PROJECT || '',
    pagesDomain: pagesTarget,
    domainRegistry,
  }
})

exports.generateBlockFields = onCall({ timeoutSeconds: 180 }, async (request) => {
  assertCallableUser(request)
  const data = request.data || {}
  const auth = request.auth
  const { orgId, blockId, blockName, content, fields, currentValues, meta, instructions } = data
  if (!orgId || !blockId)
    throw new HttpsError('invalid-argument', 'Missing orgId or blockId')
  if (!Array.isArray(fields) || fields.length === 0)
    throw new HttpsError('invalid-argument', 'No fields selected')
  if (!OPENAI_API_KEY)
    throw new HttpsError('failed-precondition', 'OPENAI_API_KEY not set')

  const allowed = await permissionCheck(auth.uid, 'write', `organizations/${orgId}/blocks`)
  if (!allowed)
    throw new HttpsError('permission-denied', 'Not allowed to update blocks')

  const filteredFields = fields.filter(field => field.type !== 'image'
    && field.type !== 'color'
    && !/url/i.test(field.id)
    && !/color/i.test(field.id))
  if (filteredFields.length === 0)
    throw new HttpsError('invalid-argument', 'No eligible fields selected')

  const systemPrompt = 'You are a helpful assistant that writes content for CMS block fields.'
  const userPrompt = buildBlockAiPrompt({
    blockId,
    blockName,
    content,
    fields: filteredFields,
    currentValues,
    meta,
    instructions,
  })

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.6,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new HttpsError('internal', `OpenAI error ${response.status}: ${text}`)
  }

  const json = await response.json()
  const contentText = json?.choices?.[0]?.message?.content || ''
  const parsed = parseAiJson(contentText)
  if (!parsed || typeof parsed !== 'object') {
    logger.error('AI response parse failed', { contentText })
    throw new HttpsError('internal', 'Failed to parse AI response')
  }

  const allowedFields = new Set(filteredFields.map(field => field.id))
  const filtered = {}
  Object.keys(parsed).forEach((key) => {
    if (allowedFields.has(key))
      filtered[key] = parsed[key]
  })

  return {
    fields: filtered,
  }
})

exports.siteAiBootstrapEnqueue = onDocumentCreated(
  { document: 'organizations/{orgId}/sites/{siteId}', timeoutSeconds: 180 },
  async (event) => {
    const { orgId, siteId } = event.params
    if (!orgId || !siteId || siteId === 'templates')
      return
    const data = event.data?.data() || {}
    if (!data.aiAgentUserId && !data.aiInstructions)
      return
    const siteRef = db.collection('organizations').doc(orgId).collection('sites').doc(siteId)
    await siteRef.set({ aiBootstrapStatus: 'queued' }, { merge: true })
    await pubsub.topic(SITE_AI_TOPIC).publishMessage({ json: { orgId, siteId, attempt: 0 } })
    logger.info('Enqueued AI bootstrap for site', { orgId, siteId })
  },
)

exports.syncUserMetaFromPublishedSiteSettings = onDocumentWritten(
  { document: 'organizations/{orgId}/published-site-settings/{siteId}', timeoutSeconds: 180 },
  async (event) => {
    const change = event.data
    if (!change?.after?.exists)
      return

    const siteData = change.after.data() || {}
    const users = Array.isArray(siteData.users) ? siteData.users : []
    const primaryUser = users[0]
    if (!primaryUser)
      return

    const userRef = await resolveStagedUserRef(primaryUser)
    if (!userRef) {
      logger.log('syncUserMetaFromPublishedSiteSettings: no staged user found', { primaryUser })
      return
    }

    const userSnap = await userRef.get()
    const userData = userSnap.data() || {}
    const currentMeta = userData.meta || {}
    const targetMeta = pickSyncFields(siteData)
    const metaDiff = buildUpdateDiff(currentMeta, targetMeta)
    if (!Object.keys(metaDiff).length)
      return

    const updatePayload = {}
    for (const [key, value] of Object.entries(metaDiff)) {
      updatePayload[`meta.${key}`] = value
    }

    await userRef.update(updatePayload)
    logger.log('syncUserMetaFromPublishedSiteSettings: updated user meta', {
      siteId: event.params.siteId,
      orgId: event.params.orgId,
      userId: userRef.id,
      fields: Object.keys(updatePayload),
    })
  },
)

exports.ensurePublishedSiteDomains = onDocumentWritten(
  { document: 'organizations/{orgId}/published-site-settings/{siteId}', timeoutSeconds: 180 },
  async (event) => {
    const change = event.data
    if (!change?.after?.exists)
      return

    const orgId = event.params.orgId
    const siteId = event.params.siteId
    const siteRef = change.after.ref
    const siteData = change.after.data() || {}
    const beforeData = change.before?.data?.() || {}
    const rawDomains = Array.isArray(siteData.domains) ? siteData.domains : []
    const normalizedDomains = Array.from(new Set(rawDomains.map(normalizeDomain).filter(Boolean)))
    const beforeRawDomains = Array.isArray(beforeData.domains) ? beforeData.domains : []
    const beforeNormalizedDomains = Array.from(new Set(beforeRawDomains.map(normalizeDomain).filter(Boolean)))

    const removedDomains = beforeNormalizedDomains.filter(domain => !normalizedDomains.includes(domain))
    const removedOwnedDomains = []
    for (const domain of removedDomains) {
      const registryRef = db.collection(DOMAIN_REGISTRY_COLLECTION).doc(domain)
      const registrySnap = await registryRef.get()
      if (!registrySnap.exists)
        continue
      const registryData = registrySnap.data() || {}
      if (registryData.sitePath === siteRef.path) {
        await registryRef.delete()
        removedOwnedDomains.push(domain)
      }
    }

    const conflictDomains = []
    for (const domain of normalizedDomains) {
      const registryRef = db.collection(DOMAIN_REGISTRY_COLLECTION).doc(domain)
      let conflict = false

      await db.runTransaction(async (transaction) => {
        const registrySnap = await transaction.get(registryRef)
        if (!registrySnap.exists) {
          transaction.set(registryRef, {
            domain,
            orgId,
            siteId,
            sitePath: siteRef.path,
            updatedAt: Firestore.FieldValue.serverTimestamp(),
          })
          return
        }

        const registryData = registrySnap.data() || {}
        if (registryData.sitePath === siteRef.path) {
          transaction.set(registryRef, {
            domain,
            orgId,
            siteId,
            sitePath: siteRef.path,
            updatedAt: Firestore.FieldValue.serverTimestamp(),
          }, { merge: true })
          return
        }

        conflict = true
      })

      if (conflict)
        conflictDomains.push(domain)
    }

    let filteredDomains = normalizedDomains
    if (conflictDomains.length) {
      const conflictSet = new Set(conflictDomains)
      const nextRawDomains = rawDomains.filter(value => !conflictSet.has(normalizeDomain(value)))
      const conflictLabel = conflictDomains.length > 1 ? 'Domains' : 'Domain'
      const conflictSuffix = conflictDomains.length > 1 ? 'those domains' : 'that domain'
      await siteRef.set({
        domains: nextRawDomains,
        domainError: `${conflictLabel} "${conflictDomains.join(', ')}" removed because another site is already using ${conflictSuffix}.`,
      }, { merge: true })
      filteredDomains = normalizedDomains.filter(domain => !conflictSet.has(domain))
    }

    const pagesTarget = getCloudflarePagesTarget()
    const registryStateByDomain = new Map()
    const syncPlanMap = new Map()
    for (const domain of filteredDomains) {
      const dnsPayload = buildDomainDnsPayload(domain, pagesTarget)
      registryStateByDomain.set(domain, {
        ...dnsPayload,
        wwwAdded: false,
        wwwError: '',
        apexAttempted: false,
        apexAdded: false,
        apexError: '',
        dnsGuidance: dnsPayload.dnsEligible
          ? 'Add the www CNAME record. Apex is unavailable; forward apex to www.'
          : 'DNS records are not shown for localhost, IP addresses, or .dev domains.',
      })

      const apexDomain = dnsPayload.apexDomain
      if (!apexDomain)
        continue
      const existingPlan = syncPlanMap.get(apexDomain) || {
        apexDomain,
        wwwDomain: dnsPayload.wwwDomain,
        domains: new Set(),
      }
      existingPlan.domains.add(domain)
      syncPlanMap.set(apexDomain, existingPlan)
    }

    const syncPlans = Array.from(syncPlanMap.values())
      .filter(plan => shouldSyncCloudflareDomain(plan.wwwDomain))
      .map(plan => ({ ...plan, domains: Array.from(plan.domains) }))

    const removeDomains = Array.from(new Set(
      removedOwnedDomains
        .flatMap((domain) => {
          const apexDomain = getCloudflareApexDomain(domain)
          const wwwDomain = getCloudflarePagesDomain(apexDomain)
          return [wwwDomain, apexDomain]
        })
        .filter(domain => shouldSyncCloudflareDomain(domain)),
    ))
    if (removeDomains.length) {
      await Promise.all(removeDomains.map(domain => removeCloudflarePagesDomain(domain, { orgId, siteId })))
    }

    const syncResults = await Promise.all(syncPlans.map(async (plan) => {
      const wwwResult = await addCloudflarePagesDomain(plan.wwwDomain, { orgId, siteId, variant: 'www' })
      let apexAttempted = false
      let apexResult = { ok: false, error: '' }
      if (shouldSyncCloudflareDomain(plan.apexDomain)) {
        apexAttempted = true
        apexResult = await addCloudflarePagesDomain(plan.apexDomain, { orgId, siteId, variant: 'apex' })
      }
      return {
        ...plan,
        apexAttempted,
        wwwResult,
        apexResult,
      }
    }))

    for (const plan of syncResults) {
      const wwwAdded = !!plan.wwwResult?.ok
      const wwwError = wwwAdded ? '' : String(plan.wwwResult?.error || 'Failed to add www domain.')
      const apexAdded = !!plan.apexResult?.ok
      const apexError = apexAdded
        ? ''
        : (plan.apexAttempted ? String(plan.apexResult?.error || 'Failed to add apex domain.') : '')

      for (const domain of plan.domains) {
        const current = registryStateByDomain.get(domain) || buildDomainDnsPayload(domain, pagesTarget)
        const dnsGuidance = !current.dnsEligible
          ? 'DNS records are not shown for localhost, IP addresses, or .dev domains.'
          : (apexAdded
              ? 'Apex and www were added to Cloudflare Pages. Add both DNS records if your provider requires manual setup.'
              : 'Add the www CNAME record. Apex is unavailable; forward apex to www.')
        const nextDnsRecords = {
          ...(current.dnsRecords || {}),
          apex: {
            ...(current?.dnsRecords?.apex || {}),
            enabled: !!current.dnsEligible && !!current?.dnsRecords?.apex?.value && apexAdded,
          },
          www: {
            ...(current?.dnsRecords?.www || {}),
            enabled: !!current.dnsEligible && !!current?.dnsRecords?.www?.value,
          },
        }

        registryStateByDomain.set(domain, {
          ...current,
          dnsRecords: nextDnsRecords,
          wwwAdded,
          wwwError,
          apexAttempted: !!plan.apexAttempted,
          apexAdded,
          apexError,
          dnsGuidance,
        })
      }
    }

    if (registryStateByDomain.size) {
      for (const [domain, value] of registryStateByDomain.entries()) {
        const registryRef = db.collection(DOMAIN_REGISTRY_COLLECTION).doc(domain)
        const payload = {
          domain,
          orgId,
          siteId,
          sitePath: siteRef.path,
          updatedAt: Firestore.FieldValue.serverTimestamp(),
          apexDomain: value.apexDomain || '',
          wwwDomain: value.wwwDomain || '',
          dnsEligible: !!value.dnsEligible,
          apexAttempted: !!value.apexAttempted,
          apexAdded: !!value.apexAdded,
          wwwAdded: !!value.wwwAdded,
          dnsRecords: value.dnsRecords || {},
          dnsGuidance: value.dnsGuidance || '',
        }
        payload.apexError = value.apexError ? value.apexError : Firestore.FieldValue.delete()
        payload.wwwError = value.wwwError ? value.wwwError : Firestore.FieldValue.delete()
        await registryRef.set(payload, { merge: true })
      }
    }

    const failed = syncResults.filter(item => !item.wwwResult?.ok)
    if (!failed.length) {
      if (!conflictDomains.length && siteData.domainError) {
        await siteRef.set({ domainError: Firestore.FieldValue.delete() }, { merge: true })
      }
      return
    }

    const errorDomains = failed.map(item => item.wwwDomain)
    const errorDetails = failed
      .map(item => item.wwwResult?.error)
      .filter(Boolean)
      .join('; ')
    const cloudflareMessage = `Cloudflare domain sync failed for "${errorDomains.join(', ')}". ${errorDetails || 'Check function logs.'}`.trim()
    const combinedMessage = conflictDomains.length
      ? `${cloudflareMessage} Conflicts detected for "${conflictDomains.join(', ')}".`
      : cloudflareMessage
    if (siteData.domainError !== combinedMessage) {
      await siteRef.set({ domainError: combinedMessage }, { merge: true })
    }
  },
)

exports.syncSiteSettingsFromUserMeta = onDocumentWritten(
  { document: 'staged-users/{stagedId}', timeoutSeconds: 180 },
  async (event) => {
    const change = event.data
    if (!change?.after?.exists)
      return

    const beforeMeta = (change.before.data() || {}).meta || {}
    const afterMeta = (change.after.data() || {}).meta || {}
    const metaDiff = buildUpdateDiff(pickSyncFields(beforeMeta), pickSyncFields(afterMeta))
    if (!Object.keys(metaDiff).length)
      return

    const stagedId = event.params.stagedId
    const authUserId = change.after.data()?.userId
    const userIds = Array.from(new Set([stagedId, authUserId].filter(Boolean)))
    if (!userIds.length)
      return

    const matchedSites = new Map()
    for (const userId of userIds) {
      const snap = await db.collectionGroup('sites')
        .where('users', 'array-contains', userId)
        .get()

      if (snap.empty)
        continue

      for (const doc of snap.docs) {
        matchedSites.set(doc.ref.path, { doc, userId })
      }
    }

    if (!matchedSites.size)
      return

    for (const { doc, userId } of matchedSites.values()) {
      const siteData = doc.data() || {}
      const users = Array.isArray(siteData.users) ? siteData.users : []
      if (!users.length || users[0] !== userId)
        continue

      const siteUpdate = buildUpdateDiff(siteData, pickSyncFields(afterMeta))
      if (!Object.keys(siteUpdate).length)
        continue

      await doc.ref.update(siteUpdate)

      const orgDoc = doc.ref.parent.parent
      const orgId = orgDoc?.id
      const siteId = doc.id
      if (orgId) {
        const publishedRef = db.collection('organizations').doc(orgId).collection('published-site-settings').doc(siteId)
        const publishedSnap = await publishedRef.get()
        if (publishedSnap.exists) {
          await publishedRef.update(siteUpdate)
        }
      }

      logger.log('syncSiteSettingsFromUserMeta: updated site settings from user meta', {
        siteId,
        orgId: orgId || '',
        userId,
        fields: Object.keys(siteUpdate),
      })
    }
  },
)

const setAiStatus = async (siteRef, status) => {
  try {
    await siteRef.set({ aiBootstrapStatus: status }, { merge: true })
  }
  catch (err) {
    logger.warn('Failed to set AI status', { status, error: err?.message })
  }
}

exports.siteAiBootstrapWorker = onMessagePublished(
  { topic: SITE_AI_TOPIC, retry: true, timeoutSeconds: 540, memory: '1GiB' },
  async (event) => {
    const msg = event.data?.message?.json || {}
    const { orgId, siteId } = msg
    const attempt = msg.attempt || 0
    if (!orgId || !siteId || siteId === 'templates')
      return

    const siteRef = db.collection('organizations').doc(orgId).collection('sites').doc(siteId)
    const siteSnap = await siteRef.get()
    if (!siteSnap.exists)
      return
    const siteData = siteSnap.data() || {}
    if (!siteData.aiAgentUserId && !siteData.aiInstructions)
      return
    await setAiStatus(siteRef, 'running')

    const pagesRef = siteRef.collection('pages')
    let pagesSnap = await pagesRef.get()
    if (pagesSnap.empty) {
      await sleep(5000)
      pagesSnap = await pagesRef.get()
    }
    if (pagesSnap.empty) {
      if (attempt < 5) {
        await pubsub.topic(SITE_AI_TOPIC).publishMessage({ json: { orgId, siteId, attempt: attempt + 1 } })
        logger.warn('No pages found yet for AI bootstrap, requeued', { orgId, siteId, attempt })
      }
      else {
        await setAiStatus(siteRef, 'failed')
      }
      return
    }

    let agentData = null
    if (siteData.aiAgentUserId) {
      const usersRef = db.collection('organizations').doc(orgId).collection('users')
      const agentQuery = await usersRef.where('userId', '==', siteData.aiAgentUserId).limit(1).get()
      if (!agentQuery.empty) {
        agentData = agentQuery.docs[0].data()
      }
    }

    const { descriptors, descriptorMap } = buildFieldsList(pagesSnap, siteData)
    if (!descriptors.length) {
      logger.info('No eligible fields to fill for AI bootstrap', { orgId, siteId })
      return
    }

    let aiResults = {}
    try {
      aiResults = await callOpenAiForSiteBootstrap({
        siteData,
        agentData,
        instructions: siteData.aiInstructions,
        fields: descriptors,
      })
    }
    catch (err) {
      logger.error('AI bootstrap failed', { orgId, siteId, error: err?.message })
      await setAiStatus(siteRef, 'failed')
      return
    }

    const { pageUpdates, siteUpdates } = applyAiResults(descriptorMap, pagesSnap, aiResults, siteData)
    const pageIds = Object.keys(pageUpdates)
    const siteFields = Object.keys(siteUpdates)
    if (!pageIds.length && !siteFields.length) {
      logger.info('AI bootstrap returned no applicable updates', { orgId, siteId })
      await setAiStatus(siteRef, 'completed')
      return
    }

    if (siteFields.length)
      await siteRef.update(siteUpdates)

    for (const pageId of pageIds) {
      const update = pageUpdates[pageId]
      await siteRef.collection('pages').doc(pageId).update({
        content: update.content,
        postContent: update.postContent,
        metaTitle: update.metaTitle,
        metaDescription: update.metaDescription,
        structuredData: update.structuredData,
      })
    }

    logger.info('AI bootstrap applied', { orgId, siteId, pagesUpdated: pageIds.length, siteUpdated: siteFields.length > 0 })
    await setAiStatus(siteRef, 'completed')
  },
)
