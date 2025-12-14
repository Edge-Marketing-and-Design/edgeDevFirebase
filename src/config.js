const functions = require('firebase-functions')
const { PubSub } = require('@google-cloud/pubsub')
const admin = require('firebase-admin')

const pubsub = new PubSub()

admin.initializeApp()

const { onMessagePublished } = require('firebase-functions/v2/pubsub')

const { onCall, HttpsError, onRequest } = require('firebase-functions/v2/https')
const { onSchedule } = require('firebase-functions/v2/scheduler')
const { Storage } = require('@google-cloud/storage')
const { onObjectFinalized, onObjectDeleted } = require('firebase-functions/v2/storage')
const {
  onDocumentWritten,
  onDocumentCreated,
  onDocumentUpdated,
  onDocumentDeleted,
  Change,
  FirestoreEvent,
} = require('firebase-functions/v2/firestore')
const { logger, setGlobalOptions } = require('firebase-functions/v2')
const { Firestore, getFirestore } = require('firebase-admin/firestore')
const twilio = require('twilio')
const db = getFirestore()

const defaultRegion = process.env.FIREBASE_STORE_REGION
  || 'us-west1'

setGlobalOptions({ region: defaultRegion })

// The permissionCheck function

const permissions = {
  admin: { assign: true, delete: true, read: true, write: true },
  editor: { assign: false, delete: true, read: true, write: true },
  user: { assign: false, delete: false, read: true, write: false },
  writer: { assign: false, delete: false, read: true, write: true },
}

const permissionCheck = async (userId, action, originalFilePath) => {
  // Fetch user document
  const collectionPath = originalFilePath.replace(/\//g, '-')
  const userDoc = await db.collection('users').doc(userId).get()
  if (!userDoc.exists) {
    console.log('No such user!')
    return false // Or handle as needed
  }
  const userData = userDoc.data()

  // Fetch roles from user data
  const roles = Object.values(userData.roles || {})

  for (const role of roles) {
    // Check if the role's collectionPath is a prefix of the collectionPath
    if (collectionPath.startsWith(role.collectionPath)) {
      // Use permissions object instead of fetching collection data
      const rolePermissions = permissions[role.role]
      if (rolePermissions && rolePermissions[action]) {
        return true
      }
    }
  }
  return false
}

module.exports = {
  Firestore,
  pubsub,
  onMessagePublished,
  onRequest,
  onSchedule,
  onDocumentWritten,
  onDocumentCreated,
  onDocumentUpdated,
  onDocumentDeleted,
  Change,
  FirestoreEvent,
  onCall,
  HttpsError,
  logger,
  getFirestore,
  functions,
  admin,
  twilio,
  db,
  Storage,
  permissionCheck,
  onObjectFinalized,
  onObjectDeleted,
}
