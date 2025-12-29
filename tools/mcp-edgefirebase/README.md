# MCP EdgeFirebase Server

Node/TypeScript MCP server that exposes stable EdgeFirebase methods as tools. This server only calls the EdgeFirebase wrapper and does not call Firebase SDKs directly.

## Setup

```bash
pnpm -C tools/mcp-edgefirebase install
pnpm -C tools/mcp-edgefirebase start
```

## Configuration

Set one of the following:

- `EDGEFIREBASE_CONFIG_JSON`: JSON string of the Firebase config object.
- Or provide individual env vars:
  - `EDGEFIREBASE_API_KEY`
  - `EDGEFIREBASE_AUTH_DOMAIN`
  - `EDGEFIREBASE_PROJECT_ID`
  - `EDGEFIREBASE_STORAGE_BUCKET`
  - `EDGEFIREBASE_MESSAGING_SENDER_ID`
  - `EDGEFIREBASE_APP_ID`
  - `EDGEFIREBASE_MEASUREMENT_ID` (optional)
  - `EDGEFIREBASE_EMULATOR_AUTH` (optional)
  - `EDGEFIREBASE_EMULATOR_FIRESTORE` (optional)
  - `EDGEFIREBASE_EMULATOR_FUNCTIONS` (optional)
  - `EDGEFIREBASE_EMULATOR_STORAGE` (optional)

Optional behavior flags:

- `EDGEFIREBASE_PERSISTENT` (`true` or `1`)
- `EDGEFIREBASE_ENABLE_POPUP_REDIRECT` (`true` or `1`)
- `EDGEFIREBASE_FUNCTIONS_REGION` (defaults to `us-central1`)

## Shared Types

`actionResponse`

```json
{
  "success": true,
  "message": "...",
  "meta": {}
}
```

`permissions`

```json
{
  "assign": true,
  "read": true,
  "write": true,
  "delete": true
}
```

`role`

```json
"admin" | "editor" | "writer" | "user"
```

`firestoreQuery`

```json
{
  "field": "status",
  "operator": "==",
  "value": "active"
}
```

`firestoreOrder`

```json
{
  "field": "created_at",
  "direction": "desc"
}
```

`newUser`

```json
{
  "roles": [{ "collectionPath": "myItems", "role": "admin" }],
  "specialPermissions": [
    {
      "collectionPath": "myItems",
      "permissions": { "assign": true, "read": true, "write": true, "delete": false }
    }
  ],
  "meta": { "firstName": "John", "lastName": "Doe" },
  "isTemplate": false,
  "customRegCode": "optional",
  "subCreate": {
    "rootPath": "organizations",
    "role": "admin",
    "dynamicDocumentFieldValue": "name",
    "documentStructure": { "name": "Example Org" }
  }
}
```

`userRegister`

```json
{
  "email": "user@example.com",
  "password": "Password1234",
  "meta": { "firstName": "John", "lastName": "Doe" },
  "registrationCode": "abc123",
  "dynamicDocumentFieldValue": "optional",
  "requestedOrgId": "optional"
}
```

`staticSearchResults`

```json
{
  "data": {},
  "pagination": [],
  "staticIsLastPage": true,
  "staticIsFirstPage": true,
  "staticCurrentPage": "",
  "total": 0
}
```

Static search sessions are stored in memory by the MCP server. Call `edgefirebase.static_search_dispose` when finished.

## Tools

### edgefirebase.run_function

Inputs:
- `functionName` (string)
- `data` (object, optional)

Outputs:
- `{ "data": <function result data> }`

Example:

```json
{
  "functionName": "sendNotification",
  "data": { "message": "Hello", "recipientId": "abc" }
}
```

### edgefirebase.update_email

Inputs:
- `newEmail` (string)

Outputs:
- `actionResponse`

Example:

```json
{ "newEmail": "new.email@example.com" }
```

### edgefirebase.log_in

Inputs:
- `email` (string)
- `password` (string)

Outputs:
- `actionResponse` with `meta.user` snapshot

Example:

```json
{ "email": "user@example.com", "password": "Password1234" }
```

### edgefirebase.log_in_with_microsoft

Inputs:
- `providerScopes` (string[], optional)

Outputs:
- `actionResponse` with `meta.user` snapshot

Example:

```json
{ "providerScopes": ["mail.read", "calendars.read"] }
```

### edgefirebase.log_out

Inputs:
- none

Outputs:
- `actionResponse`

Example:

```json
{}
```

### edgefirebase.send_password_reset

Inputs:
- `email` (string)

Outputs:
- `actionResponse`

