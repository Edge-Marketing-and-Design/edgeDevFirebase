const { isDeepStrictEqual } = require('node:util')

function deny(message) {
  const error = new Error(message)
  error.code = 'permission-denied'
  throw error
}
const inside = (scope, path) => scope === path || (scope !== '-' && path.startsWith(`${scope}-`))
function canAssign(user, path) {
  if (typeof path !== 'string' || !path) return false
  const roles = Object.values(user.roles || {})
  if (roles.some(role => role?.collectionPath === '-' && role.role === 'admin')) return true
  if (roles.some(role => role?.role === 'admin' && typeof role.collectionPath === 'string' && inside(role.collectionPath, path))) return true
  return Object.values(user.specialPermissions || {}).some(permission =>
    typeof permission?.collectionPath === 'string' && permission.permissions?.assign === true &&
    (permission.collectionPath === '-' || inside(permission.collectionPath, path)))
}
function checkMaps(actor, trusted, proposed, self) {
  for (const field of ['roles', 'specialPermissions']) {
    const before = trusted[field] || {}
    if (Object.prototype.hasOwnProperty.call(proposed, field) && (!proposed[field] || typeof proposed[field] !== 'object' || Array.isArray(proposed[field]))) deny(`Invalid ${field}.`)
    const after = proposed[field] || {}
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (isDeepStrictEqual(before[key], after[key])) continue
      if (self && !Object.prototype.hasOwnProperty.call(after, key)) continue
      for (const grant of [before[key], after[key]].filter(Boolean)) {
        if (grant.collectionPath !== key || !canAssign(actor, grant.collectionPath)) deny(`Cannot assign ${field} at ${key}.`)
      }
      if (Object.prototype.hasOwnProperty.call(after, key) && (!after[key] || typeof after[key] !== 'object')) deny('Invalid permission grant.')
      if (field === 'roles' && after[key] && !['admin', 'editor', 'user', 'writer'].includes(after[key].role)) deny('Invalid role.')
    }
  }
}

async function checkUserMirrorWrite(db, event, id) {
  // This is trusted CloudEvent metadata, not a field a client can submit.
  // Existing CMS/Admin SDK writers authorize their own registration operations.
  if (event.authType === 'service_account') return
  const after = event.data.after.data()
  const before = event.data.before.data() || {}
  if (!after) return
  if (!after.uid) deny('Missing client writer identity.')
  const actorDoc = await db.collection('users').doc(after.uid).get()
  const actor = actorDoc.exists ? actorDoc.data() : {}
  if (before.userId) {
    if (after.userId !== before.userId || after.templateUserId !== before.templateUserId || Boolean(after.isTemplate) !== Boolean(before.isTemplate)) deny('Cannot redirect a registered user.')
    const targetDoc = await db.collection('users').doc(before.userId).get()
    const target = targetDoc.exists ? targetDoc.data() : {}
    if (target.stagedDocId && target.stagedDocId !== id) deny('Incorrect staged user document.')
    const self = after.uid === before.userId
    const grants = [...Object.values(target.roles || {}), ...Object.values(target.specialPermissions || {})]
    const proposed = [...Object.values(after.roles || {}), ...Object.values(after.specialPermissions || {})]
    if (!self && !canAssign(actor, '-') && ![...grants, ...proposed].some(grant => canAssign(actor, grant?.collectionPath))) deny('Cannot edit this user.')
    checkMaps(actor, target, after, self)
    return
  }
  const claiming = Boolean(after.userId) || Boolean(after.templateUserId && after.templateUserId !== before.templateUserId)
  if (claiming) {
    if ((after.userId || after.templateUserId) !== after.uid) deny('Cannot claim another identity.')
    for (const field of ['roles', 'specialPermissions', 'subCreate']) {
      if (!isDeepStrictEqual(before[field] || {}, after[field] || {})) deny(`Cannot alter invitation ${field} while registering.`)
    }
    if (Boolean(before.isTemplate) !== Boolean(after.isTemplate)) deny('Cannot alter invitation type while registering.')
    return
  }
  // No trusted user write occurs for an unclaimed invitation edit.
}
module.exports = { checkUserMirrorWrite, canAssign, checkMaps }
