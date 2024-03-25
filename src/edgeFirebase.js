/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-undef */
const { onCall, HttpsError, logger, getFirestore, functions, admin, twilio, db, onSchedule, onDocumentUpdated, pubsub } = require('./config.js')

const authToken = process.env.TWILIO_AUTH_TOKEN
const accountSid = process.env.TWILIO_SID
const systemNumber = process.env.TWILIO_SYSTEM_NUMBER


function formatPhoneNumber(phone) {
  // Remove non-numeric characters from the phone number
  const numericPhone = phone.replace(/\D/g, '')
  // Return the formatted number
  return `+1${numericPhone}`
}



// File functions:

//TODO: NEED TO WRITE WRAPPERS FOR THESE IN THE edgeFirebase.js file... UPLOAD has to do alot more... upload needs to acutall upload the file to firestorage... get the path, then pass it to the uploadFile function...
//TODO: the uploadFile funntion needs to delete the file if they don't have permission to write to the path... 

const bucketName = process.env.BUCKET_NAME
const storage = new Storage();
const bucket = storage.bucket(bucketName)

exports.uploadFile = onCall(async (request) => {
  const auth = request.auth
  if (data.uid !== auth.uid) {
    throw new functions.https.HttpsError('permission-denied', 'You do not have permission to upload files for this user.');
  }
  const tempFilesPath = `temp/${auth.uid}/`;
  const [files] = await bucket.getFiles({ prefix: tempFilesPath });
  for (const file of files) {
    const originalFilePath = file.name.replace(/-\|-/g, '/');
    const hasWritePermission = await permissionCheck(auth.uid, "write", originalFilePath);
    if (hasWritePermission) {
      // Move file to the new path
      await bucket.file(file.name).move(originalFilePath);
    } else {
      // Delete the file if no write permission
      await bucket.file(file.name).delete();
    }
  }
});

exports.downloadFile = onCall(async (request) => {
  const data = request.data;
  const auth = request.auth
  if (data.uid !== auth.uid) {
    throw new functions.https.HttpsError('permission-denied', 'You do not have permission to upload files for this user.');
  }
  // Permission check for downloading the specified file
  const canRead = await permissionCheck(auth.uid, "read", data.filePath);
  if (!canRead) {
    throw new HttpsError('permission-denied', 'You do not have permission to download this file.');
  }

  const options = {
    version: 'v4',
    action: 'read',
    expires: Date.now() + 5 * 60 * 1000, // 5 minutes
  };

  try {
    const [url] = await bucket.file(data.filePath).getSignedUrl(options);
    return { success: true, url };
  } catch (error) {
    logger.error(error);
    throw new HttpsError('internal', 'Unable to generate download URL.');
  }
});

exports.listFiles = onCall(async (request) => {
  // Validate user authentication
  const data = request.data
  const auth = request.auth
  if (data.uid !== auth.uid) {
    throw new functions.https.HttpsError('permission-denied', 'You do not have permission to upload files for this user.');
  }

  // Permission check for reading the specified directory
  const canRead = await permissionCheck(auth.uid, "read", data.directoryPath);
  if (!canRead) {
    throw new HttpsError('permission-denied', 'You do not have permission to list files in this directory.');
  }

  try {
    const [files] = await bucket.getFiles({ prefix: data.directoryPath });
    const fileList = files.map(file => file.name);
    return { success: true, fileList };
  } catch (error) {
    logger.error(error);
    throw new HttpsError('internal', 'Unable to list files.');
  }
});


exports.deleteFile = onCall(async (request) => {
  // Validate user authentication
  const data = request.data
  const auth = request.auth
  if (data.uid !== auth.uid) {
    throw new functions.https.HttpsError('permission-denied', 'You do not have permission to upload files for this user.');
  }

  // Extract filePath from the request data
  const filePath = data.filePath;

  // Perform permission check for deleting the specified file
  const canDelete = await permissionCheck(auth.uid, "delete", filePath);
  if (!canDelete) {
    throw new functions.https.HttpsError('permission-denied', 'You do not have permission to delete this file.');
  }

  try {
    // Specify your bucket name
    await storage.bucket(bucketName).file(filePath).delete();

    return { success: true, message: "File successfully deleted." };
  } catch (error) {
    console.error("Error deleting file:", error);
    throw new functions.https.HttpsError('internal', 'Failed to delete file.');
  }
});

