const AWS = require('aws-sdk')
const FormData = require('form-data')
const fetch = require('node-fetch')

const { onCall, HttpsError, logger, getFirestore, functions, admin, twilio, db, onSchedule, onDocumentUpdated, pubsub, Storage, permissionCheck, onObjectFinalized, onObjectDeleted, onDocumentDeleted } = require('./config.js')
const authToken = process.env.TWILIO_AUTH_TOKEN
const accountSid = process.env.TWILIO_SID
const systemNumber = process.env.TWILIO_SYSTEM_NUMBER

function formatPhoneNumber(phone) {
  // Remove non-numeric characters from the phone number
  const numericPhone = phone.replace(/\D/g, '')
  // Return the formatted number
  return `+1${numericPhone}`
}

exports.uploadDocumentDeleted = onDocumentDeleted(
  { document: 'organizations/{orgId}/files/{docId}', timeoutSeconds: 180 },
  async (event) => {
    const fileData = event.data.data()
    const filePath = fileData.filePath
    // Check if the file exists in the bucket
    const bucket = admin.storage().bucket()
    const [exists] = await bucket.file(filePath).exists()
    if (exists) {
      // Delete the file if it exists
      await bucket.file(filePath).delete()
      console.log(`File deleted: ${filePath}`)
    }
    else {
      console.log(`File not found: ${filePath}`)
    }
  },
)

exports.addUpdateFileDoc = onCall(async (request) => {
  const data = request.data
  const auth = request.auth
  let docId = data?.docId
  if (data.uid === auth.uid) {
    console.log(data)
    const orgId = data.orgId
    if (docId) {
      const docRef = db.collection(`organizations/${orgId}/files`).doc(docId)
      await docRef.set(data, { merge: true })
    }
    else {
      const docRef = db.collection(`organizations/${orgId}/files`).doc()
      await docRef.set(data)
      docId = docRef.id
    }
  }
  console.log(docId)
  return { docId }
})

const deleteR2File = async (filePath) => {
  const r2 = new AWS.S3({
    endpoint: process.env.CLOUDFLARE_R2_ENDPOINT, // e.g., "https://<account-id>.r2.cloudflarestorage.com"
    accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
    region: 'auto', // Cloudflare R2 uses "auto" for region
  })
  const params = {
    Bucket: 'files',
    Key: filePath,
  }
  try {
    await r2.deleteObject(params).promise()
    console.log(`File deleted from Cloudflare R2: ${filePath}`)
  }
  catch (error) {
    console.error('Error deleting file from Cloudflare R2:', error)
  }
}

exports.fileDeleted = onObjectDeleted({ region: process.env.FIREBASE_STORAGE_BUCKET_REGION }, async (event) => {
  const docId = event.data.metadata?.fileDocId
  const toR2 = event.data.metadata?.toR2
  const cloudflareImageId = event.data.metadata?.cloudflareImageId
  const cloudflareVideoId = event.data.metadata?.cloudflareVideoId
  const r2ProcessCompleted = event.data.metadata?.r2ProcessCompleted
  if (cloudflareImageId) {
    await deleteCloudflareImage(cloudflareImageId)
  }
  if (cloudflareVideoId) {
    await deleteCloudflareVideo(cloudflareVideoId)
  }
  if (toR2) {
    if (r2ProcessCompleted === 'true') {
      await deleteR2File(event.data.metadata?.r2FilePath)
    }
    else {
      return
    }
  }
  if (docId) {
    const orgId = event.data.metadata?.orgId
    const docRef = db.collection(`organizations/${orgId}/files`).doc(docId)
    const docSnapshot = await docRef.get()
    if (docSnapshot.exists) {
      console.log('Deleting file document:', docId)
      await docRef.delete()
    }
    else {
      console.log('File document not found:', docId)
    }
  }
})

