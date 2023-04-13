// START @edge/firebase functions
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