//end file functions


exports.topicQueue = onSchedule({ schedule: 'every 1 minutes', timeoutSeconds: 180 }, async (event) => {
  const queuedTopicsRef = db.collection('topic-queue')
  const snapshot = await queuedTopicsRef.get()

  for (const doc of snapshot.docs) {
    await db.runTransaction(async (transaction) => {
      const docSnapshot = await transaction.get(doc.ref)
      if (!docSnapshot.exists) {
        throw new Error('Document does not exist!')
      }
      const docData = docSnapshot.data()
      const emailTimestamp = docData.timestamp ? docData.timestamp.toMillis() : 0
      const delayTimestamp = docData.minuteDelay ? emailTimestamp + docData.minuteDelay * 60 * 1000 : 0
      const currentTimestamp = Date.now()
      // Check if current time is beyond the timestamp + minuteDelay, or if timestamp or minuteDelay is not set
      if (emailTimestamp > currentTimestamp || currentTimestamp >= delayTimestamp || !docData.timestamp || !docData.minuteDelay) {
        // Check if topic and payload exist and are not empty
        if (docData.topic && docData.payload && typeof docData.payload === 'object' && docData.topic.trim() !== '') {
          try {
            await pubsub.topic(docData.topic).publishMessage({ data: Buffer.from(JSON.stringify(docData.payload)) })
            // Delete the document after successfully publishing the message
            transaction.delete(doc.ref)
          }
          catch (error) {
            console.error(`Error publishing message to topic ${docData.topic}:`, error)
            // Increment retry count and set new delay
            const retryCount = docData.retry ? docData.retry + 1 : 1
            if (retryCount <= 3) {
              const minuteDelay = retryCount === 1 ? 1 : retryCount === 2 ? 10 : 30
              transaction.update(doc.ref, { retry: retryCount, minuteDelay })
            }
            else {
              // Delete the document if there was an error publishing the topic after 3 retries
              transaction.delete(doc.ref)
            }
          }
        }
        // Delete the document if topic or payload does not exist or is empty
        else {
          transaction.delete(doc.ref)
        }
      }
    })
  }
})

exports.sendVerificationCode = onCall(async (request) => {
  const data = request.data
  let code = (Math.floor(Math.random() * 1000000) + 1000000).toString().substring(1)
  const phone = formatPhoneNumber(data.phone)
  
  if (phone === '+19999999999') {
    code = '123456'
  }
  else {
    try {
      const client = twilio(accountSid, authToken)
      await client.messages.create({
        body: `Your verification code is: ${code}`,
        to: phone, // the user's phone number
        from: systemNumber, // your Twilio phone number from the configuration
      })
    }
    catch (error) {
      console.log(error)
      return { success: false, error: 'Invalid Phone #' }
    }
  }

  try {
    // Use the formatted phone number as the document ID for Firestore
    await db.collection('phone-auth').doc(phone).set({
      phone,
      code,
    })
    return phone
  }
  catch (error) {
    return { success: false, error }
  }
})

exports.verifyPhoneNumber = onCall(async (request) => {
  const data = request.data
  const phone = data.phone
  const code = data.code

  // Get the phone-auth document with the given phone number
  const phoneDoc = await db.collection('phone-auth').doc(phone).get()

  if (!phoneDoc.exists) {
    return { success: false, error: 'Phone number not found.' }
  }

  const storedCode = phoneDoc.data().code

  if (storedCode !== code) {
    return { success: false, error: 'Invalid verification code.' }
  }

  // If the code matches, authenticate the user with Firebase Custom Auth
  try {
    // You would typically generate a UID based on the phone number or another system
    const uid = phone

    // Create a custom token (this can be used on the client to sign in)
    const customToken = await admin.auth().createCustomToken(uid)

    return { success: true, token: customToken }
  }
  catch (error) {
    console.error('Error creating custom token:', error)
    return { success: false, error: 'Failed to authenticate.' }
  }
})

