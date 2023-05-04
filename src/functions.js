// START @edge/firebase functions
exports.removeNonRegisteredUser = functions.https.onCall(async (data, context) => {
  if (data.uid === context.auth.uid) {
    const stagedUser = await db.collection('staged-users').doc(data.docId).get()
    if (stagedUser.exists) {
      const stagedUserData = stagedUser.data()

      const rolesExist = stagedUserData.roles && Object.keys(stagedUserData.roles).length !== 0
      const specialPermissionsExist = stagedUserData.specialPermissions && Object.keys(stagedUserData.specialPermissions).length !== 0
      const userIdExistsAndNotBlank = stagedUserData.userId && stagedUserData.userId !== ''

      if (!rolesExist && !specialPermissionsExist && !userIdExistsAndNotBlank) {
        await db.collection('staged-users').doc(data.docId).delete()
        return { success: true, message: '' }
      }
      else {
        let message = ''
        if (rolesExist && specialPermissionsExist) {
          message = 'Cannot delete because the non-registered user still has roles and special permissions assigned.'
        }
        else if (rolesExist) {
          message = 'Cannot delete because the non-registered user still has roles assigned.'
        }
        else if (specialPermissionsExist) {
          message = 'Cannot delete because the non-registered user still has special permissions assigned.'
        }
        else if (userIdExistsAndNotBlank) {
          message = 'Cannot delete because the user is registered.'
        }
        return { success: false, message }
      }
    }
  }
  return { success: false, message: 'Non-registered user not found.' }
})

exports.currentUserRegister = functions.https.onCall(async (data, context) => {
  if (data.uid === context.auth.uid) {
    const stagedUser = await db.collection('staged-users').doc(data.registrationCode).get()
    if (!stagedUser.exists) {
      return { success: false, message: 'Registration code not found.' }
    }
    else {
      const stagedUserData = await stagedUser.data()
      let process = false
      if (stagedUserData.isTemplate) {
        process = true
      }
      if (!stagedUserData.isTemplate && stagedUserData.userId === '') {
        process = true
      }
      if (!process) {
        return { success: false, message: 'Registration code not valid.' }
      }
      const newRoles = stagedUserData.roles || {}
      const currentUser = await db.collection('users').doc(data.uid).get()
      const currentUserData = await currentUser.data()
      const currentRoles = currentUserData.roles || {}
      const currentUserCollectionPaths = currentUserData.collectionPaths || []
      let newRole = {}
      if (stagedUserData.subCreate && Object.keys(stagedUserData.subCreate).length !== 0 && stagedUserData.isTemplate) {
        if (!data.dynamicDocumentFieldValue) {
          return { success: false, message: 'Dynamic document field value is required.' }
        }
        const rootPath = stagedUserData.subCreate.rootPath
        const newDoc = stagedUserData.subCreate.documentStructure
        newDoc[stagedUserData.subCreate.dynamicDocumentField] = data.dynamicDocumentFieldValue
        const addedDoc = await db.collection(rootPath).add(newDoc)
        await db.collection(rootPath).doc(addedDoc.id).update({ docId: addedDoc.id })
        newRole = { [`${rootPath}-${addedDoc.id}`]: { collectionPath: `${rootPath}-${addedDoc.id}`, role: stagedUserData.subCreate.role } }
      }
      const combinedRoles = { ...currentRoles, ...newRoles, ...newRole }
      Object.values(combinedRoles).forEach((role) => {
        if (!currentUserCollectionPaths.includes(role.collectionPath)) {
          currentUserCollectionPaths.push(role.collectionPath)
        }
      })
      await db.collection('staged-users').doc(currentUserData.stagedDocId).update({ roles: combinedRoles, collectionPaths: currentUserCollectionPaths })
      if (!stagedUserData.isTemplate) {
        await db.collection('staged-users').doc(data.registrationCode).delete()
      }
      return { success: true, message: '' }
    }
  }
})