Example:

```json
{ "email": "user@example.com" }
```

### edgefirebase.password_reset

Inputs:
- `newPassword` (string)
- `passwordResetCode` (string)

Outputs:
- `actionResponse`

Example:

```json
{ "newPassword": "NewPassword123", "passwordResetCode": "AAaaAABaaaaAAABBBaaaBBBBAaaaaBABAbbaa" }
```

### edgefirebase.set_password

Inputs:
- `oldPassword` (string)
- `newPassword` (string)

Outputs:
- `actionResponse`

Example:

```json
{ "oldPassword": "old-password", "newPassword": "new-password" }
```

### edgefirebase.set_user_meta

Inputs:
- `meta` (object)
- `userId` (string, optional)
- `stagedDocId` (string, optional)

Outputs:
- `actionResponse`

Example:

```json
{ "meta": { "lastName": "Smith" } }
```

### edgefirebase.add_user

Inputs:
- `newUser` (`newUser`)

Outputs:
- `actionResponse`

Example:

```json
{
  "newUser": {
    "roles": [{ "collectionPath": "myItems", "role": "admin" }],
    "specialPermissions": [],
    "meta": { "firstName": "Jane", "lastName": "Doe" }
  }
}
```

### edgefirebase.register_user

Inputs:
- `userRegister` (`userRegister`)
- `authProvider` (string, optional)
- `providerScopes` (string[], optional)

Outputs:
- `actionResponse`

Example:

```json
{
  "userRegister": {
    "email": "user@example.com",
    "password": "Password1234",
    "meta": { "firstName": "John", "lastName": "Doe" },
    "registrationCode": "abc123"
  },
  "authProvider": "email"
}
```

### edgefirebase.current_user_register

Inputs:
- `userRegister` object with:
  - `registrationCode` (string)
  - `dynamicDocumentFieldValue` (string, optional)

Outputs:
- `actionResponse`

Example:

```json
{
  "userRegister": {
    "registrationCode": "12345",
    "dynamicDocumentFieldValue": "fieldName"
  }
}
```

### edgefirebase.remove_user

Inputs:
- `docId` (string)

Outputs:
- `actionResponse`

Example:

```json
{ "docId": "staged-user-id" }
```

### edgefirebase.delete_self

Inputs:
- none

Outputs:
- `actionResponse`

Example:

```json
{}
```

### edgefirebase.store_collection_permissions

Inputs:
- `collectionPath` (string)
- `role` (`role`)
- `permissions` (`permissions`)

Outputs:
- `actionResponse`

Example:

```json
{
  "collectionPath": "myItems/subitems/things",
  "role": "user",
  "permissions": { "assign": false, "read": true, "write": false, "delete": false }
}
```

### edgefirebase.remove_collection_permissions

Inputs:
- `collectionPath` (string)

Outputs:
- `actionResponse`

Example:

```json
{ "collectionPath": "myItems/subitems/things" }
```

### edgefirebase.store_user_roles

Inputs:
- `docId` (string)
- `collectionPath` (string)
- `role` (`role`)

Outputs:
- `actionResponse`

Note: This tool calls the existing EdgeFirebase `storeUserRoles` method (declared private in the class but used in the project).
Example:

```json
{ "docId": "staged-user-id", "collectionPath": "myItems", "role": "editor" }
```

### edgefirebase.remove_user_roles

Inputs:
- `docId` (string)
- `collectionPath` (string)

Outputs:
- `actionResponse`

Example:

```json
{ "docId": "staged-user-id", "collectionPath": "myItems" }
```

### edgefirebase.store_user_special_permissions

Inputs:
- `docId` (string)
- `collectionPath` (string)
- `permissions` (`permissions`)

Outputs:
- `actionResponse`

Example:

```json
{
  "docId": "staged-user-id",
  "collectionPath": "myItems",
  "permissions": { "assign": true, "read": true, "write": false, "delete": false }
}
```

### edgefirebase.remove_user_special_permissions

Inputs:
- `docId` (string)
- `collectionPath` (string)

Outputs:
- `actionResponse`

Example:

```json
{ "docId": "staged-user-id", "collectionPath": "myItems" }
```

### edgefirebase.start_users_snapshot

Inputs:
- `collectionPath` (string, optional)

Outputs:
- `actionResponse`

Example:

```json
{ "collectionPath": "myItems" }
```

### edgefirebase.start_snapshot

Inputs:
- `collectionPath` (string)
- `queryList` (`firestoreQuery[]`, optional)
- `orderList` (`firestoreOrder[]`, optional)
- `max` (number, optional)

