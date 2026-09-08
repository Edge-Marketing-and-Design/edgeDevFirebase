require('dotenv').config({ path: process.env.NODE_ENV === 'production' ? '.env.prod' : '.env.dev' })

// START @edge/firebase functions
exports.edgeFirebase = require('./edgeFirebase')
exports.cms = require('./cms')
// END @edge/firebase functions
