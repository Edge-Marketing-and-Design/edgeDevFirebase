const permissions = {
  admin: { assign: true, delete: true, read: true, write: true },
  editor: { assign: false, delete: true, read: true, write: true },
  user: { assign: false, delete: false, read: true, write: false },
  writer: { assign: false, delete: false, read: true, write: true },
}

const canPerformActionForRoles = (roles, action, originalFilePath) => {
  const collectionPath = originalFilePath.replace(/\//g, '-')
  const roleList = Array.isArray(roles) ? roles : Object.values(roles || {})

  const isRootAdmin = roleList.some(
    role => role && role.collectionPath === '-' && role.role === 'admin',
  )
  if (isRootAdmin)
    return Boolean(permissions.admin[action])

  for (const role of roleList) {
    if (!role || typeof role.collectionPath !== 'string')
      continue
    if (collectionPath.startsWith(role.collectionPath)) {
      const rolePermissions = permissions[role.role]
      if (rolePermissions && rolePermissions[action])
        return true
    }
  }
  return false
}

module.exports = {
  canPerformActionForRoles,
  permissions,
}
