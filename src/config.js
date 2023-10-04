const functions = require('firebase-functions')
const admin = require('firebase-admin')

admin.initializeApp()

const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { logger } = require('firebase-functions/v2')
const { getFirestore } = require('firebase-admin/firestore')
const twilio = require('twilio')
const db = getFirestore()

module.exports = {
  onCall,
  HttpsError,
  logger,
  getFirestore,
  functions,
  admin,
  twilio,
  db,
}