exports.initFirestore = onCall(async (request) => {
  // checks to see of the collections 'collection-data' and 'staged-users' exist if not will seed them with data
  const collectionData = await db.collection('collection-data').get()
  const stagedUsers = await db.collection('staged-users').get()
  if (collectionData.empty) {
    // create a document with the id of '-' and one called '-default-':
    const admin = { assign: true, delete: true, read: true, write: true }
    const editor = { assign: false, delete: true, read: true, write: true }
    const writer = { assign: false, delete: false, read: true, write: true }
    const user = { assign: false, delete: false, read: true, write: false }
    await db.collection('collection-data').doc('-').set({ admin, editor, writer, user })
    await db.collection('collection-data').doc('-default-').set({ admin, editor, writer, user })
  }
  if (stagedUsers.empty) {
    const templateUser = {
      docId: 'organization-registration-template',
      isTemplate: true,
      meta: {
        name: 'Organization Registration Template',
      },
      subCreate: {
        documentStructure: {
          name: '',
        },
        dynamicDocumentField: 'name',
        role: 'admin',
        rootPath: 'organizations',
      },
      userId: '',
    }
    await db.collection('staged-users').doc('organization-registration-template').set(templateUser)
  }
})

exports.removeNonRegisteredUser = onCall(async (request) => {
  const data = request.data
  const auth = request.auth
  if (data.uid === auth.uid) {
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

exports.currentUserRegister = onCall(async (request) => {
  const data = request.data
  const auth = request.auth
  if (data.uid === auth.uid) {
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

exports.checkOrgIdExists = onCall(async (request) => {
  const data = request.data
  const orgId = data.orgId.toLowerCase()
  const orgDoc = await db.collection('organizations').doc(orgId).get()
  return { exists: orgDoc.exists }
})

const permissionCheck = async (userId, action, collectionPath) => {
  // Fetch user document
  const userDoc = await db.collection('users').doc(userId).get()
  const userData = userDoc.data()

  // Fetch roles from user data
  const roles = userData.roles || []

  // Check each role for permission
  for (const role of roles) {
    if (role.collectionPath === collectionPath) {
      // Fetch collection data
      const collectionDoc = await db.collection('collection-data').doc(collectionPath).get()
      const collectionData = collectionDoc.exists ? collectionDoc.data() : await db.collection('collection-data').doc('-default-').get().then(doc => doc.data())

      // Check if action is permitted
      if (collectionData && collectionData[role.role] && collectionData[role.role][action]) {
        return true
      }
    }
  }

  // If no permission found, return false
  return false
}

exports.deleteSelf = onCall(async (request) => {
  if (request.data.uid === request.auth.uid) {
    try {
      const userDoc = await db.collection('staged-users').doc(request.auth.uid).get()
      const userData = userDoc.data()
      const userCollectionPaths = userData.collectionPaths || []

      for (const path of userCollectionPaths) {
        const usersWithSamePath = await db.collection('staged-users').where('collectionPaths', 'array-contains', path).get()

        // If no other users have the same collection path, delete the path and all documents and collections under it
        if (usersWithSamePath.size <= 1) {
          const adjustedPath = path.replace(/-/g, '/')
          const docRef = db.doc(adjustedPath)
          const doc = await docRef.get()

          if (doc.exists) {
            // If the path is a document, delete it directly
            await docRef.delete()
          }
          else {
            // If the path is a collection, delete all documents under it
            const docsToDelete = await db.collection(adjustedPath).get()
            const batch = db.batch()
            docsToDelete.docs.forEach((doc) => {
              batch.delete(doc.ref)
            })
            await batch.commit()
          }
        }
      }

      // Delete from 'staged-users' collection
      await db.collection('staged-users').doc(request.data.uid).delete()

      // Delete from 'users' collection
      await db.collection('users').doc(request.data.uid).delete()

      // Delete the user from Firebase
      await admin.auth().deleteUser(request.data.uid)

      return { success: true }
    }
    catch (error) {
      console.error('Error deleting user:', error)
      return { success: false, error }
    }
  }
})

exports.updateUser = onDocumentUpdated({ document: 'staged-users/{docId}', timeoutSeconds: 180 }, async (event) => {
  const change = event.data
  const eventId = event.id
  const eventRef = db.collection('events').doc(eventId)
  const stagedDocId = event.params.docId
  let newData = change.after.data()
  const oldData = change.before.data()

  const shouldProcess = await eventRef.get().then((eventDoc) => {
    return !eventDoc.exists || !eventDoc.data().processed
  })

  if (!shouldProcess) {
    return null
  }

  // Note: we can trust on newData.uid because we are checking in rules that it matches the auth.uid
  if (newData.userId) {
    const userRef = db.collection('users').doc(newData.userId)
    await setUser(userRef, newData, oldData, stagedDocId)
    await markProcessed(eventRef)
  }
  else {
    if (newData.templateUserId !== oldData.templateUserId) {
      // Check if templateUserId already exists in the staged-users collection
      const stagedUserRef = db.collection('staged-users').doc(newData.templateUserId)
      const doc = await stagedUserRef.get()

      // If it exists, skip the creation process
      if (doc.exists) {
        return null
      }

      newData.isTemplate = false
      const templateUserId = newData.templateUserId
      newData.meta = newData.templateMeta
      delete newData.templateMeta
      delete newData.templateUserId
      if (Object.prototype.hasOwnProperty.call(newData, 'subCreate') && Object.values(newData.subCreate).length > 0) {
        const subCreate = newData.subCreate
        delete newData.subCreate
        let newDocId = ''
        if (Object.prototype.hasOwnProperty.call(newData, 'requestedOrgId')) {
          newDocId = newData.requestedOrgId.toLowerCase()
          delete newData.requestedOrgId
        }
        let addedDoc
        if (newDocId) {
          const docRef = db.collection(subCreate.rootPath).doc(newDocId)
          const doc = await docRef.get()
          if (!doc.exists) {
            await docRef.set({ [subCreate.dynamicDocumentField]: newData.dynamicDocumentFieldValue })
            addedDoc = docRef
          }
          else {
            addedDoc = await db.collection(subCreate.rootPath).add({ [subCreate.dynamicDocumentField]: newData.dynamicDocumentFieldValue })
          }
        }
        else {
          addedDoc = await db.collection(subCreate.rootPath).add({ [subCreate.dynamicDocumentField]: newData.dynamicDocumentFieldValue })
        }
        await db.collection(subCreate.rootPath).doc(addedDoc.id).update({ docId: addedDoc.id })
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
        await stagedUserRef.set({ ...newData, userId: templateUserId })
        const userRef = db.collection('users').doc(templateUserId)
        await setUser(userRef, newData, oldData, templateUserId)
        await markProcessed(eventRef)
      }
      else {
        const stagedUserRef = db.collection('staged-users').doc(templateUserId)
        await stagedUserRef.set({ ...newData, userId: templateUserId })
        const userRef = db.collection('users').doc(templateUserId)
        await setUser(userRef, newData, oldData, templateUserId)
        await markProcessed(eventRef)
      }
    }
  }
  await markProcessed(eventRef)
})

async function setUser(userRef, newData, oldData, stagedDocId) {
  const user = await userRef.get()
  let userUpdate = { meta: newData.meta, stagedDocId }

  if (newData.meta && newData.meta.name) {
    const publicUserRef = db.collection('public-users').doc(stagedDocId)
    const publicMeta = { name: newData.meta.name }
    publicUserRef.set({ uid: newData.uid, meta: publicMeta, collectionPaths: newData.collectionPaths, userId: stagedDocId })
  }

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
}

function markProcessed(eventRef) {
  return eventRef.set({ processed: true }).then(() => {
    return null
  })
}