Outputs:
- `actionResponse`

Example:

```json
{
  "collectionPath": "myItems",
  "queryList": [{ "field": "status", "operator": "==", "value": "active" }],
  "orderList": [{ "field": "created_at", "direction": "desc" }],
  "max": 10
}
```

### edgefirebase.start_document_snapshot

Inputs:
- `collectionPath` (string)
- `docId` (string)

Outputs:
- `actionResponse`

Example:

```json
{ "collectionPath": "myItems", "docId": "exampleDocId" }
```

### edgefirebase.stop_snapshot

Inputs:
- `collectionPath` (string)

Outputs:
- `actionResponse`

Example:

```json
{ "collectionPath": "myItems" }
```

### edgefirebase.store_doc

Inputs:
- `collectionPath` (string)
- `item` (object)

Outputs:
- `actionResponse`

Example:

```json
{ "collectionPath": "myItems", "item": { "name": "John Doe" } }
```

### edgefirebase.change_doc

Inputs:
- `collectionPath` (string)
- `docId` (string)
- `item` (object)

Outputs:
- `actionResponse`

Example:

```json
{ "collectionPath": "myItems", "docId": "abc123", "item": { "status": "active" } }
```

### edgefirebase.get_doc_data

Inputs:
- `collectionPath` (string)
- `docId` (string)

Outputs:
- Document data object (with `docId` added) or `actionResponse` on failure

Example:

```json
{ "collectionPath": "myItems", "docId": "abc123" }
```

### edgefirebase.remove_doc

Inputs:
- `collectionPath` (string)
- `docId` (string)

Outputs:
- `actionResponse`

Example:

```json
{ "collectionPath": "myItems", "docId": "abc123" }
```

### edgefirebase.static_search_start

Inputs:
- `collectionPath` (string)
- `queryList` (`firestoreQuery[]`, optional)
- `orderList` (`firestoreOrder[]`, optional)
- `max` (number, optional)

Outputs:
- `{ "searchId": "...", "results": staticSearchResults }`

Example:

```json
{
  "collectionPath": "myItems",
  "queryList": [{ "field": "title", "operator": "==", "value": "Cool Thing" }],
  "orderList": [{ "field": "title", "direction": "asc" }],
  "max": 10
}
```

### edgefirebase.static_search_next

Inputs:
- `searchId` (string)

Outputs:
- `{ "searchId": "...", "results": staticSearchResults }`

Example:

```json
{ "searchId": "search_1700000000000_1" }
```

### edgefirebase.static_search_prev

Inputs:
- `searchId` (string)

Outputs:
- `{ "searchId": "...", "results": staticSearchResults }`

Example:

```json
{ "searchId": "search_1700000000000_1" }
```

### edgefirebase.static_search_results

Inputs:
- `searchId` (string)

Outputs:
- `{ "searchId": "...", "results": staticSearchResults }`

Example:

```json
{ "searchId": "search_1700000000000_1" }
```

### edgefirebase.static_search_dispose

Inputs:
- `searchId` (string)

Outputs:
- `actionResponse`

Example:

```json
{ "searchId": "search_1700000000000_1" }
```

## VS Code MCP config example

```json
{
  "mcp.servers": {
    "edgefirebase": {
      "command": "pnpm",
      "args": ["-C", "tools/mcp-edgefirebase", "start"],
      "env": {
        "EDGEFIREBASE_API_KEY": "...",
        "EDGEFIREBASE_AUTH_DOMAIN": "...",
        "EDGEFIREBASE_PROJECT_ID": "...",
        "EDGEFIREBASE_STORAGE_BUCKET": "...",
        "EDGEFIREBASE_MESSAGING_SENDER_ID": "...",
        "EDGEFIREBASE_APP_ID": "...",
        "EDGEFIREBASE_FUNCTIONS_REGION": "us-central1"
      }
    }
  }
}
```

## .codex/config.toml snippet

```toml
[mcp_servers.edgefirebase]
command = "pnpm"
args = ["-C", "tools/mcp-edgefirebase", "start"]

[mcp_servers.edgefirebase.env]
EDGEFIREBASE_API_KEY = "..."
EDGEFIREBASE_AUTH_DOMAIN = "..."
EDGEFIREBASE_PROJECT_ID = "..."
EDGEFIREBASE_STORAGE_BUCKET = "..."
EDGEFIREBASE_MESSAGING_SENDER_ID = "..."
EDGEFIREBASE_APP_ID = "..."
EDGEFIREBASE_FUNCTIONS_REGION = "us-central1"
```