exports.toR2 = onObjectFinalized(
  {
    bucket: process.env.FIREBASE_STORAGE_BUCKET,
    region: process.env.FIREBASE_STORAGE_BUCKET_REGION,
    memory: '2GiB',
    cpu: 2,
    timeoutSeconds: 540,
  }, async (event) => {
    const toR2 = event.data.metadata?.toR2
    if (toR2) {
      const r2 = new AWS.S3({
        endpoint: process.env.CLOUDFLARE_R2_ENDPOINT, // e.g., "https://<account-id>.r2.cloudflarestorage.com"
        accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
        region: 'auto', // Cloudflare R2 uses "auto" for region
      })
      const fileBucket = event.data.bucket // Storage bucket containing the file.
      const filePath = event.data.name // File path in the bucket.
      const r2FilePath = `${process.env.FIREBASE_STORAGE_BUCKET}/${event.data.metadata?.filePath}`
      const r2URL = `${process.env.CLOUDFLARE_R2_PUBLIC_URL}/${r2FilePath}`
      const fileName = event.data.metadata?.fileName // File name.
      const fileSize = event.data.metadata?.fileSize
      const contentType = event.data.contentType // File content type.

      // Download file into memory from bucket.
      const bucket = admin.storage().bucket(fileBucket)

      const fileStream = bucket.file(filePath).createReadStream()

      // const downloadResponse = await bucket.file(filePath).download()
      // const file = downloadResponse[0]

      // Upload the file to Cloudflare R2.
      const params = {
        Bucket: 'files',
        Key: r2FilePath,
        Body: fileStream,
        ContentType: contentType,
      }
      const fileRef = bucket.file(filePath)
      try {
        await r2.upload(params).promise()

        const fileDocId = event.data.metadata?.fileDocId
        const orgId = event.data.metadata?.orgId
        const docRef = db.collection(`organizations/${orgId}/files`).doc(fileDocId)
        await docRef.set({ r2FilePath, r2URL, uploadCompletedToR2: true }, { merge: true })

        // const base64Image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/wcAAgAB/ax3OTkAAAAASUVORK5CYII='
        // const imageBuffer = Buffer.from(base64Image, 'base64')

        // await fileRef.save(imageBuffer, {
        //   contentType: 'image/png',
        // })

        const blankBuffer = Buffer.from('')
        await fileRef.save(blankBuffer, {
          contentType: 'application/octet-stream',
        })

        // Step 2: Update metadata with additional fields
        let updatedMetadata = {
          metadata: {
            ...event.data.metadata,
            r2FilePath,
            r2URL,
            uploadCompletedToR2: 'true', // Add custom metadata after file save
            r2ProcessCompleted: 'true',
          },
        }
        if (contentType.startsWith('image/') && process.env.CF_IMAGES_TOKEN) {
          try {
            const cloudflareImage = await uploadToCloudflareImage({
              r2FilePath,
              r2URL,
              fileDocId,
              orgId,
              fileName,
              fileSize,
            })

            updatedMetadata = {
              metadata: {
                ...event.data.metadata,
                r2FilePath,
                r2URL,
                uploadCompletedToR2: 'true', // Add custom metadata after file save
                r2ProcessCompleted: 'true',
                cloudflareImageId: cloudflareImage.id,
                cloudflareImageVariants: cloudflareImage.variants,
                cloudflareUploadCompleted: true,
              },
            }
            await docRef.set({ cloudflareImageId: cloudflareImage.id, cloudflareImageVariants: cloudflareImage.variants, cloudflareUploadCompleted: true }, { merge: true })
          }
          catch (e) {
            console.error('Cloudflare Image Upload Failed', e)
          }
        }

        if (contentType.startsWith('video/') && process.env.CF_IMAGES_TOKEN) {
          try {
            const cloudflareVideo = await uploadToCloudflareVideo({
              r2FilePath,
              r2URL,
              fileDocId,
              orgId,
              fileName,
              fileSize,
            })
            console.log(cloudflareVideo)
            updatedMetadata = {
              metadata: {
                ...event.data.metadata,
                r2FilePath,
                r2URL,
                uploadCompletedToR2: 'true', // Add custom metadata after file save
                r2ProcessCompleted: 'true',
                cloudflareVideoId: cloudflareVideo.id,
                cloudflareVideoPlayback: cloudflareVideo.playback,
                cloudflareVideoThumbnail: cloudflareVideo.thumbnail,
                cloudflareVideoPreview: cloudflareVideo.preview,
                cloudflareUploadCompleted: true,
              },
            }
            await docRef.set({ cloudflareVideoId: cloudflareVideo.id, cloudflareVideoPlayback: cloudflareVideo.playback, cloudflareVideoThumbnail: cloudflareVideo.thumbnail, cloudflareVideoPreview: cloudflareVideo.preview, cloudflareUploadCompleted: true }, { merge: true })
          }
          catch (e) {
            console.error('Cloudflare Video Upload Failed', e)
          }
        }
        await fileRef.setMetadata(updatedMetadata)
        console.log(`File uploaded to Cloudflare R2: ${fileName}`)
      }
      catch (error) {
        const updatedMetadata = {
          metadata: {
            ...event.data.metadata,
            uploadCompletedToR2: 'false',
            r2ProcessCompleted: 'true',
          },
        }
        await fileRef.setMetadata(updatedMetadata)
        console.error('Error uploading file to Cloudflare R2:', error)
      }
    }
  })

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
  // checks to see of the collections 'staged-users' exist if not will seed them with data
  const stagedUsers = await db.collection('staged-users').get()
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

