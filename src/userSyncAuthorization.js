const { isDeepStrictEqual: equal } = require('node:util')

// Stored under events, which the package rules already deny to all clients.
const approvalRef = (db, id) => db.collection('events').doc(`user-sync-approval-${id}`)
const map = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const denied = message => {
  const error = new Error(message)
  error.code = 'permission-denied'
  throw error
}
const contains = (scope, path) => scope === path || (scope !== '-' && path.startsWith(`${scope}-`))
function canAssign(user, path) {
  if (typeof path !== 'string' || !path) return false
  if (Object.values(map(user.roles)).some(role => role?.collectionPath === '-' && role.role === 'admin')) return true
  if (Object.values(map(user.roles)).some(role => role?.role === 'admin' && typeof role.collectionPath === 'string' && contains(role.collectionPath, path))) return true
  return Object.values(map(user.specialPermissions)).some(permission =>
    typeof permission?.collectionPath === 'string' &&
    (permission.collectionPath === '-' || contains(permission.collectionPath, path)) && permission.permissions?.assign === true)
}
function validatePermissions(actor, baseline, proposed, self) {
  for (const field of ['roles', 'specialPermissions']) {
    if (proposed[field] !== undefined && (proposed[field] === null || typeof proposed[field] !== 'object' || Array.isArray(proposed[field]))) denied(`Invalid ${field}.`)
    const before = map(baseline[field])
    const after = map(proposed[field])
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (equal(before[key], after[key])) continue
      // Existing API explicitly permits users to remove their own grants.
      if (self && !(key in after)) continue
      if (key in after && (!after[key] || typeof after[key] !== 'object' || Array.isArray(after[key]))) denied('Invalid permission grant.')
      for (const grant of [before[key], after[key]].filter(Boolean)) {
        if (grant.collectionPath !== key || !canAssign(actor, grant.collectionPath)) denied(`Cannot assign ${field} at ${key}.`)
      }
      if (field === 'roles' && after[key] && !['admin', 'editor', 'user', 'writer'].includes(after[key].role)) denied('Invalid role.')
    }
  }
}
const paths = data => [...new Set([...Object.values(map(data.roles)), ...Object.values(map(data.specialPermissions))].map(grant => grant.collectionPath))]
function validateTemplate(actor, before, after, bootstrap) {
  if (bootstrap || !equal(before.subCreate || {}, after.subCreate || {})) {
    for (const config of [before.subCreate, after.subCreate].filter(config => config && Object.keys(config).length)) {
      if (!canAssign(actor, config.rootPath?.replace(/\//g, '-')) || !['admin', 'editor', 'user', 'writer'].includes(config.role)) denied('Cannot assign registration template grants.')
    }
  }
}

// The staged uid is enforced against request.auth.uid by the existing rules.
// Never take authorization roles or the permission baseline from staged data.
async function authorizeStage(db, id, after, before, mirror, version) {
  return db.runTransaction(async transaction => {
    if (version) {
      const current = await transaction.get(db.collection('staged-users').doc(id))
      if (!current.exists || !current.updateTime.isEqual(version)) return { ignored: true }
    }
    const actorDoc = after.uid ? await transaction.get(db.collection('users').doc(after.uid)) : null
    const actor = actorDoc?.exists ? actorDoc.data() : {}
    if (before.userId) {
      if (after.userId !== before.userId || after.templateUserId !== before.templateUserId || Boolean(after.isTemplate) !== Boolean(before.isTemplate)) denied('Cannot change registered identity.')
      const userRef = db.collection('users').doc(before.userId)
      const targetDoc = await transaction.get(userRef)
      const target = targetDoc.exists ? targetDoc.data() : {}
      if (target.stagedDocId && target.stagedDocId !== id) denied('Staged document does not belong to this user.')
      const self = after.uid === before.userId
      if (!self && !canAssign(actor, '-') && ![...paths(target), ...paths(after)].some(path => canAssign(actor, path))) denied('Cannot edit this user.')
      validatePermissions(actor, target, after, self)
      const safe = { ...after, collectionPaths: paths(after) }
      await mirror(transaction, userRef, safe)
      return { mirrored: true, data: safe }
    }
    const ref = approvalRef(db, id)
    const approvedDoc = await transaction.get(ref)
    const baseline = approvedDoc.exists ? approvedDoc.data().approved : { roles: {}, specialPermissions: {} }
    const claiming = Boolean(after.userId) || Boolean(after.templateUserId && after.templateUserId !== before.templateUserId)
    if (claiming) {
      if (!approvedDoc.exists) denied('Invitation needs administrator approval before registration.')
      const target = after.userId || after.templateUserId
      if (baseline.userId && baseline.userId !== target) denied('Invitation already claimed.')
      if (target !== after.uid || Boolean(after.isTemplate) !== Boolean(baseline.isTemplate)) denied('Cannot claim this identity.')
      if ((baseline.isTemplate && after.userId) || (!baseline.isTemplate && !after.userId)) denied('Invalid invitation claim.')
      for (const field of ['roles', 'specialPermissions', 'subCreate']) {
        if (!equal(after[field] || {}, baseline[field] || {})) denied(`Cannot change invitation ${field} while claiming it.`)
      }
      const targetRef = db.collection('users').doc(target)
      const existing = await transaction.get(targetRef)
      if (existing.exists && existing.data().stagedDocId !== id) denied('Account already registered.')
      const safe = { ...after, roles: map(baseline.roles), specialPermissions: map(baseline.specialPermissions), subCreate: baseline.subCreate || {}, collectionPaths: paths(baseline) }
      if (after.userId) {
        await mirror(transaction, targetRef, safe)
        transaction.set(ref, { approved: { ...baseline, userId: target } })
      }
      return { mirrored: Boolean(after.userId), data: safe }
    }
    // Bootstrap existing invitations only through an authorized administrator
    // edit. Validate every grant, even when unchanged in the staged event.
    validatePermissions(actor, baseline, after, false)
    validateTemplate(actor, baseline, after, !approvedDoc.exists)
    if (approvedDoc.exists && Boolean(baseline.isTemplate) !== Boolean(after.isTemplate)) {
      validatePermissions(actor, {}, baseline, false)
      validatePermissions(actor, {}, after, false)
    }
    const emptyInvitation = !paths(after).length && !Object.keys(after.subCreate || {}).length
    const canApproveEmpty = emptyInvitation && paths(actor).some(path => canAssign(actor, path))
    if (!after.uid || (!paths(after).some(path => canAssign(actor, path)) && !canAssign(actor, after.subCreate?.rootPath || '-') && !canApproveEmpty)) denied('Cannot approve this invitation.')
    transaction.set(ref, { approved: { ...after, collectionPaths: paths(after) } })
    return { mirrored: false, data: after }
  })
}
async function approvedInvitation(db, id) {
  const doc = await approvalRef(db, id).get()
  if (!doc.exists) denied('Invitation needs administrator approval before registration.')
  return doc.data().approved
}
module.exports = { authorizeStage, approvedInvitation, approvalRef, canAssign, validatePermissions }