exports.updateUser = functions.firestore.document('staged-users/{docId}').onUpdate((change, context) => {
  const eventId = context.eventId
  const eventRef = db.collection('events').doc(eventId)
  const stagedDocId = context.params.docId
  let newData = change.after.data()
  const oldData = change.before.data()
  return shouldProcess(eventRef).then((process) => {
    if (process) {
      // Note: we can trust on newData.uid because we are checking in rules that it matches the auth.uid
      // TODO: user might be invited to join another org with reg code.. if used when logged will combine new staged-user doc into first stage-user doc and sync to users.
      if (newData.userId) {
        const userRef = db.collection('users').doc(newData.userId)
        setUser(userRef, newData, oldData, stagedDocId).then(() => {
          return markProcessed(eventRef)
        })
      }
      else {
        if (newData.templateUserId !== oldData.templateUserId) {
          newData.isTemplate = false
          const templateUserId = newData.templateUserId
          newData.meta = newData.templateMeta
          delete newData.templateMeta
          delete newData.templateUserId
          if (Object.prototype.hasOwnProperty.call(newData, 'subCreate') && Object.values(newData.subCreate).length > 0) {
            const subCreate = newData.subCreate
            delete newData.subCreate
            db.collection(subCreate.rootPath).add({ [subCreate.dynamicDocumentField]: newData.dynamicDocumentFieldValue }).then((addedDoc) => {
              db.collection(subCreate.rootPath).doc(addedDoc.id).update({ docId: addedDoc.id }).then(() => {
                delete newData.dynamicDocumentFieldValue
                const newRole = { [`${subCreate.rootPath}-${addedDoc.id}`]: { collectionPath: `${subCreate.rootPath}-${addedDoc.id}`, role: subCreate.role } }
                if (Object.prototype.hasOwnProperty.call(newData, 'collectionPaths')) {
                  newData.collectionPaths.push(`${subCreate.rootPath}-${addedDoc.id}`)
                }
                else {
                  newData.collectionPaths = [`${subCreate.rootPath}-${addedDoc.id}`]
                }
                const newRoles = { ...newData.roles, ...newRole }
                newData = { ...newData, roles: newRoles }
                const stagedUserRef = db.collection('staged-users').doc(templateUserId)
                return stagedUserRef.set({ ...newData, userId: templateUserId }).then(() => {
                  const userRef = db.collection('users').doc(templateUserId)
                  setUser(userRef, newData, oldData, templateUserId).then(() => {
                    return markProcessed(eventRef)
                  })
                })
              })
            })
          }
          else {
            const stagedUserRef = db.collection('staged-users').doc(templateUserId)
            return stagedUserRef.set({ ...newData, userId: templateUserId }).then(() => {
              const userRef = db.collection('users').doc(templateUserId)
              setUser(userRef, newData, oldData, templateUserId).then(() => {
                return markProcessed(eventRef)
              })
            })
          }
        }
      }
      return markProcessed(eventRef)
    }
  })
})

function setUser(userRef, newData, oldData, stagedDocId) {
// IT's OK If "users" doesn't match exactly matched "staged-users" because this is only preventing
// writing from outside the @edgdev/firebase functions, so discrepancies will be rare since
// the package will prevent before it gets this far.
  return userRef.get().then((user) => {
    let userUpdate = { meta: newData.meta, stagedDocId }

    if (Object.prototype.hasOwnProperty.call(newData, 'roles')) {
      userUpdate = { ...userUpdate, roles: newData.roles }
    }
    if (Object.prototype.hasOwnProperty.call(newData, 'specialPermissions')) {
      userUpdate = { ...userUpdate, specialPermissions: newData.specialPermissions }
    }

    if (!oldData.userId) {
      userUpdate = { ...userUpdate, userId: newData.uid }
    }
    if (!user.exists) {
      return userRef.set(userUpdate)
    }
    else {
      return userRef.update(userUpdate)
    }
  })
}

function shouldProcess(eventRef) {
  return eventRef.get().then((eventDoc) => {
    return !eventDoc.exists || !eventDoc.data().processed
  })
}

function markProcessed(eventRef) {
  return eventRef.set({ processed: true }).then(() => {
    return null
  })
}
// END @edge/firebase functions