async function uploadToCloudflareImage({ r2FilePath, r2URL, fileDocId, orgId, fileName, fileSize }) {
  const cleanedr2FilePath = r2FilePath.replaceAll('/', '-').replace('.firebasestorage.app-organizations', '')
  const metadata = {
    orgId,
    fileDocId,
    fileName: cleanedr2FilePath,
    fileSize,
  }

  const API_TOKEN = process.env.CF_IMAGES_TOKEN
  const ACCOUNT_ID = process.env.CF_ACCOUNT_ID

  const formData = new FormData()
  formData.append('url', r2URL)
  formData.append('metadata', JSON.stringify(metadata))
  formData.append('id', cleanedr2FilePath)

  const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/images/v1`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      ...formData.getHeaders(),
    },
    body: formData,
  },
  )

  const result = await response.json()

  const { result: imageData, success, errors } = result

  if (!success) {
    const errorMessages = (errors || [])
      .map(error => (error.message ? error.message : 'Unknown error'))
      .join('; ')
    throw new Error(`Cloudflare upload failed: ${errorMessages}`)
  }

  return {
    id: imageData.id,
    variants: imageData.variants,
    meta: imageData.meta || {},
  }
}

async function deleteCloudflareImage(imageId) {
  const API_TOKEN = process.env.CF_IMAGES_TOKEN
  const ACCOUNT_ID = process.env.CF_ACCOUNT_ID

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/images/v1/${imageId}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
      },
    },
  )

  if (!response.ok) {
    throw new Error(`Failed to delete Cloudflare image: ${response.statusText}`)
  }

  return true
}

async function uploadToCloudflareVideo({ r2FilePath, r2URL, fileDocId, orgId, fileSize }) {
  const API_TOKEN = process.env.CF_IMAGES_TOKEN
  const ACCOUNT_ID = process.env.CF_ACCOUNT_ID

  const cleanedr2FilePath = r2FilePath
    .replaceAll('/', '-')
    .replace('.firebasestorage.app-organizations', '')

  const metadata = {
    orgId,
    fileDocId,
    fileName: cleanedr2FilePath,
    fileSize,
  }

  const body = {
    url: r2URL,
    meta: {
      name: cleanedr2FilePath,
      ...metadata,
    },
    allowDownloads: true,
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/stream/copy`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  )

  const result = await response.json()

  if (!result.success) {
    const errorMessages = (result.errors || [])
      .map(error => error.message || 'Unknown error')
      .join('; ')
    throw new Error(`Cloudflare Stream upload failed: ${errorMessages}`)
  }
  console.log(result.result)
  const { uid, preview, playback, thumbnail } = result.result

  return {
    id: uid,
    preview,
    playback,
    thumbnail,
  }
}

async function deleteCloudflareVideo(videoId) {
  const API_TOKEN = process.env.CF_IMAGES_TOKEN
  const ACCOUNT_ID = process.env.CF_ACCOUNT_ID

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/stream/${videoId}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
      },
    },
  )

  if (!response.ok) {
    throw new Error(`Failed to delete Cloudflare video: ${response.statusText}`)
  }

  return true
}
