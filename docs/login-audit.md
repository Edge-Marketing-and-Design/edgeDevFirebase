# Login audit log

The package records explicit password, Microsoft, phone, custom-token and email-link
sign-in outcomes in the root `login-log` collection. It also records a separate
`application-access` outcome when the user profile/permissions are checked. Restoring
an existing Auth session does not itself create another login attempt.

Each record contains the attempted identifier (email or phone, trimmed and
lowercased), method, stage, outcome, error code, safe error description, site origin,
server creation time, and `expiresAt` 60 days later. The verified callable UID is
stored separately as `authenticatedUid`; it can be null for failures. These are
**client-reported support records**, not proof that a particular person attempted
login. Microsoft failures use the email provided in Firebase `error.customData.email`,
including account conflicts (`auth/account-exists-with-different-credential`).
Failures where the SDK provides no email (such as closing the popup) and invalid
custom tokens can still have no identifier. Tokens are never decoded for logging.

Passwords, custom tokens, verification codes, arbitrary error messages/stacks and
URL paths/query parameters are not included. Unknown error codes receive a generic
message. Firebase may return `auth/invalid-credential` without distinguishing an
unknown email from an incorrect password.

## Install and deploy

1. Update the package and allow its postinstall to copy `functions/loginAudit.js`,
   update `functions/edgeFirebase.js`, and merge the Firestore rules. Deploy the
   updated rules and the `edgeFirebase-recordLoginAttempt` and
   `edgeFirebase-getLoginLog` functions before rolling out the updated client.
2. Merge the following entries into the consumer's Firestore indexes configuration
   (preserving its existing entries), then deploy that indexes configuration:

   ```json
   {
     "indexes": [
       {
         "collectionGroup": "login-log",
         "queryScope": "COLLECTION",
         "fields": [
           { "fieldPath": "attemptedIdentifier", "order": "ASCENDING" },
           { "fieldPath": "expiresAt", "order": "DESCENDING" }
         ]
       }
     ]
   }
   ```

3. Enable TTL on `expiresAt` for **both** collection groups in the consumer project:

   ```sh
   gcloud firestore fields ttls update expiresAt --collection-group=login-log --enable-ttl --project=YOUR_PROJECT_ID
   gcloud firestore fields ttls update expiresAt --collection-group=login-log-limits --enable-ttl --project=YOUR_PROJECT_ID
   ```

   This is required: writing an expiry field alone does not delete records. TTL
   normally deletes within 24 hours of expiry and charges for deletes. Rate-limit
   documents expire after two days of inactivity. The admin query excludes expired
   log records immediately. See [Firestore TTL documentation](https://firebase.google.com/docs/firestore/ttl).

## Read the log

The Firestore console can inspect `login-log`. In an application, a signed-in
**root admin** (role `admin`, collection path `-`) can query the newest 100 unexpired
records, optionally filtered by an exact email or phone:

```typescript
const result = await edgeFirebase.getLoginLog('person@example.com');
// { records: [{ id, attemptedIdentifier, method, stage, outcome,
//              errorCode, errorMessage, site, authenticatedUid,
//              source, environment, createdAt, expiresAt }] }
```

An empty filter returns the newest 100 across all identifiers. Phone filters match
the entered phone format. Scoped organization admins cannot read this global log.
Direct client reads/writes of both collections are denied, including through the
package's generic permission rules. Consumer rules outside the managed block must
not independently grant access to these collections. No admin UI is added here.

## Limits and availability

The collector accepts signed-out requests so failed sign-ins can be recorded. It
validates fields and uses a Firestore transaction to cap accepted records at 120
per IP per hour and 10,000 per project per UTC day. Authentication and application
access are separate records and both count toward those limits. IPs are hashed for
counter keys and are not stored in the audit entries. Limits apply across function
instances; the collector also has a five-instance cap. Once capped, records are
silently dropped. Limits bound stored records, not all invocation/read charges;
this public endpoint is not a comprehensive bot defense.

Audit calls use a five-second timeout and never change the login result. They bypass
the browser Monitor wrapper. The function reporter may still report an actual
collector infrastructure failure; ordinary failed credentials are stored as data.
If the browser closes, is offline, blocks the request, or hits the limits, a record
may be missing. Nothing is retried or persisted in browser storage.

Set `EDGE_LOGIN_AUDIT=false` in the Functions environment to stop new records.
When Auth uses an emulator without a Functions emulator, client audit calls are
skipped to avoid writing local login activity into production. With Functions and
Firestore emulators configured together, records stay local and are marked
`development`. Do not run a Functions emulator against a production Firestore
instance for this feature.

## Verification

```sh
npm test
npm run typecheck
node scripts/test-login-audit-rules.cjs
```

The last command starts a temporary Firestore emulator on port 18089 with the
`demo-login-audit` project, verifies protected collections, and shuts it down. It
requires Firebase CLI and Java and refuses to reuse an occupied port. Unit tests
mock Firebase/transport; they do not perform production authentication or writes.
