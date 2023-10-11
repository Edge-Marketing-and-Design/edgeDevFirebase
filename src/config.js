const functions = require('firebase-functions')
const admin = require('firebase-admin')

admin.initializeApp()

const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { onSchedule } = require('firebase-functions/v2/scheduler')
const {
  onDocumentWritten,
  onDocumentCreated,
  onDocumentUpdated,
  onDocumentDeleted,
  Change,
  FirestoreEvent,
} = require('firebase-functions/v2/firestore')
const { logger } = require('firebase-functions/v2')
const { getFirestore } = require('firebase-admin/firestore')
const twilio = require('twilio')
const db = getFirestore()

module.exports = {
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
}

