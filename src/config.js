/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-undef */
const functions = require('firebase-functions')
const { PubSub } = require('@google-cloud/pubsub')
const admin = require('firebase-admin')

const pubsub = new PubSub()

admin.initializeApp()

const { onMessagePublished } = require('firebase-functions/v2/pubsub')

const { onCall, HttpsError, onRequest } = require('firebase-functions/v2/https')
const { onSchedule } = require('firebase-functions/v2/scheduler')
const { Storage } = require('@google-cloud/storage')
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
}
