# @edgedev/firebase

A Vue 3 / Nuxt 3 Plugin or Nuxt 3 global composable for Firebase authentication and Firestore.

### Table of Contents
**[Installation](#installation)**  
**[User Management and Collection Permissions](#user-management-and-collection-permissions)**  
**[Firebase Authentication](#firebase-authentication)**  
**[Firestore Basic Document Interactions](#firestore-basic-document-interactions)**  
**[Firestore Snapshot Listeners](#firestore-snapshot-listeners)**  
**[Firestore Static Collection Data](#firestore-static-collection-data)**  
**[Run a Cloud Function](#run-a-cloud-function)**  
**[Await and response](#responses)**  
**[Firestore Rules](#firestore-rules)**

Before diving into the documentation, it's important to note that when using this package, you should always use `await` or wait for promises to resolve. This ensures that the Rule Helpers work correctly and provides the necessary information for verifying user access rights. Failing to wait for promises may lead to inconsistencies in access control and unexpected behavior in your application. For more information about how this class handles user permissions, please refer to the section below: **Rule Helpers: Managing User Permissions in Firestore**.

# Installation

Install using pnpm:

```bash
pnpm install @edgedev/firebase
```

### Installing with Nuxt 3 global composables

Add a file (e.g., whatever.ts) to your "composables" folder with this code:

```typescript
import { EdgeFirebase } from "@edgedev/firebase";
const config = {
    apiKey: "your-apiKey",
    authDomain: "your-authDomain",
    projectId: "your-projectId",
    storageBucket: "your-storageBucket",
    messagingSenderId: "your-messagingSenderId",
    appId: "your-appId",
    emulatorAuth: "",  // Local emulator port for auth emulator
    emulatorFirestore: "", // Local emulator port for Firestore emulator
    emulatorFunctions: "", // Local emulator port for functions emulator, used to test Cloud Functions locally.
  };
const isPersistant = true // If "persistence" is true, login will be saved locally, they can close their browser and when they open they will be logged in automatically.  If "persistence" is false login saved only for the session.
const edgeFirebase = new EdgeFirebase(config, isPersistant);
export { edgeFirebase };
```

##### *Nuxt must be configured with SSR disabled, update the nuxt.config.ts file (if other parts of your project SSR, see Nuxt 3 plugin instuctions):
```javascript
export default defineNuxtConfig({ ssr: false });
```

### Installing as a plugin

#### Vue 3 plugin, main.js example:

```javascript
import { createApp } from "vue";
import App from "./App.vue";

// EdgeFirebase Plugin 
import eFb from "@edgedev/firebase";
const isPersistant = true // If "persistence" is true, login will be saved locally, they can close their browser and when they open they will be logged in automatically.  If "persistence" is false, login saved only for the session.
app.use(eFb, {
    apiKey: "your-apiKey",
    authDomain: "your-authDomain",
    projectId: "your-projectId",
    storageBucket: "your-storageBucket",
    messagingSenderId: "your-messagingSenderId",
    appId: "your-appId",
    emulatorAuth: "",  // Local emulator port for auth emulator
    emulatorFirestore: "", // Local emulator port for Firestore emulator
    emulatorFunctions: "", // Local emulator port for functions emulator, used to test Cloud Functions locally.
  }, isPersistant)
// End edgeFirebase

app.mount("#app");
```

#### Nuxt 3 example using the plugins folder:

Add a file (e.g., whatever.client.ts) to your "plugins" folder with the following code:

***- Note the ".client" in the file name. If the file doesn't have that in the name, you must disable SSR in the Nuxt config.***
```javascript
import eFb from "@edgedev/firebase";
const isPersistant = true // If "persistence" is true, login will be saved locally, they can close their browser and when they open they will be logged in automatically.  If "persistence" is false, login saved only for the session.
export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.use(eFb, {
    apiKey: "your-apiKey",
    authDomain: "your-authDomain",
    projectId: "your-projectId",
    storageBucket: "your-storageBucket",
    messagingSenderId: "your-messagingSenderId",
    appId: "your-appId",
    emulatorAuth: "",  // Local emulator port for auth emulator
    emulatorFirestore: "", // Local emulator port for Firestore emulator
  }, isPersistant);
});
```
***- Alternatively, you can disable SSR for your entire Nuxt project instead of naming the plugin with ".client", update the nuxt.config.ts file:***

```javascript
export default defineNuxtConfig({ ssr: false });
```

#### After installing as a plugin, include this in "script setup" in any component you want to use EdgeFirebase in:
```javascript
<script setup>
import { inject } from "vue";
const edgeFirebase = inject("edgeFirebase");
</script>
```

### Firebase Trigger functions.

These functions react to updates in the `staged-users` Firestore collection. This trigger is designed to help maintain data consistency between the `staged-users` and `users` collections. When a document in the `staged-users` collection is updated, the trigger performs checks and updates the corresponding user data in the `users` collection, ensuring that both collections stay in sync.

The trigger considers various scenarios such as the presence of a `userId` field, differences between the old and new `templateUserId` fields, and event processing status. It uses helper functions like `setUser`, `shouldProcess`, and `markProcessed` to manage these scenarios and make the necessary updates to the `users` collection. These functions handle tasks like updating or creating user documents, checking if an event should be processed, and marking an event as processed.

In essence, the `updateUser` trigger streamlines user data management by automatically synchronizing updates between the `staged-users` and `users` collections in your Firebase project and adds another layer of security.

User management requires setting up a Firestore trigger function and helper functions in your Firebase functions. These functions are automatically added to functions/index.js in your project, wrapped in "// START @edge/firebase functions" and "// END @edge/firebase functions".

```javascript
const functions = require('firebase-functions')
const admin = require('firebase-admin')
admin.initializeApp()
const db = admin.firestore()

// START @edge/firebase functions
	.......
// END @edge/firebase functions
```

### To make sure your project is secure, install the Firestore rules document provided at the end of this documentation.

# User Management and Collection Permissions

### Adding a User

Before registering with a login and password, users or "Template Users" must be added (the first project user needs to be added manually, see the section below "Root permissions and first user"). When adding a user, you can pass role and/or special permissions and user meta data. For more explanations on role and special permissions, see below. 

Adding a user creates a document for them in the collection "staged-users". The docId of this document is used as a registration code and must be passed when using "registerUser" with the "registrationCode" variable.

The collection "staged-users" is a staging zone for all modifications and serves to sanitize the actual users in the "users" collection. Once a user is registered, their staged-user is linked to their "users" user. Generally speaking, the users in the "users" collection should not be modified. In fact, if you adopt the firestore rules shown in this document, direct modification of users in the "users" collection is not allowed. All user-related functions in this package (editing of meta, setting rules and special permissions, listing of users) are done on the "staged-users" collection. 

To bypass adding users and allow "self-registration", you can add a user that is a "Template User" by setting the field "isTemplate" = true. For a template user, you can also set up dynamic document generation and assign the registered user to that document with a specified role by setting "subCreate". Then, when registering the user, you can pass a "dynamicDocumentFieldValue" variable. In the example below, if on registration you passed: dynamicDocumentFieldValue = "My New Organization", a document would be created under myItems that would look like this: {name: "My New Organization"}. The user would also be assigned as an admin to that newly created document. If your project is going to be completely self-registration, you can create a "Template User" and hard-code that registration id into your registration process.

How to add a user:

```javascript
edgeFirebase.addUser({
    roles: [
      {
        collectionPath: "myItems/subitems/things",
        role: "user"
      }
    ],
    specialPermissions: [
      {
        collectionPath: "otherthings",
        permissions: { assign: false, write: true, read: true, delete: false}
      }
    ],
    meta: { firstName: "John", lastName: "Doe", age: 28 } // This is just an example of meta, it can contain any fields and any number of fields.
    isTemplate: true,  // Optional - Only true if setting up template for self registation
    subCreate: {
          rootPath: 'myItems',
          role: 'admin',
          dynamicDocumentFieldValue: 'name',
          documentStructure: {
            name: '',
          },
        }
});
```

```typescript
interface newUser {
  roles: role[];
  specialPermissions: specialPermission[];
  meta: object;
  isTemplate?: boolean;
  subCreate?: {
    rootPath: string, // This must be a collection path (odd number of segments) since a document will be created and assigned to ther user here.
    role: string, // must be admin, editor, writer, user
    dynamicDocumentField: string, // This is the field in the document that will be set by the value of "dynamicDocumentFieldValue" passed during registration, like "name"
    documentStructure: {
      [key: string]: any
    }
  };
}
```

### Register User

After someone has been added as a user, they will need to "self-register" to begin using the system. Only users that have been added already by someone with assign permissions can register. The function also checks to make sure they aren't already registered.

```javascript
  edgeFirebase.registerUser({
    email: "user@edgemarketingdesign.com",
    password: "Password1234",
    meta: {
      firstName: "John",
      lastName: "Doe"
    }, // This is just an example of meta, it can contain any fields and any number of fields.
    registrationCode: (document id), // This is the document id of either an added user or a template user, when using a template you can simply hardcode the registrationCode of the remplate to allow self registration.
    dynamicDocumentFieldValue: "" // Optional - See explaintion above about self registration and dynamic collectionPath for user roles.
  });
```

```typescript
interface userRegister {
  email?: string;
  password?: string;
  meta: object;
  registrationCode: string;
  dynamicDocumentFieldValue?: string;
}
```

#### Registration using Microsoft Provider.

Calling this will generate a Microsoft Sign In Popup and register the user using the Microsoft credentials.

```javascript
 edgeFirebase.registerUser(
   {
    meta: {
      firstName: "John",
      lastName: "Doe"
    }, // This is just an example of meta, it can contain any fields and any number of fields.
    registrationCode: (document id), // This is the document id of either an added user or a template user, when using a template you can simply hardcode the registrationCode of the remplate to allow self registration.
    dynamicDocumentFieldValue: "" // Optional - See explaintion above about self registration and dynamic collectionPath for user roles.
  },
  'microsoft', // This is the authProvider only 'email' or 'microsoft' are supported, default is 'email',
  ["mail.read", "calendars.read"]  // This is a list of scopes to pass to Microsoft, the field is optional.
);
```

### Inviting an Existing User to Register with a New Organization or Member

To invite an existing user to register with a new organization or member's data and get the corresponding roles, use the `edgeFirebase.currentUserRegister(userRegister)` method.

```javascript
const userRegisterData = {
  registrationCode: "12345",
  dynamicDocumentFieldValue: "fieldName",
};

const response = await edgeFirebase.currentUserRegister(userRegisterData);
```

#### Parameters

- `userRegister` (object): An object containing the user registration data. It must include a `registrationCode` property provided by the inviting organization or member. It can also include a `dynamicDocumentFieldValue` property, which is a single string representing the name of an additional data field for registration.

```typescript
interface userRegister {
  registrationCode: string;
  dynamicDocumentFieldValue?: string;
}
```

#### Returns

The method returns a Promise that resolves to an `actionResponse` object:

```typescript
interface actionResponse {
  success: boolean;
  message: string;
  meta: {};
}
```

Example usage:

```javascript
<script setup>
  async function inviteExistingUser() {
    const userRegisterData = {
      registrationCode: "12345",
      dynamicDocumentFieldValue: "fieldName",
    };

    const response = await edgeFirebase.currentUserRegister(userRegisterData);
    if (response.success) {
      console.log("Existing user invited and registered successfully");
    } else {
      console.error("Error inviting and registering existing user:", response.message);
    }
  }
</script>
```


### Explanation of permissions

- **assign: boolean** - When a user has this permission for a collection they can assign other users to the collection and change permissions for that collection. For a user to be able run setUser, storeCollectionPermisions, storeUserRoles, removeUserRoles, storeUserSpecialPermissions, or removeUserSpecialPermissions, they must have assign access to any of the collection paths passed into those functions.
- **write: boolean** - Allows a user to write documents to collection
- **read: boolean** - Allows a user to read documents in a collection
- **delete: boolean** - Allows a user to delete documents in a collection 

### Collection permissions by role

Roles define what permissions the user will have. The system will use collection-data/-default- to lookup the permissions for an assigned role. The default permissions can be changed or you can define role permissions based on specific collection paths. If a specific collection path is not found when looking up a user's role permissions

- **admin:** assign: true, write: true, read: true, delete: true
- **editor**: assign: false, write: true, read: true, delete: true
- **writer**: assign: false, write: true, read: true, delete: false
- **user:** assign: false, write:false, read: true, delete: false

How to change role permissions for a specific collection:

```javascript
edgeFirebase.storeCollectionPermissions(
    "myItems/subitems/things",  // Collection path
    "user", // must be admin, editor, writer, user
    {
      assign: false,
      write: false,
      read: true,
      delete: false
    }
 );
```

Deleting collection permissions. This is done to "clean up" whenever a collection path is being deleted.

```javascript
  edgeFirebase.removeCollectionPermissions(
    "myItems/subitems/things")
```

### User roles for collections

Users are assigned roles based on collection paths. A role assigned by a collection path that has sub collections will also determine what the user can do on all sub collections or a user can be assigned a role specifically for a sub collection only. For example, if a user is assigned as an admin for "myItems/subitems/things" they will only have admin access to that collection. But if the user is assigned as an admin for "myItems" they will have the admin permissions for "myItems" and all sub collections of "myItems".

How to assign a user a role for a collection:

```javascript
  edgeFirebase.storeUserRoles(
    docId,  //Document ID of user in staged-users collection.
    "myItems/subitems/things",
    "admin"
  );
```

Remove a role from a user for a collection:

```javascript
  edgeFirebase.removeUserRoles(
     docId,  //Document ID of user in staged-users collection.
    "myItems/subitems/things"
  );
```

### Root permissions and first user

You can assign a user access to all collections in the entire project by giving them a role on "-", which is used to define the root collection path. This would be for someone who is acting like a super admin. If this is your first user, you will need to manually set them up in the Firstore console inside the "staged-users". Once a root user is added manually, you will need to "Register" that user using the docId of the "staged user" as the registration code, please see the user registration section of this documentation. You can use this user to add other "root users" or set up other collections and assign roles to them. You will also need to manually create the collection-data/-default- role permissions document (mentioned above) and the root permission document, see examples below:

![root-collection-roles](./images/default-collection-roles.png)

![root-collection-roles](./images/root-collection-roles.png)

![root-user](./images/root-user.png)

### User special permissions

If you want to give a user a unique set of permissions for a collection that doesn't match the admin or user roles for that collection, you can set "special permissions".

```javascript
  edgeFirebase.storeUserSpecialPermissions(
     docId,  //Document ID of user in staged-users collection.
    "myItems/subitems/things",
    {
      assign: false,
      write: true,
      read: true,
      delete: true
    }
  );
```

Remove user special permissions:

```javascript
  edgeFirebase.removeUserSpecialPermissions(
     docId,  //Document ID of user in staged-users collection.
    "myItems/subitems/things"
  );
```

### Rule Helpers: Managing User Permissions in Firestore

The package provides a utility designed to assist in managing user permissions for various actions in your Firestore project. By taking a `collectionPath` and an `action` as input parameters, it determines the user's role and special permissions and saves a `RuleCheck` object to the `rule-helpers` collection.

The `RuleCheck` object contains the permission type, permission check path, full path, and action, providing the necessary information to verify the user's access rights. By iterating through the user's roles and special permissions, the class identifies the correct permission check path and type.

The class plays a crucial role in maintaining data security and access control within your Firestore project. It ensures that users can only perform actions they are authorized to, based on their roles and special permissions.

### Remove user

The remove user function doesn't actually delete the user completely from the system but instead removes all roles and special permissions that the user running the function has assign access for.  In this way the user is "removed" as far as the "assigning user" is concerned but the user will remain a user for collections that the "assign user" doesn't have access to.  

```javascript
edgeFirebase.removeUser(docId);
```

### Delete Self

This function allows a user to delete their own account. It removes the user's document from both the `users` and `staged-users` collections in the database and also deletes the user's authentication record. The function returns an `actionResponse` object indicating the success or failure of the operation.

#### Usage

To delete the current user's account, call the `deleteSelf` function:

```javascript
const response = await edgeFirebase.deleteSelf();

if (response.success) {
  console.log("Account deleted successfully.");
} else {
  console.log("Failed to delete account:", response.message);
}
```

### Users Snapshot Data

This will create a reactive object (state.users) that contains the members of the collection passed to the snapshot if the user running the function has assign access for, it will be a listed index by  docId.  

```javascript
edgeFirebase.startUsersSnapshot("myItems");
// Stop users snapshot:
edgeFirebase.stopUsersSnapshot();
```

```vue
<script setup>
 console.log(edgeFirebase.state.users);
</script>
<template>
  <div>
    <div v-for="user in edgeFirebase.state.users" :key="item">
      {{ user.meta.name }}
    </div>
  </div>
</template>
```

```typescript
interface user {
  docId: string;
  roles: role[];
  specialPermissions: specialPermission[];
  userId: string;
  uid: string;
}
```

```typescript
interface role {
  collectionPath: "-" | string; // - is root
  role: "admin" | "editor" | "writer" | "user";
}
```

```typescript
interface specialPermission {
  collectionPath: "-" | string; // - is root
  permissions: permissions;
}
```

```typescript
interface permissions {
  assign: boolean;
  read: boolean;
  write: boolean;
  delete: boolean;
}
```

# Firebase Authentication

### Email and Password Login:

```javascript
  edgeFirebase.logIn(
    {
      email: "devs@edgemarketing.com",
      password: "pasword"
    }
  );
```

### Log In with Microsoft

This function allows users to log in using their Microsoft account. You can also specify an array of provider scopes if you want to request additional permissions from the user. The function returns a Promise that resolves when the sign-in process is complete. If the user does not exist, it will trigger an error and log the user out.

#### Usage

To log in with a Microsoft account, call the `logInWithMicrosoft` function. You can also pass an array of provider scopes as an optional parameter.

```javascript
// Log in using Microsoft account without additional provider scopes
edgeFirebase.logInWithMicrosoft();

// Log in using Microsoft account with additional provider scopes
const providerScopes = ["User.Read", "Calendars.Read"];
edgeFirebase.logInWithMicrosoft(providerScopes);
```

#### Parameters

- `providerScopes` (optional): An array of strings representing the additional provider scopes to request from the user. Defaults to an empty array.

#### Returns

A Promise that resolves when the sign-in process is complete. The Promise resolves to void, but any errors that occur during the sign-in process are captured and stored in the `this.user.logInError` and `this.user.logInErrorMessage` properties.

#### After Login, User information is contained in:  edgeFirebase.user

The user object is reactive and contains these items:

```typescript
interface UserDataObject {
  uid: string | null;
  email: string;
  firebaseUser: object; // contains the entire auth from firebase
  oAuthCredential: object; // contains oAuth ID and token information
  loggedIn: boolean;
  loggingIn: boolean: // true while logging in used for loading screens
  logInError: boolean;
  logInErrorMessage: string;
  meta: object;
  roles: role[]; //see role below
  specialPermissions: specialPermission[]; //see specialPermission below
}

// sub types of UserDataObject:
interface role {
  collectionPath: "-" | string; // - is root
  role: "admin" | "editor" | "writer" | "user";
}

interface specialPermission {
  collectionPath: "-" | string; // - is root
  permissions: permissions; // see permissions below
}

interface permissions {
  assign: boolean;
  read: boolean;
  write: boolean;
  delete: boolean;
}
```
The reactive item **edgeFirebase.user.loggedIn** can be used in code or templates to determine if the user is logged in.

**edgeFirebase.user.logginIn** is true while the user is logging in.  This can be used to show a loading screen.

If there is an error logging in, **edgeFirebase.user.logInError** will be true and **edgeFirebase.user.logInErrorMessage** can be used to return that error to the user.

After logging in, **edgeFirebase.logOut** becomes available.  Logging out will also automatically disconnect all FireStore listeners.

Here is a sample component using the login:

```html
<template>
  <div>
    <div v-if="edgeFirebase.user.loggedIn">
      <button @click="edgeFirebase.logOut">Logout</button><br />
      <ShowThings v-if="edgeFirebase.user.loggedIn" />
    </div>
    <div v-else>
      <input v-model="email" style="width: 400px" type="text" /><br />
      <input v-model="password" style="width: 400px" type="text" /><br />
      <button @click="login">Login</button><br />
      <div v-if="edgeFirebase.user.logInError">
        {{ edgeFirebase.user.logInErrorMessage }}
      </div>
    </div>
  </div>
</template>
```

```javascript
<script setup>
const email = ref("");
const password = ref("");
const login = () => {
  edgeFirebase.logIn(
    {
      email: email.value,
      password: password.value
    },
    true
  );
};
</script>
```
### Updating User Email

To update the email address of the current authenticated user, use the `edgeFirebase.updateEmail(newEmail)` method.

```javascript
const response = await edgeFirebase.updateEmail("new.email@example.com");
```

#### Parameters

- `newEmail` (string): The new email address to set for the user.

#### Returns

The method returns a Promise that resolves to an `actionResponse` object:

```typescript
interface actionResponse {
  success: boolean;
  message: string;
  meta: {};
}
```

Example usage:

```javascript
<script setup>
  async function changeEmail() {
    const newEmail = "new.email@example.com";
    const response = await edgeFirebase.updateEmail(newEmail);
    if (response.success) {
      console.log("Email updated successfully");
    } else {
      console.error("Error updating email:", response.message);
    }
  }
</script>
```


### Change password:

This function allows a user to change their current password while logged in:

```javascript
edgeFirebase.setPassword("old-password", "new-password");
```

### Password Reset:

For users not logged in (like forgotten password).  This is a two step process if the project is setup to redirect password resets back to a custom password reset page.

Step 1:

```javascript
edgeFirebase.sendPasswordReset('user@edgemarketingdesign.com');
```

Step 2: (If the password redirect is setup to go a custom page, you'll need to pull the "oobCode" from the query string and pass that along with the new password.)

```javascript
edgeFirebase.passwordReset('NewPassword123','AAaaAABaaaaAAABBBaaaBBBBAaaaaBABAbbaa');
```

### Update User Meta:

A user can update their own meta data when logged in.  The object containing meta data will only update/add the keys passed in the object.

```javascript
edgeFirebase.setUserMeta({ lastName: "Smith" });
```

# Firestore Basic Document Interactions

### Adding/Updating a Document
Both adding and updating a document use the same function: **edgeFirebase.storeDoc(collectionPath, object)**. For a document to be updated, the object must contain the key **docId**, and the value must match the ID of a document in the collection being updated *(Note: All documents returned by edgeFirebase functions will already have docId inserted in the document objects)*. If the object does not contain docId or the docId doesn't match a document in the collection, a new document will be created.

```javascript
<script setup>
const addItem = {title: "Cool Thing"};
edgeFirebase.storeDoc("myItems", addItem);
</script>
```

Note: When a document is written to the collection, several other keys are added that can be referenced: **doc_created_at** (timestamp of doc creation), **last_updated** (timestamp document last written), **uid** (the user id of the user that updated or created the document).

### Updating a Document Field(s)

In contrast to the `storeDoc` method, which adds or updates an entire document, you can use `edgeFirebase.changeDoc(collectionPath, docId, object)` to update individual fields in a document. This method allows you to specify the collection path, document ID, and the fields to update in the form of an object. It will only update the fields provided in the object while keeping the existing data in the document intact.

```javascript
<script setup>
const docId = "exampleDocumentId";
const updateItem = { title: "Updated Cool Thing" };
edgeFirebase.changeDoc("myItems", docId, updateItem);
</script>
```

In this example, the `changeDoc` method will update the title field of the specified document with the new value while preserving other fields. This is particularly useful when you need to modify a single field or a subset of fields in a document without affecting the rest of the data.

### Getting a single Document
If you want to query a single document from a collection, use: **edgeFirebase.getDocData(collectionPath, docId)**

```javascript
<script setup>
const docId = "DrJRpDXVsEEqZu0UB8NT";
const singleDoc = edgeFirebase.getDocData("myItems", docId);
</script>
```

### Deleting a Document.
To delete a document use: **edgeFirebase.removeDoc(collectionPath, docId)**
```javascript
<script setup>
const docId = "DrJRpDXVsEEqZu0UB8NT";
const singleDoc = edgeFirebase.removeDoc("myItems", docId);
</script>
```

# Firestore Snapshot Listeners
### Starting a Snapshot listener on a collection
To start a snapshot listen on a collection use: **edgeFirebase.startSnapshot(collectionPath)**
```javascript
<script setup>
edgeFirebase.startSnapshot("myItems");
</script>
```
Once you have started a snapshot reactive data for that snapshot will be available with **edgeFirebase.data[collectionPath]**.  Each document in the data object is keyed with the DocumentId from FireStore.
```html
<template>
  <div>
    <div v-for="item in edgeFirebase.data.myItems" :key="item">
      {{ item.title }}
    </div>
  </div>
</template>
```
### Starting a Snapshot Listener on a Document

To start a snapshot listener on a specific document within a collection, use the `edgeFirebase.startDocumentSnapshot(collectionPath, docId)` method.

```javascript
<script setup>
  edgeFirebase.startDocumentSnapshot("myItems", "exampleDocId");
</script>
```

Once you have started a snapshot listener on a document, reactive data for that snapshot will be available with `edgeFirebase.data[collectionPath + '/' + docId]`. This method first checks if the user has read permission for the specified document. If the user has permission, it starts the snapshot listener and updates the reactive data object accordingly. If the user doesn't have permission, it returns an error message indicating the lack of read access.

### Snapshot listeners can also be queried, sorted, and limited.

#### Query and Sort are an array of objects, Limit is a number
(if passing more than one query on different keys, FireStore may make you create indexes)
```typescript
interface FirestoreQuery {
  field: string;
  operator: WhereFilterOp; // '==' | '<' | '<=' | '>' | '>=' | 'array-contains' | 'in' | 'array-contains-any';
  value: unknown;
}

interface FirestoreOrderBy {
  field: string;
  direction: "asc" | "desc";
}
```
##### Example with query, sort and limit:
```javascript
<script setup>
const query = [{field: "title", operator: "==", value="Cool Thing"}];
const sort = [{ field: "title", direction: "asc" }];
const limit = 10;
edgeFirebase.startSnapshot("myItems", query, sort, limit);
</setup>
```
### Stopping a snapshot listener
To stop listening to a collection use: **edgeFirebase.stopSnapshot(collectionPath)**
```javascript
<script setup>
edgeFirebase.stopSnapshot("myItems");
</setup>
```

When stopping a snapshot listener on a specific document within a collection, use the combined `collectionPath + '/' + docId` as the parameter for the `edgeFirebase.stopSnapshot()` method.

For example:

```javascript
<script setup>
const documentPath = "myItems/exampleDocId";
edgeFirebase.stopSnapshot(documentPath);
</script>
```

# Firestore Static Collection Data

To get static data from a collection use the Object: **edgeFirebase.SearchStaticData()**. Static search is done from a class to handle pagination better.
```javascript
const staticSearch = new edgeFirebase.SearchStaticData();
staticSearch.getData("myItems");
```
After initialized like above... Data will be available from **staticSearch.results.data**

### The static data object can also be queried, sorted, limited and paginated.
(if passing more than one query on different keys, FireStore may make you create indexes)
```typescript
interface FirestoreQuery {
  field: string;
  operator: WhereFilterOp; // '==' | '<' | '<=' | '>' | '>=' | 'array-contains' | 'in' | 'array-contains-any';
  value: unknown;
}

interface FirestoreOrderBy {
  field: string;
  direction: "asc" | "desc";
}
```


### Pagination

For pagination purposes there are 2 functions **staticSearch.next()** and **staticSearch.prev()**  
for updating **staticSearch.results.data** the pagination data set.  There are also two helper variables **staticSearch.results.staticIsFirstPage** (set to true if the data is at the first pagination data set) and **staticSearch.results.staticIsLastPage** (set to true if the data is on the last pagination data set).  Note:  Because of the way Firestore pagination works, you don't know you are at your last data set until you try and query for the next. If you are using using **staticSearch.results.staticIsLastPage** to disable a "Next" button for example it won't happen until the "second" click and in that scenario **staticSearch.results.data** will just remain at the last pagination data set, it won't break.

### Example - Template and code with query, sort, limit, and pagination:
```html
<template>
  <div>
    <div v-for="item in staticSearch.results.data" :key="item">
      {{ item.title }}
    </div>
    <div>
      <button
        v-if="!staticSearch.results.staticIsFirstPage"
        @click="staticSearch.prev()"
      >
        Previous
      </button>
      <button
        v-if="!staticSearch.results.staticIsLastPage"
        @click="staticSearch.next()"
      >
        Next
      </button>
    </div>
  </div>
</template>
```
```javascript
<script setup>
const staticSearch = new edgeFirebase.SearchStaticData();

const query = [{field: "title", operator: "==", value="Cool Thing"}];
const sort = [{ field: "title", direction: "asc" }];
const limit = 10;

staticSearch.getData("myItems", query, sort, limit);
</script>
```

# Run a Cloud Function

### edgeFirebase.runFunction('cloudFunction', {data});

This function allows you to invoke a specified cloud function by providing its name and an optional data object. The user's UID is automatically added to the data object before the cloud function is called.

#### Parameters

- `functionName`: A string representing the name of the cloud function to be invoked.
- `data`: An optional object containing key-value pairs that will be passed to the cloud function as arguments. The user's UID is automatically included in the data object.

#### Returns

A Promise that resolves to the result of the invoked cloud function.

#### Example

Suppose you have a cloud function named `sendNotification` that takes two arguments: `message` and `recipientId`.

1. First, you need to define the `sendNotification` function in your Firebase `index.js`:

```javascript
const functions = require('firebase-functions');

exports.sendNotification = functions.https.onCall(async (data, context) => {
  if (data.uid !== context.auth.uid) {
    throw new functions.https.HttpsError('permission-denied', 'Unauthorized access');
  }

  const message = data.message;
  const recipientId = data.recipientId;
  const uid = data.uid; // The user's UID is automatically included in the data object

  // Your notification sending logic here

  return { success: true, message: 'Notification sent successfully' };
});
```

1. To call this function using the `runFunction` method, you would do the following:

```javascript
<script setup>
  const edgeFirebase = ...; // Reference to the object containing the runFunction method
  const sendNotification = async () => {
    try {
      const message = "Hello, User!";
      const recipientId = "someUserId";
      const result = await edgeFirebase.runFunction("sendNotification", { message, recipientId });
      console.log("Notification sent successfully:", result);
    } catch (error) {
      console.error("Error sending notification:", error);
    }
  };
</script>

<template>
  <button @click="sendNotification">Send Notification</button>
</template>
```

In this example, clicking the "Send Notification" button will invoke the `sendNotification` cloud function with the specified `message` and `recipientId`. The result of the function will be logged to the console. The cloud function checks if the provided `data.uid` matches the authenticated user's UID (`context.auth.uid`) for security purposes.

# Responses

Most functions will return a response that can be used.  

```javascript
const response = edgeFirebase.startSnapshot("things");
const response = await edgeFirebase.storeDoc("myItems", {name: "John Doe"});
```

reponse:

```typescript
interface actionResponse {
  success: boolean;
  message: string;
  meta: {}
}
```

# Firestore Rules

Firestore rules are automatically written to your project in the firestore.rules file the are wrapped in: "// #EDGE FIREBASE RULES START" and "// #EDGE FIREBASE RULES END"

```javascript
rules_version = '2';
// #EDGE FIREBASE RULES START

// #EDGE FIREBASE RULES END
```

## License

[ISC](https://choosealicense.com/licenses/isc/)
