import { initializeApp } from "firebase/app";
import { reactive } from "vue";
import {
  getFirestore,
  collection,
  addDoc,
  doc,
  query,
  onSnapshot,
  WhereFilterOp,
  QueryConstraint,
  Unsubscribe,
  where,
  deleteDoc,
  getDocs,
  getDoc,
  orderBy,
  limit,
  Query,
  startAfter,
  DocumentData,
  setDoc,
  updateDoc,
  deleteField,
  arrayRemove,
  arrayUnion,
  connectFirestoreEmulator,
  getCountFromServer,
} from "firebase/firestore";

import {
  initializeAuth,
  browserSessionPersistence,
  browserLocalPersistence,
  Persistence,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  createUserWithEmailAndPassword,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
  sendPasswordResetEmail,
  confirmPasswordReset,
  checkActionCode,
  applyActionCode,
  connectAuthEmulator,
  deleteUser,
  OAuthProvider,
  browserPopupRedirectResolver,
  signInWithPopup,
  sendSignInLinkToEmail,
  verifyBeforeUpdateEmail,
  signInWithCustomToken,
  updateProfile,
} from "firebase/auth";


import { getStorage, ref, uploadBytesResumable, getDownloadURL, connectStorageEmulator, listAll, deleteObject, getMetadata} from "firebase/storage";

import { getFunctions, httpsCallable, connectFunctionsEmulator } from "firebase/functions";

import { getAnalytics, logEvent } from "firebase/analytics";

interface FirestoreQuery {
  field: string;
  operator: WhereFilterOp; // '==' | '<' | '<=' | '>' | '>=' | 'array-contains' | 'in' | 'array-contains-any';
  value: unknown;
}

interface FirestoreOrderBy {
  field: string;
  direction: "asc" | "desc";
}

interface FirestoreLimit {
  limit: number;
}

interface CollectionUnsubscribeObject {
  [key: string]: Unsubscribe;
}

interface CollectionDataObject {
  [key: string]: object;
}

interface permissions {
  assign: boolean;
  read: boolean;
  write: boolean;
  delete: boolean;
}

type action = "assign" | "read" | "write" | "delete";

type authProviders = "email" | "microsoft" | "google" | "facebook" | "github" | "twitter" | "apple" | "phone" | "emailLink" | "customToken";

interface role {
  collectionPath: "-" | string; // - is root
  role: "admin" | "editor" | "writer" | "user";
}

interface specialPermission {
  collectionPath: "-" | string; // - is root
  permissions: permissions;
}

interface UserDataObject {
  uid: string | null;
  email: string;
  firebaseUser: object;
  oAuthCredential: { accessToken: string; idToken: string;}
  loggedIn: boolean;
  loggingIn: boolean | null;
  logInError: boolean;
  logInErrorMessage: string;
  meta: object;
  roles: role[];
  specialPermissions: specialPermission[];
  stagedDocId: string;
}
interface newUser {
  roles: role[];
  specialPermissions: specialPermission[];
  meta: object;
  isTemplate?: boolean;
  subCreate?: {
    rootPath: string, // This must be a collection path (odd number of segments) since a document will be created and assigned to ther user here.
    role: string,
    dynamicDocumentFieldValue: string, // This is the field in the document that will be set by the value of "dynamicDocumentFieldValue" passed during registration, like "name"
    documentStructure: {
      [key: string]: unknown
    }
  };
}

interface userRegister {
  uid?: string;
  email?: string;
  token?: string;
  identifier?: string;
  phoneCode?: string;
  phoneNumber?: string;
  password?: string;
  meta: object;
  registrationCode: string;
  dynamicDocumentFieldValue?: string;
  requestedOrgId?: string;
}


interface RuleCheck {
    permissionType: string;
    permissionCheckPath: string; 
    fullPath: string;
    action: string;
}

// interface RuleCheck {
//   [key: string]: RuleCheckItem | string;
// }

interface Credentials {
  email: string;
  password: string;
}

interface StaticDataResult {
  data: object;
  next: DocumentData | null;
}

interface firebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  emulatorAuth?: string;
  measurementId?: string;
  emulatorFirestore?: string;
  emulatorFunctions?: string;
  emulatorStorage?: string;
}

interface actionResponse {
  success: boolean;
  message: string;
  meta: object;
}

interface permissionStatus {
  canDo: boolean;
  badCollectionPaths: string[];
}

interface User {
  userId: string;
  docId: string;
}

interface Meta {
  [key: string]: unknown;
}

export const EdgeFirebase = class {
  constructor(
    firebaseConfig: firebaseConfig = {
      apiKey: "",
      authDomain: "",
      projectId: "",
      storageBucket: "",
      messagingSenderId: "",
      appId: "",
      measurementId: "",
      emulatorAuth: "",
      emulatorFirestore: "",
      emulatorFunctions: "",
      emulatorStorage: "",
    },
    isPersistant: false,
    enablePopupRedirect: false,
  ) {
    this.firebaseConfig = firebaseConfig;
    this.app = initializeApp(this.firebaseConfig);
    let persistence: Persistence = browserSessionPersistence;
    if (isPersistant) {
      persistence = browserLocalPersistence;
    }
    if (enablePopupRedirect) {
      this.auth = initializeAuth(this.app, { persistence, popupRedirectResolver: browserPopupRedirectResolver });
    } else {
      this.auth = initializeAuth(this.app, { persistence });
    }

    if (this.firebaseConfig.emulatorAuth) {
      connectAuthEmulator(this.auth, `http://127.0.0.1:${this.firebaseConfig.emulatorAuth}`)
    }

    this.db = getFirestore(this.app);
    if (this.firebaseConfig.emulatorFirestore) {
      connectFirestoreEmulator(this.db, "127.0.0.1", this.firebaseConfig.emulatorFirestore)
    }

    if (this.firebaseConfig.measurementId) {
      this.anaytics = getAnalytics(this.app);
    }  
     if (this.firebaseConfig.storageBucket) {
      this.storage = getStorage(this.app);
    }
    this.functions = getFunctions(this.app);
    if (this.firebaseConfig.emulatorFunctions) {
      connectFunctionsEmulator(this.functions, "127.0.0.1", this.firebaseConfig.emulatorFunctions)
    }
    if (this.firebaseConfig.emulatorStorage) {
      connectStorageEmulator(this.storage, "127.0.0.1", this.firebaseConfig.emulatorStorage)
    }
    this.setOnAuthStateChanged();
  }

  private firebaseConfig = null;

  public app = null;
  public auth = null;
  public db = null;
  public storage = null;
  private anaytics = null;

  private functions = null;

  public runFunction = async (functionName: string, data: Record<string, unknown>) => {
    data.uid = this.user.uid;
    const callable = httpsCallable(this.functions, functionName);
    return await callable(data);
  };

  public updateEmail = async (newEmail: string): Promise<actionResponse> => {
    try {
      await  verifyBeforeUpdateEmail(this.auth.currentUser, newEmail);
      return {
        success: true,
        message: "Email updated",
        meta: {}
      };
    } catch (error) {
      return {
        success: false,
        message: error.message,
        meta: {}
      };
    }
  };

  public logAnalyticsEvent = (eventName: string, eventParams: object = {}) => {
    if (this.anaytics) {
      logEvent(this.anaytics, eventName, eventParams);
    }
  };

  private initUserMetaPermissions = async (docSnap): Promise<void> => {
    this.user.meta = {};
    if (docSnap.exists()) {
      this.user.meta = docSnap.data().meta;
      const roles: role[] = [];
      if (docSnap.data().roles) {
        for (const collectionPath in docSnap.data().roles) {
          roles.push({
            collectionPath,
            role: docSnap.data().roles[collectionPath].role
          });
        }
      }
      this.user.roles = roles;

      const specialPermissions: specialPermission[] = [];
      if (docSnap.data().specialPermissions) {
        for (const collectionPath in docSnap.data().specialPermissions) {
          specialPermissions.push({
            collectionPath,
            permissions:
              docSnap.data().specialPermissions[collectionPath].permissions
          });
        }
      }
      this.user.specialPermissions = specialPermissions;
      this.user.stagedDocId = docSnap.data().stagedDocId;
    }
    this.stopSnapshot('userMeta')
    const metaUnsubscribe = onSnapshot(
      doc(this.db, "users", this.user.uid),
      (doc) => {
        this.user.meta = doc.data().meta;
        const roles: role[] = [];
        if (doc.data().roles) {
          for (const collectionPath in doc.data().roles) {
            roles.push({
              collectionPath,
              role: doc.data().roles[collectionPath].role
            });
          }
        }
        this.user.roles = roles;

        const specialPermissions: specialPermission[] = [];
        if (doc.data().specialPermissions) {
          for (const collectionPath in doc.data().specialPermissions) {
            specialPermissions.push({
              collectionPath,
              permissions:
                doc.data().specialPermissions[collectionPath].permissions
            });
          }
        }
        this.user.specialPermissions = specialPermissions;
      }
    );
    this.unsubscribe.userMeta = metaUnsubscribe;
  };


  private ruleHelperReset = async (): Promise<void> => {
    const initRoleHelper = { uid: this.user.uid, 'edge-assignment-helper': {permissionType: "roles"} }
    this.state.ruleHelpers['edge-assignment-helper'] = {permissionType: "roles"}
    await setDoc(doc(this.db, "rule-helpers", this.user.uid), initRoleHelper);
  }

  private startUserMetaSync = async (docSnap): Promise<void> => {
    // Took this out because if another client is logged in, it breaks the other client
    // await this.ruleHelperReset();
    await this.initUserMetaPermissions(docSnap);
    this.user.loggedIn = true;
    this.user.loggingIn = false;
  };

  private waitForUser = async(): Promise<void> => {
    //On registration may take a second for user to be created
    const docRef = doc(this.db, "users", this.user.uid);
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      this.startUserMetaSync(docSnap);
    } else {
      setTimeout(() => {
          this.waitForUser();
      }, 1000);
    }
  }

  private setOnAuthStateChanged = (): void => {
    onAuthStateChanged(this.auth, (userAuth) => {
      console.log('onAuthStateChanged')
      const oldDiv = document.getElementById("recaptcha-container");
      if (oldDiv) oldDiv.remove();
      if (userAuth) {
        this.user.loggingIn = true;
        this.user.email = userAuth.email;
        this.user.uid = userAuth.uid;
        this.user.firebaseUser = userAuth;
        this.user.logInError = false;
        this.user.logInErrorMessage = "";
        this.logAnalyticsEvent("login", { uid: this.user.uid });
        this.waitForUser();
      } else {
        this.user.email = "";
        this.user.uid = null;
        this.user.firebaseUser = null;
        this.user.oAuthCredential.accessToken = "";
        this.user.oAuthCredential.idToken = "";
        this.user.loggedIn = false;
        this.user.loggingIn = false;
      }
    });
  };

  public loginWithCustomToken = async (token: string): Promise<void> => {
    try {
      const result = await signInWithCustomToken(this.auth, token);
      if (!Object.prototype.hasOwnProperty.call(result, "user")) {
        this.user.logInError = true;
        this.user.logInErrorMessage = JSON.stringify(result)
        this.logOut();
        return;
      }
      const userRef = doc(this.db, "users", result.user.uid);
      const userSnap = await getDoc(userRef);
      if (!userSnap.exists()) { 
        this.user.logInError = true;
        this.user.logInErrorMessage = "User does not exist";
        this.logOut();
        return;
      }
    } catch (error) {
      this.user.logInError = true;
      this.user.logInErrorMessage = error.message;
      this.logOut();
      return;
    }
  }

  public logInWithPhone = async (phoneNumber: string, phoneCode: string): Promise<void> => {
    try {
      const verifyCode: any = await this.runFunction("edgeFirebase-verifyPhoneNumber", {phone: phoneNumber, code: phoneCode});
      if (verifyCode.data.success) {
        const result = await signInWithCustomToken(this.auth, verifyCode.data.token);
        if (!Object.prototype.hasOwnProperty.call(result, "user")) {
          this.user.logInError = true;
          this.user.logInErrorMessage = JSON.stringify(result)
          this.logOut();
          return;
        }
        const userRef = doc(this.db, "users", result.user.uid);
        const userSnap = await getDoc(userRef);
        if (!userSnap.exists()) { 
          this.user.logInError = true;
          this.user.logInErrorMessage = "User does not exist";
          this.logOut();
          return;
        }
      } else {
        this.user.logInError = true;
        this.user.logInErrorMessage = verifyCode.data.error;
        this.logOut();
        return;
      }
    } catch (error) {
      this.user.logInError = true;
      this.user.logInErrorMessage = error.message;
      this.logOut();
      return;
    }
  };

  public logInWithMicrosoft = async (providerScopes: string[] = []): Promise<void> => {
      const result = await this.signInWithMicrosoft(providerScopes);
      if (!Object.prototype.hasOwnProperty.call(result, "user")) {
        this.user.logInError = true;
        this.user.logInErrorMessage = result
        this.logOut();
        return;
      }
      console.log(result.user.uid);
      const userRef = doc(this.db, "users", result.user.uid);
      const userSnap = await getDoc(userRef);
      if (!userSnap.exists()) { 
        this.user.logInError = true;
        this.user.logInErrorMessage = "User does not exist";
        this.logOut();
      }
  };

  private registerUserWithMicrosoft = async (providerScopes: string[] = []): Promise<any> => {
    const result = await this.signInWithMicrosoft(providerScopes);
    return result;
  };

  private signInWithMicrosoft = async (providerScopes: string[] = []): Promise<any> => {
    const provider = new OAuthProvider("microsoft.com");
    for (const scope of providerScopes) {
      provider.addScope(scope);
    }
    try {
      const result = await signInWithPopup(this.auth, provider);
      const credential = OAuthProvider.credentialFromResult(result);
      this.user.oAuthCredential.accessToken = credential.accessToken;
      this.user.oAuthCredential.idToken = credential.idToken;
      return result;
    } catch (error) {
      return error;
    }
  }

  public currentUserRegister = async (userRegister: userRegister): Promise<actionResponse> => {
    if (!Object.prototype.hasOwnProperty.call(userRegister, 'registrationCode') || userRegister.registrationCode === "") {
      return this.sendResponse({
        success: false,
        message: "Registration code is required.",
        meta: {}
      });
    }
    // userRegister.uid = this.user.uid;
    const result = await this.runFunction("edgeFirebase-currentUserRegister", userRegister as unknown as Record<string, unknown>);
    const resultData = result.data as {success: boolean, message: string};
    if (resultData.success) {
      return this.sendResponse({
        success: true,
        message: "line 488",
        meta: {}
      });
    } else {
      return this.sendResponse({
        success: false,
        message: resultData.message,
        meta: {}
      });
    }
  }

  public sendEmailLink = async (email: string): Promise<any> => {
    const actionCodeSettings = {
      url: window.location.href,
      handleCodeInApp: true,
    };
    try {
      await sendSignInLinkToEmail(this.auth, email, actionCodeSettings);
      return true;
    } catch (error) {
      this.user.logInError = true;
      this.user.logInErrorMessage = error.message;
      this.logOut();
      return false;
    }
  };

  public sendPhoneCode = async (phone: string): Promise<any> => {
    try {
      const callable = httpsCallable(this.functions, "edgeFirebase-sendVerificationCode");
      const result: any = await callable({phone: phone});

      if (result.data.success !== false) {
        console.log('good')
        return result.data;
      } else  {
        console.log('bad')
        this.user.logInError = true;
        this.user.logInErrorMessage = result.data.error;
        this.logOut();
        return false;
      }
    } catch (error) {
      this.user.logInError = true;
      this.user.logInErrorMessage = error.message;
      this.logOut();
      return false;
    }
  }



  public registerUser = async (
    userRegister: userRegister,
    authProvider: authProviders = "email",
    providerScopes: string[] = []
  ): Promise<actionResponse> => {
    if (!Object.prototype.hasOwnProperty.call(userRegister, 'registrationCode') || userRegister.registrationCode === "") {
      return this.sendResponse({
        success: false,
        message: "Registration code is required.",
        meta: {}
      });
    }
    if (Object.prototype.hasOwnProperty.call(userRegister, 'requestedOrgId')) {
      if (userRegister.requestedOrgId) {
        const result: any = await this.runFunction("edgeFirebase-checkOrgIdExists", {orgId: userRegister.requestedOrgId.toLowerCase()});
        if (result.data.exists) {
          return this.sendResponse({
            success: false,
            message: "Organization ID already exists.",
            meta: {}
          });
        }
      }
    }
    let userSnap = null;
    try {
      const userRef = doc(this.db, "staged-users", userRegister.registrationCode);
      userSnap = await getDoc(userRef);
    } catch (error) {
      return this.sendResponse({
        success: false,
        message: "Registration code already used.",
        meta: {}
      });
    }
    if (userSnap.exists()) {
      const user = userSnap.data();
      if (user.userId) {
        return this.sendResponse({
          success: false,
          message: "User already registered",
          meta: {}
        });
      } else {
        if (user.isTemplate  && Object.prototype.hasOwnProperty.call("subCreate", user) &&  Object.values(user.subCreate).length > 0) {
          if (!Object.prototype.hasOwnProperty.call(userRegister, 'dynamicDocumentFieldValue') || userRegister.dynamicDocumentFieldValue === "") {
            return this.sendResponse({
              success: false,
              message: "Dynamic document field value is required for registration when template user has subCreate.",
              meta: {}
            });
         }
        }
        let response;
        if (authProvider === "email") {
          try {
            response = await createUserWithEmailAndPassword(
              this.auth,
              userRegister.email,
              userRegister.password
            );
          } catch (error) {
            response = error;
          }
        } else if (authProvider === "microsoft") {
         response = await this.registerUserWithMicrosoft(providerScopes);
        } else if (authProvider === "customToken") {
          if (!Object.prototype.hasOwnProperty.call(userRegister, 'token')) {
            return this.sendResponse({
              success: false,
              message: "Token is required for registration when authProvider is customToken.",
              meta: {}
            });
          }
          if (!Object.prototype.hasOwnProperty.call(userRegister, 'identifier')) {
            return this.sendResponse({
              success: false,
              message: "Identifier is required for registration when authProvider is customToken.",
              meta: {}
            });
          }
          try {
            response = await signInWithCustomToken(this.auth, userRegister.token);
            await updateProfile(response.user, {
              displayName: userRegister.identifier
            });
          } catch (error) {
            response = error;
          }
        } else if (authProvider === "phone") {
          try {
            const verifyCode: any = await this.runFunction("edgeFirebase-verifyPhoneNumber", {phone: userRegister.phoneNumber, code: userRegister.phoneCode});
            if (verifyCode.data.success) {
              response = await signInWithCustomToken(this.auth, verifyCode.data.token);
              await updateProfile(response.user, {
                displayName: userRegister.phoneNumber
              });
            } else {
              return this.sendResponse({
                success: false,
                message: verifyCode.data.error,
                meta: {}
              });
            }
          } catch (error) {
            // Handle the case where the code is incorrect or expired
            response = error;
          }
        } else if (authProvider === "emailLink") {
          // TOOD: emailLink stuff
        }
        if (!Object.prototype.hasOwnProperty.call(response, "user")) { 
          return this.sendResponse({
            success: false,
            message: response,
            meta: {}
          });
        }
        
        let metaUpdate = {};
        if (Object.prototype.hasOwnProperty.call(userRegister, 'meta')) {
          metaUpdate = userRegister.meta;
        }else{
          metaUpdate = user.meta;
        }
        let stagedUserUpdate: {userId?: string, templateUserId?: string, dynamicDocumentFieldValue?: string, uid: string, meta: unknown, templateMeta?: unknown, requestedOrgId?: unknown} = {userId: response.user.uid, uid: response.user.uid, meta: metaUpdate}
        if (user.isTemplate) {
          stagedUserUpdate = {templateUserId: response.user.uid, uid: response.user.uid, meta: user.meta, templateMeta: metaUpdate}
          if (Object.prototype.hasOwnProperty.call(userRegister, 'dynamicDocumentFieldValue')) {
            stagedUserUpdate = {templateUserId: response.user.uid, uid: response.user.uid, dynamicDocumentFieldValue: userRegister.dynamicDocumentFieldValue, meta: user.meta, templateMeta: metaUpdate}
          }
          if (Object.prototype.hasOwnProperty.call(userRegister, 'requestedOrgId')) {
            stagedUserUpdate = {templateUserId: response.user.uid, uid: response.user.uid, dynamicDocumentFieldValue: userRegister.dynamicDocumentFieldValue, meta: user.meta, templateMeta: metaUpdate, requestedOrgId: userRegister.requestedOrgId.toLowerCase()}
          }
        }
        const initRoleHelper = {uid: response.user.uid}
        initRoleHelper["edge-assignment-helper"] = {permissionType: "roles"}
        this.user.loggingIn = true;
        await setDoc(doc(this.db, "rule-helpers", response.user.uid), initRoleHelper);
        await updateDoc(doc(this.db, "staged-users/" + userRegister.registrationCode), stagedUserUpdate)
        this.logAnalyticsEvent("sign_up", { uid: response.user.uid});
        return this.sendResponse({
          success: true,
          message: "line 576",
          meta: {}
        });
        
      }
    } else {
      return this.sendResponse({
        success: false,
        message: "Registration code not valid.",
        meta: {}
      });
    }
  };

  public sendPasswordReset = async (email: string): Promise<actionResponse> => {
    try {
      await sendPasswordResetEmail(this.auth, email);
      return this.sendResponse({
        success: true,
        message: "line 595",
        meta: {}
      });
    } catch (error) {
      return this.sendResponse({
        success: false,
        message: error.message,
        meta: {}
      });
    }
  };

  public emailUpdate = async (
    oobCode: string
  ): Promise<actionResponse> => {

    try {
      const info = await checkActionCode(this.auth, oobCode);
      await applyActionCode(this.auth, oobCode);
      return this.sendResponse({
        success: true,
        message: "line 798",
        meta: {}
      });
    } catch (error) {
      return this.sendResponse({
        success: false,
        message: error.message,
        meta: {}
      });
    }
  };

  public passwordReset = async (
    password: string,
    oobCode: string
  ): Promise<actionResponse> => {
    try {
      // await verifyPasswordResetCode(this.auth, oobCode);
      await confirmPasswordReset(this.auth, oobCode, password);
      return this.sendResponse({
        success: true,
        message: "line 616",
        meta: {}
      });
    } catch (error) {
      return this.sendResponse({
        success: false,
        message: error.message,
        meta: {}
      });
    }
  };

  public setPassword = async (
    oldpassword: string,
    password: string
  ): Promise<actionResponse> => {
    const user = this.auth.currentUser;
    const credential = EmailAuthProvider.credential(
      this.user.email,
      oldpassword
    );
    try {
      await reauthenticateWithCredential(user, credential);
      await updatePassword(user, password);
      return this.sendResponse({
        success: true,
        message: "line 642",
        meta: {}
      });
    } catch (error) {
      return this.sendResponse({
        success: false,
        message: error.message,
        meta: {}
      });
    }
  };



  public setUserMeta = async (meta: Meta, userId = ''): Promise<actionResponse> => {
    let stagedDocId = this.user.stagedDocId;
    if (userId) {
      const users = Object.values(this.state.users)  as User[];
      const user = users.find((u) => u.userId === userId);
      if (user) {
        console.log(user)
        stagedDocId = user.docId;
      } else {
        return this.sendResponse({
          success: false,
          message: "You don't have access to change this user.",
          meta: {}
        });
      }
    }
    for (const [key, value] of Object.entries(meta)) {
      await updateDoc(doc(this.db, "staged-users/" + stagedDocId), {
        ["meta." + key]: value, uid: this.user.uid
      });
    }
    return this.sendResponse({
      success: true,
      message: "line 664",
      meta: {}
    });
  };

  public removeUser = async (docId: string): Promise<actionResponse> => {
    const removedFrom = [];
    const userRef = doc(this.db, "staged-users", docId);
    const userSnap = await getDoc(userRef);
    if (userSnap.data().roles) {
      for (const collectionPath in userSnap.data().roles) {
        const canAssign = await this.permissionCheck(
          "assign",
          collectionPath.replaceAll("-", "/")
        );
        if (canAssign) {
          await this.removeUserRoles(docId, collectionPath.replaceAll("-", "/"));
          removedFrom.push(collectionPath.replaceAll("-", "/"));
        }
      }
    }
    if (userSnap.data().specialPermissions) {
      for (const collectionPath in userSnap.data().specialPermissions) {
        const canAssign = await this.permissionCheck(
          "assign",
          collectionPath.replaceAll("-", "/")
        );
        if (canAssign) {
         await this.removeUserSpecialPermissions(
            docId,
            collectionPath.replaceAll("-", "/")
          );
          removedFrom.push(collectionPath.replaceAll("-", "/"));
        }
      }
    }
    if (removedFrom.length > 0) {
      const response = await this.runFunction("edgeFirebase-removeNonRegisteredUser", {uid: this.user.uid, docId});
      return this.sendResponse({
        success: true,
        message: "line 704",
        meta: {response}
      });
    } else {
      return this.sendResponse({
        success: false,
        message: "You do not have permission to remove this user",
        meta: {}
      });
    }
  };

  public deleteSelf = async (): Promise<actionResponse> => {
    const userId = this.user.uid;
    const userRef = doc(this.db, "users", userId);
    const userSnap = await getDoc(userRef);
    if (userSnap.exists()) {
        const userStagingRef = doc(this.db, "staged-users", userSnap.data().stagedDocId)
        await deleteDoc(userStagingRef);
        await deleteDoc(userRef);
        const user = this.auth.currentUser;
        await deleteUser(user);
        this.logOut();
        return this.sendResponse({
          success: true,
          message: "line 729",
          meta: {}
        });
    } else {
      return this.sendResponse({
        success: false,
        message: "User does not exist",
        meta: {}
      });
    }
  };

  public addUser = async (newUser: newUser): Promise<actionResponse> => {
    const canAssignRole = this.multiPermissionCheck(
      "assign",
      newUser.roles
    );
    const canAssignSpecialPermissions = this.multiPermissionCheck(
      "assign",
      newUser.specialPermissions
    );
    if (canAssignRole.canDo && canAssignSpecialPermissions.canDo) {
      const response = await this.generateUserMeta(newUser);
      return this.sendResponse(response);
    } else {
      return this.sendResponse({
        success: false,
        message:
          "Cannot assign role or special permission for collection path(s): " +
          canAssignRole.badCollectionPaths
            .concat(canAssignSpecialPermissions.badCollectionPaths)
            .join(", "),
        meta: {}
      });
    }
  };

  private multiPermissionCheck = (
    action: action,
    collections = []
  ): permissionStatus => {
    let canDo = true;
    const badCollectionPaths = [];
    // if (collections.length === 0) {
    //   canDo = false;
    // }
    for (const collection of collections) {
      if (!(this.permissionCheckOnly(action, collection.collectionPath))) {
        badCollectionPaths.push(collection.collectionPath);
        canDo = false;
      }
    }
    if (!canDo) {
      return {
        canDo: false,
        badCollectionPaths
      };
    } else {
      return {
        canDo: true,
        badCollectionPaths: []
      };
    }
  };

  private sendResponse = (response: actionResponse): actionResponse => {
    console.log(response);
    return response;
  };

  private setRuleHelper = async(collectionPath: string, action): Promise<void> => {
    const collection = collectionPath.replaceAll("-", "/").split("/");
    let ruleKey = collectionPath.replaceAll("/", "-");
    if (action === "assign") {
      ruleKey = "edge-assignment-helper";
    }
    let index = collection.length;
    const ruleCheck: RuleCheck =  { permissionType: "", permissionCheckPath: "", fullPath: collectionPath.replaceAll("/", "-"), action };
    if (this.state.ruleHelpers[ruleKey]) {
      const existingRuleHelper = this.state.ruleHelpers[ruleKey];
      if (existingRuleHelper.fullPath === ruleCheck.fullPath && existingRuleHelper.action === ruleCheck.action) {
        return;
      }
    }
    while (index > 0) {
      const collectionArray = JSON.parse(JSON.stringify(collection));
      const permissionCheck = collectionArray.splice(0, index).join("-");
      const role = this.user.roles.find(
        (r) => r.collectionPath === permissionCheck
      );
      if (role) {
        ruleCheck.permissionCheckPath = permissionCheck;
        ruleCheck.permissionType = "roles";

      }
      const specialPermission = this.user.specialPermissions.find(
        (r) => r.collectionPath === permissionCheck
      );
      if (specialPermission) {
        ruleCheck.permissionCheckPath = permissionCheck;
        ruleCheck.permissionType = "specialPermissions";
      }
      if (ruleCheck.permissionType !== "") {
        if (this.permissionCheckOnly(action, permissionCheck)) {
          break;
        }
      }
      index--;
    }
    const rootRole = this.user.roles.find((r) => r.collectionPath === "-");
    if (rootRole) {
      ruleCheck.permissionCheckPath = "-";
      ruleCheck.permissionType = "roles";
    }
    const rootSpecialPermission = this.user.specialPermissions.find(
      (r) => r.collectionPath === "-"
    );
    if (rootSpecialPermission) {
      ruleCheck.permissionCheckPath = "-";
      ruleCheck.permissionType = "specialPermissions";
    }
    const check = {[ruleKey]: ruleCheck,  uid: this.user.uid };
    await setDoc(doc(this.db, "rule-helpers", this.user.uid), check, { merge: true });
    this.state.ruleHelpers[ruleKey] = ruleCheck;
  }



  public permissionCheckOnly = (action: action, collectionPath: string): boolean => {
    const collection = collectionPath.replaceAll("-", "/").split("/");
    let index = collection.length;
    let permissionData = {};
    permissionData = {
      read: false,
      write: false,
      delete: false,
      assign: false
    };
    while (index > 0) {
      if (!permissionData[action]) {
        const collectionArray = JSON.parse(JSON.stringify(collection));
        const permissionCheck = collectionArray.splice(0, index).join("-");
        const role = this.user.roles.find(
          (r) => r.collectionPath === permissionCheck
        );

        if (role) {
          permissionData = this.state.permissions[role.role] || {
            read: false,
            write: false,
            delete: false,
            assign: false
          };
        }
        const specialPermission = this.user.specialPermissions.find(
          (r) => r.collectionPath === permissionCheck
        );
        if (specialPermission) {
          permissionData = specialPermission.permissions;
        }
      }
      index--;
    }
    if (!permissionData[action]) {
      const rootRole = this.user.roles.find((r) => r.collectionPath === "-");
      if (rootRole) {
        permissionData = this.state.permissions[rootRole.role] || {
          read: false,
          write: false,
          delete: false,
          assign: false
        };
      }
      const rootSpecialPermission = this.user.specialPermissions.find(
        (r) => r.collectionPath === "-"
      );
      if (rootSpecialPermission) {
        permissionData = rootSpecialPermission.permissions;
      }
    }
    return permissionData[action];
  }

  public permissionCheck = async(
    action: action,
    collectionPath: string,
  ): Promise<boolean> => {
    const check = this.permissionCheckOnly(action, collectionPath);
    if (check) {
      await this.setRuleHelper(collectionPath, action);
    }
    return check;
  };

  private generateUserMeta = async (userMeta: newUser): Promise<actionResponse> => {
    const roles: role[] = userMeta.roles || [];
    const specialPermissions: specialPermission[] = userMeta.specialPermissions || [];
    delete userMeta.roles;
    delete userMeta.specialPermissions;

    let isTemplate = false
    if (Object.prototype.hasOwnProperty.call(userMeta, "isTemplate") && userMeta.isTemplate) {
      isTemplate = true
    }

    let subCreate = {}
    if (Object.prototype.hasOwnProperty.call(userMeta, "subCreate")) {
      if (userMeta.subCreate.rootPath.split("-").length % 2==0){
        return {
          success: false,
          message: "subCreate.rootPath must contain an odd number of segments.",
          meta: {}
        }
     }
      const canAssign = await this.permissionCheck("assign", userMeta.subCreate.rootPath)
      if (canAssign) {
         subCreate = userMeta.subCreate
      } else {
        return {
          success: false,
          message: "You do not have assign permission to '" + userMeta.subCreate.rootPath + "'",
          meta: {}
        }
      }
    }

    const onlyMeta = { meta: userMeta.meta, userId:  "", uid: this.user.uid, roles:{}, specialPermissions:{}, isTemplate, subCreate, templateUserId: "" };

    const docRef =  await addDoc(collection(this.db, "staged-users"), onlyMeta );
    for (const role of roles) {
      await this.storeUserRoles(docRef.id, role.collectionPath, role.role);
    }
    for (const specialPermission of specialPermissions) {
      await this.storeUserSpecialPermissions(
        docRef.id,
        specialPermission.collectionPath,
        specialPermission.permissions
      );
    }
    return {
      success: true,
      message: "line 984",
      meta: {}
    }
  };

  public logOut = (): void => {
    for (const key of Object.keys(this.unsubscribe)) {
      if (this.unsubscribe[key] instanceof Function) {
        this.unsubscribe[key]();
        this.unsubscribe[key] = null;
        this.data[key] = {};
      }
    }
    signOut(this.auth).then(() => {
      this.user.uid = null;
      this.user.firebaseUser = null;
      this.user.oAuthCredential.accessToken = "";
      this.user.oAuthCredential.idToken = "";
      this.user.email = "";
      this.user.loggedIn = false;
      this.user.loggingIn = false;
      this.user.meta = {};
      this.user.roles = [];
      this.user.specialPermissions = [];
      this.user.stagedDocId = null;
    })
  };


  public logIn = (credentials: Credentials): void => {
    this.logOut();
    signInWithEmailAndPassword(
      this.auth,
      credentials.email,
      credentials.password
    )
    .then(() => {
     // Do nothing
    })
    .catch((error) => {
      this.user.email = "";
      this.user.uid = null;
      this.user.firebaseUser = null;
      this.user.oAuthCredential.accessToken = "";
      this.user.oAuthCredential.idToken = "";
      this.user.loggedIn = false;
      this.user.logInError = true;
      this.user.loggingIn = false;
      this.user.logInErrorMessage = error.code + ": " + error.message;
    });
  };

  // Keeping this for reference on how to Type a Ref.
  // const user = ref<UserDataObject>({
  //   uid: null,
  //   email: "",
  //   loggedIn: false,
  //   logInError: false,
  //   logInErrorMessage: ""
  // });

  // Simple Store Items (add matching key per firebase collection)
  public data: CollectionDataObject = reactive({});

  public unsubscribe: CollectionUnsubscribeObject = reactive({});
  
  public user: UserDataObject = reactive({
    uid: null,
    email: "",
    loggingIn: null,
    loggedIn: false,
    logInError: false,
    logInErrorMessage: "",   
    meta: {},
    roles: [],
    specialPermissions: [],
    stagedDocId: null,
    firebaseUser: null,
    oAuthCredential: {accessToken: "", idToken: ""},
  });

  public state = reactive({
   permissions: {
      'admin': {'assign': true, 'delete': true, 'read': true, 'write': true},
      'editor': {'assign': false, 'delete': true, 'read': true, 'write': true},
      'user': {'assign': false, 'delete': false, 'read': true, 'write': false},
      'writer': {'assign': false, 'delete': false, 'read': true, 'write': true}
    },
    users: {},
    registrationCode: "",
    registrationMeta: {},
    ruleHelpers: {},
    currentUploadProgress: 0,
  });

  public getDocData = async (
    collectionPath: string,
    docId: string
  ): Promise<{ [key: string]: unknown }> => {
    const canRead = await this.permissionCheck("read", collectionPath + "/" + docId);
    if (canRead) {
      const docRef = doc(this.db, collectionPath, docId);
      const docSnap = await getDoc(docRef);
      const docData = docSnap.data();
      docData.docId = docSnap.id;
      return docData;
    }
    return {
      success: false,
      message: "Permission Denied",
      meta: {}
    }
  };

  private collectionExists = (
    collectionPath: string
  ): boolean => {
    return true;
  };

  private getStaticData = async (
    collectionPath: string,
    queryList: FirestoreQuery[] = [],
    orderList: FirestoreOrderBy[] = [],
    max = 0,
    last: DocumentData | null = null
  ): Promise<StaticDataResult> => {
    const data: object = {};
    let nextLast: DocumentData | null = null;
    const canRead = await this.permissionCheck("read", collectionPath);
    if (canRead) {
      const q = this.getQuery(collectionPath, queryList, orderList, max, last);

      const docs = await getDocs(q);

      nextLast = docs.docs[docs.docs.length - 1];
      docs.forEach((doc) => {
        const item = doc.data();
        item.docId = doc.id;
        data[doc.id] = item;
      });
    }
    return { data, next: nextLast };
  };

  private getTotalCount = async (
    collectionPath: string,
    queryList: FirestoreQuery[] = []
  ): Promise<number> => {
    console.log('getTotalCount')
    console.log(collectionPath )
    console.log(queryList)
    const q = this.getQuery(collectionPath, queryList);
    const snapshot = await getCountFromServer(q);
    return snapshot.data().count;
  };

  get SearchStaticData() {
    const getStaticData = this.getStaticData;
    const permissionCheckOnly = this.permissionCheckOnly;
    const getTotalCount = this.getTotalCount;
    const sendResponse = this.sendResponse;
    return class {
      private collectionPath = "";
      private queryList: FirestoreQuery[] = [];
      private orderList: FirestoreOrderBy[] = [];
      private max = 0;

      public results = reactive({
        data: {},
        pagination: [],
        staticIsLastPage: true,
        staticIsFirstPage: true,
        staticCurrentPage: "",
        total: 0
      });

      public prev = async (): Promise<void> => {
        const findIndex = this.results.pagination.findIndex(
          (x) => x.key === this.results.staticCurrentPage
        );
        let last = null;
        if (findIndex === 1) {
          this.results.staticCurrentPage = "";
          this.results.staticIsLastPage = false;
          this.results.staticIsFirstPage = true;
        } else {
          last = this.results.pagination[findIndex - 2].next;
          this.results.staticCurrentPage =
            this.results.pagination[findIndex - 2].key;
        }
        await this.afterNextPrev(last);
      };

      public next = async (): Promise<void> => {
        const findIndex = this.results.pagination.findIndex(
          (x) => x.key === this.results.staticCurrentPage
        );
        const last = this.results.pagination[findIndex].next;
        if (this.results.pagination.length === 1) {
          this.results.staticIsFirstPage = true;
        } else {
          this.results.staticIsFirstPage = false;
        }
        await this.afterNextPrev(last);
      };

      private afterNextPrev = async (last): Promise<void> => {
        let results = await getStaticData(
          this.collectionPath,
          this.queryList,
          this.orderList,
          this.max,
          last
        );

        if (last && Object.keys(results.data).length === 0) {
          this.results.staticIsLastPage = true;
          if (this.results.pagination.length === 1) {
            last = null;
            this.results.staticCurrentPage = "";
            this.results.staticIsFirstPage = true;
          } else {
            last =
              this.results.pagination[this.results.pagination.length - 2].next;
            this.results.staticCurrentPage =
              this.results.pagination[this.results.pagination.length - 2].key;
          }
          results = await getStaticData(
            this.collectionPath,
            this.queryList,
            this.orderList,
            this.max,
            last
          );
        } else {
          this.results.staticIsLastPage = false;
          if (this.results.pagination.length === 1) {
            this.results.staticIsFirstPage = false;
          }
        }
        this.results.data = results.data;
        this.results.staticCurrentPage = results.next.id;
        if (!this.results.staticIsLastPage) {
          if (results.next) {
            const findItem = this.results.pagination.find(
              (x) => x.key === results.next.id
            );
            if (!findItem) {
              this.results.pagination.push({
                key: results.next.id,
                next: results.next
              });
            }
          }
        }
      };

      public getData = async (
        collectionPath: string,
        queryList: FirestoreQuery[] = [],
        orderList: FirestoreOrderBy[] = [],
        max = 0
      ): Promise<actionResponse> => {
        const canRead = permissionCheckOnly("read", collectionPath);

        if (canRead) {
          this.collectionPath = collectionPath;
          this.queryList = queryList;
          this.orderList = orderList;
          this.max = max;
          this.results.staticIsLastPage = true;
          this.results.staticIsFirstPage = true;
          this.results.staticCurrentPage = "";
          this.results.pagination = [];
          this.results.data = {};
          const results = await getStaticData(
            collectionPath,
            queryList,
            orderList,
            max
          );
          this.results.total = await getTotalCount(this.collectionPath, this.queryList);
          if (Object.keys(results.data).length > 0) {
            this.results.staticIsLastPage = false;
            this.results.data = results.data;
            this.results.staticCurrentPage = results.next.id;
            this.results.pagination.push({
              key: results.next.id,
              next: results.next
            });
          } else {
            this.results.staticIsLastPage = true;
            this.results.staticIsFirstPage = true;
          }
          return sendResponse({
            success: true,
            message: "line 1258",
            meta: {}
          });
        } else {
          return sendResponse({
            success: false,
            message: `You do not have permission to read from "${collectionPath}"`,
            meta: {}
          });
        }
      };
    };
  }

  private getQuery = (
    collectionPath: string,
    queryList: FirestoreQuery[] = [],
    orderList: FirestoreOrderBy[] = [],
    max = 0,
    after: DocumentData | null = null
  ): Query => {
    const queryConditions: QueryConstraint[] = queryList.map((condition) =>
      where(condition.field, condition.operator, condition.value)
    );

    const orderConditions: QueryConstraint[] = orderList.map((condition) =>
      orderBy(condition.field, condition.direction)
    );

    let limitList: FirestoreLimit[] = [];
    if (max > 0) {
      limitList = [{ limit: max }];
    }

    const limitConditions: QueryConstraint[] = limitList.map((condition) =>
      limit(condition.limit)
    );
    if (after) {
      return query(
        collection(this.db, collectionPath),
        ...queryConditions,
        ...orderConditions,
        ...limitConditions,
        startAfter(after)
      );
    }
    return query(
      collection(this.db, collectionPath),
      ...queryConditions,
      ...orderConditions,
      ...limitConditions
    );
  };

  public startDocumentSnapshot = async (
    collectionPath: string,
    docId: string
  ): Promise<actionResponse> => {
    const canRead = await this.permissionCheck("read", collectionPath + '/' + docId);
    this.data[collectionPath + '/' + docId] = {};
    this.stopSnapshot(collectionPath + '/' + docId);
    this.unsubscribe[collectionPath + '/' + docId] = null;
    if (canRead) {
      const docRef = doc(this.db, collectionPath, docId);
      
      return new Promise<actionResponse>((resolve, reject) => {
        let firstRun = true;
        const unsubscribe = onSnapshot(docRef, (doc) => {
          if (doc.exists()) {
            const item = doc.data();
            item.docId = doc.id;
            this.data[collectionPath + '/' + docId] = item;

            // Only resolve the Promise on first run of onSnapshot if document exists
            if(firstRun) {
              firstRun = false;
              resolve(this.sendResponse({
                success: true,
                message: "startDocumentSnapshot " + collectionPath + '/' + docId,
                meta: {}
              }));
            }
          } else {
            this.data[collectionPath + '/' + docId] = {};

            // Resolve the Promise with failure response if no document exists
            if(firstRun) {
              firstRun = false;
              resolve(this.sendResponse({
                success: false,
                message: `No document found in "${collectionPath}/${docId}"`,
                meta: {}
              }));
            }
          }
        }, (error) => {
          // Reject the Promise with the error response
          reject(this.sendResponse({
            success: false,
            message: `Error fetching document from "${collectionPath}/${docId}": ${error.message}`,
            meta: {}
          }));
        });
        this.unsubscribe[collectionPath + '/' + docId] = unsubscribe;
      });
    } else {
      return this.sendResponse({
        success: false,
        message: `You do not have permission to read from "${collectionPath}"`,
        meta: {}
      });
    }
  };


  public startSnapshot = async (
    collectionPath: string,
    queryList: FirestoreQuery[] = [],
    orderList: FirestoreOrderBy[] = [],
    max = 0
  ): Promise<actionResponse> => {
    const canRead = await this.permissionCheck("read", collectionPath);
    this.data[collectionPath] = {};
    this.stopSnapshot(collectionPath);
    this.unsubscribe[collectionPath] = null;
    if (canRead) {
      const q = this.getQuery(collectionPath, queryList, orderList, max);
      return new Promise<actionResponse>((resolve, reject) => {
        let firstRun = true;
        const unsubscribe = onSnapshot(q, (querySnapshot) => {
          const items = {};
          querySnapshot.forEach((doc) => {
            const item = doc.data();
            item.docId = doc.id;
            items[doc.id] = item;
          });
          this.data[collectionPath] = items;
          
          // Only resolve or reject the Promise on first run of onSnapshot
          if(firstRun) {
            if(Object.keys(items).length > 0) { // resolve if items fetched
              firstRun = false;
              resolve(this.sendResponse({
                success: true,
                message: "startSnapshot " + collectionPath,
                meta: {}
              }));
            } else { // reject if no items fetched
              firstRun = false;
              resolve(this.sendResponse({
                success: false,
                message: `No data found in "${collectionPath}"`,
                meta: {}
              }));
            }
          }
        }, (error) => {
          // Reject the Promise with the error response
          reject(this.sendResponse({
            success: false,
            message: `Error fetching data from "${collectionPath}": ${error.message}`,
            meta: {}
          }));
        });
        this.unsubscribe[collectionPath] = unsubscribe;
      });
    } else {
      return this.sendResponse({
        success: false,
        message: `You do not have permission to read from "${collectionPath}"`,
        meta: {}
      });
    }
  };
  

  private usersSnapshotStarting = false;

  public startUsersSnapshot = async(collectionPath = ''): Promise<void> => {
    console.log('startUsersSnapshot', collectionPath);
    console.log(this.usersSnapshotStarting)
    if (!this.usersSnapshotStarting) {
      console.log('startUsersSnapshot', collectionPath);
      this.usersSnapshotStarting = true;
      this.stopSnapshot("staged-users");
      this.state.users = {};
      if (collectionPath) {
        const canAssign = await this.permissionCheck('assign', collectionPath);
        if (canAssign) {
          const q = query(
            collection(this.db, "staged-users"),
            where(
              "collectionPaths",
              "array-contains",
              collectionPath.replaceAll('/', '-')
            )
          )
          const unsubscribe = await onSnapshot(q, (querySnapshot) => {
            const items = {};
            querySnapshot.forEach((doc) => {
              const user = doc.data();
              const docId = doc.id;
              const newRoles = [];
              const newSpecialPermissions = [];

              if (user.roles) {
                const roles: role[] = Object.values(user.roles);
                for (const role of roles) {
                  if (this.permissionCheckOnly('assign', role.collectionPath)) {
                    newRoles.push(role)
                  }
                }
              }
              if (user.specialPermissions) {
                const permissions: specialPermission[] = Object.values(user.specialPermissions);
                for (const permission of permissions) {
                  if (this.permissionCheckOnly('assign', permission.collectionPath)) {
                    newSpecialPermissions.push(permission)
                  }
                }
              }
              const item = {
                docId,
                email: user.email,
                roles: newRoles,
                specialPermissions: newSpecialPermissions,
                meta: user.meta,
                last_updated: user.last_updated,
                isTemplate: user.isTemplate,
                subCreate: user.subCreate,
                userId: user.userId,
                uid: user.uid
              }
              items[doc.id] = item;
            });
            this.state.users = items;
          });
          this.unsubscribe["staged-users"] = unsubscribe;
        } else {
          const q = query(
            collection(this.db, "public-users"),
            where(
              "collectionPaths",
              "array-contains",
              collectionPath.replaceAll('/', '-')
            )
          )
          const unsubscribe = await onSnapshot(q, (querySnapshot) => {
            const items = {};
            querySnapshot.forEach((doc) => {
              const user = doc.data();
              const docId = doc.id;
              const item = {
                docId,
                meta: user.meta,
                userId: user.userId,
              }
              items[doc.id] = item;
            });
            this.state.users = items;
          });
          this.unsubscribe["staged-users"] = unsubscribe;
        }
      }
    };
    this.usersSnapshotStarting = false;
  };

  public removeUserRoles = async (
    docId: string,
    collectionPath: string
  ): Promise<actionResponse> => {
    let canAssign = await this.permissionCheck("assign", collectionPath);
    if (docId === this.user.stagedDocId) {
      // User can remove themselves from any role
      canAssign = true;
    }
    if (canAssign) {
      await updateDoc(doc(this.db, "staged-users/" + docId), {
        uid: this.user.uid,
        collectionPaths: arrayRemove(collectionPath.replaceAll("/", "-")),
        ["roles." + collectionPath.replaceAll("/", "-")]: deleteField()
      });
      return this.sendResponse({
        success: true,
        message: "line 1492",
        meta: {}
      });
    } else {
      return this.sendResponse({
        success: false,
        message:
          "Cannot remove permissions for collection path: " + collectionPath,
          meta: {}
      });
    }
  };

  public removeUserSpecialPermissions = async (
    docId: string,
    collectionPath: string
  ): Promise<actionResponse> => {
    let canAssign = await this.permissionCheck("assign", collectionPath);
    if (docId === this.user.stagedDocId) {
      // User can remove themselves from any special permission
      canAssign = true;
    }
    if (canAssign) {
      await updateDoc(doc(this.db, "staged-users/" + docId), {
        uid: this.user.uid,
        collectionPaths: arrayRemove(collectionPath.replaceAll("/", "-")),
        ["specialPermissions." + collectionPath.replaceAll("/", "-")]:
          deleteField()
      });
      return this.sendResponse({
        success: true,
        message: "line 1523",
        meta: {}
      });
    } else {
      return this.sendResponse({
        success: false,
        message:
          "Cannot remove permissions for collection path: " + collectionPath,
          meta: {}
      });
    }
  };

  public storeUserSpecialPermissions = async (
    docId: string,
    collectionPath: string,
    permissions: permissions
  ): Promise<actionResponse> => {
    const canAssign = await this.permissionCheck("assign", collectionPath);
    if (canAssign) {
      const collectionExists = await this.collectionExists(collectionPath);
      if (collectionExists) {
        const permissionItem = {
          ["specialPermissions." + collectionPath.replaceAll("/", "-")]: {
            collectionPath: collectionPath.replaceAll("/", "-"),
            permissions
          },
          uid: this.user.uid
        };
        await updateDoc(doc(this.db, "staged-users/" + docId), {
          ...permissionItem,
          collectionPaths: arrayUnion(collectionPath.replaceAll("/", "-")),
          uid: this.user.uid
        });
        return this.sendResponse({
          success: true,
          message: "line 1559",
          meta: {}
        });
      } else {
        return this.sendResponse({
          success: false,
          message: collectionPath + " is not a valid collection path",
          meta: {}
        });
      }
    } else {
      return this.sendResponse({
        success: false,
        message:
          "Cannot assign permissions for collection path: " + collectionPath,
        meta: {}
      });
    }
  };

  private storeUserRoles = async (
    docId: string,
    collectionPath: string,
    role: "admin" | "editor" | "writer" | "user"
  ): Promise<actionResponse> => {
    const canAssign = await this.permissionCheck("assign", collectionPath);
    if (canAssign) {
      if (role === "admin" || role === "user" || role === "editor" || role === "writer") {
        const collectionExists = await this.collectionExists(collectionPath);
        if (collectionExists) {
          const roleItem = {
            ["roles." + collectionPath.replaceAll("/", "-")]: {
              collectionPath: collectionPath.replaceAll("/", "-"),
              role
            },
            uid: this.user.uid
          };
          await updateDoc(doc(this.db, "staged-users/" + docId), {
            ...roleItem,
            collectionPaths: arrayUnion(collectionPath.replaceAll("/", "-")),
            uid: this.user.uid } );
          return this.sendResponse({
            success: true,
            message: "line 1602",
            meta: {}
          });
        } else {
          return this.sendResponse({
            success: false,
            message: collectionPath + " is not a valid collection path",
            meta: {}
          });
        }
      } else {
        return this.sendResponse({
          success: false,
          message: "Role must be either 'admin' or 'editor' or 'writer' or 'user'",
          meta: {}
        });
      }
    } else {
      return this.sendResponse({
        success: false,
        message:
          "Cannot assign permissions for collection path: " + collectionPath,
        meta: {}
      });
    }
  };

  public removeCollectionPermissions = async (
    collectionPath: string,
  ): Promise<actionResponse> => {
    const canAssign = await this.permissionCheck("assign", collectionPath);
    if (canAssign) {
      await deleteDoc(doc(this.db, "collection-data", collectionPath.replaceAll("/", "-")));
      return this.sendResponse({
        success: true,
        message: "line 1637",
        meta: {}
      });
    } else {
      return this.sendResponse({
        success: false,
        message: "Cannot remove permissions for collection path: " + collectionPath,
        meta: {}
      });
    }
  };

  public storeCollectionPermissions = async (
    collectionPath: string,
    role: "admin" | "editor" | "writer" | "user",
    permissions: permissions
  ): Promise<actionResponse> => {
    const canAssign = await this.permissionCheck("assign", collectionPath);
    if (canAssign) {
      if (role === "admin" || role === "editor" || role === "writer" || role === "user") {
        const currentTime = new Date().getTime();

        const collectionItem = {
          collectionPath: collectionPath.replaceAll("/", "-"),
          docId: collectionPath.replaceAll("/", "-")
        };
        const collectionRef = doc(
          this.db,
          "collection-data",
          collectionItem.collectionPath
        );
        const collectionSnap = await getDoc(collectionRef);
        if (!collectionSnap.exists()) {
          await setDoc(
            doc(this.db, "collection-data", collectionItem.collectionPath),
            collectionItem
          );
        }
        await updateDoc(
          doc(this.db, "collection-data/" + collectionItem.collectionPath),
          { [role]: permissions, uid: this.user.uid, last_updated: currentTime }
        );

        return this.sendResponse({
          success: true,
          message: "line 1682",
          meta: {}
        });
      } else {
        return this.sendResponse({
          success: false,
          message: "Role must be either 'admin' or 'editor' or 'writer' or 'user'",
          meta: {}
        });
      }
    } else {
      return this.sendResponse({
        success: false,
        message:
          "Cannot assign permissions for collection path: " + collectionPath,
        meta: {}
      });
    }
  };

  public changeDoc = async (
    collectionPath: string,
    docId: string,
    item: object
  ): Promise<actionResponse> => {
    const canWrite = await this.permissionCheck("write", collectionPath + "/" + docId);
    if (!canWrite) {
      return this.sendResponse({
        success: false,
        message: `You do not have permission to write to "${collectionPath}/${docId}"`,
        meta: {}
      });
    } else {
      const docRef = doc(this.db, collectionPath, docId);
      const docSnap = await getDoc(docRef);
      if (!docSnap.exists()) {
        return this.sendResponse({
          success: false,
          message: `Document "${docId}" does not exist in "${collectionPath}"`,
          meta: {}
        });
      }
      const cloneItem = JSON.parse(JSON.stringify(item));
      const currentTime = new Date().getTime();
      cloneItem.last_updated = currentTime;
      cloneItem.uid = this.user.uid;
      await updateDoc(doc(this.db, collectionPath, docId), cloneItem);
      return this.sendResponse({
        success: true,
        message: "line 1731",
        meta: {}
      });
    }
  };

  public storeDocRaw = async (
    collectionPath: string,
    item: object,
    docId?: string,
  ): Promise<actionResponse> => {
    const cloneItem = JSON.parse(JSON.stringify(item));
    cloneItem.uid = this.user.uid;
    if (docId !== undefined) {
      await setDoc( doc(this.db, collectionPath, docId), cloneItem);
    } else {
      await addDoc(
        collection(this.db, collectionPath),
        cloneItem
      );
    }
    return this.sendResponse({
      success: true,
      message: "line 1754",
      meta: {}
    });
  }


  public storeDoc = async (
    collectionPath: string,
    item: object,
  ): Promise<actionResponse> => {
    
    const cloneItem = JSON.parse(JSON.stringify(item));
    const currentTime = new Date().getTime();
    cloneItem.last_updated = currentTime;
    cloneItem.uid = this.user.uid;
    if (!Object.prototype.hasOwnProperty.call(cloneItem, "doc_created_at")) {
      cloneItem.doc_created_at = currentTime;
    }
    if (Object.prototype.hasOwnProperty.call(cloneItem, "docId")) {
      const canWrite = await this.permissionCheck("write", collectionPath + "/" + cloneItem.docId);
      if (!canWrite) {
        return this.sendResponse({
          success: false,
          message: `You do not have permission to write to "${collectionPath}/${cloneItem.docId}"`,
          meta: {}
        });
      }
      const docId = cloneItem.docId;
      const canRead = this.permissionCheckOnly("read", collectionPath);
      if (canRead) {
        if (Object.prototype.hasOwnProperty.call(this.data, collectionPath)) {
          this.data[collectionPath][docId] = cloneItem;
        }
      }
      await setDoc(doc(this.db, collectionPath, docId), cloneItem);
      return this.sendResponse({
        success: true,
        message: "line 1791",
        meta: {docId}
      });
    } else {
      const canWrite = await this.permissionCheck("write", collectionPath);
      if (!canWrite) {
        return this.sendResponse({
          success: false,
          message: `You do not have permission to write to "${collectionPath}"`,
          meta: {}
        });
      }
      const docRef = await addDoc(
        collection(this.db, collectionPath),
        cloneItem
      );
      const canRead = this.permissionCheckOnly("read", collectionPath);
      if (canRead) {
        if (Object.prototype.hasOwnProperty.call(this.data, collectionPath)) {
          this.data[collectionPath][docRef.id] = cloneItem;
        }
      }
      await this.storeDoc(
        collectionPath,
        { ...cloneItem, docId: docRef.id }
      );
      return this.sendResponse({
        success: true,
        message: "1819",
        meta: {docId: docRef.id}
      });
    }
    
  };

  public removeDoc = async (
    collectionPath: string,
    docId: string
  ): Promise<actionResponse> => {
    const canDelete = await this.permissionCheck("delete", collectionPath);
    if (canDelete) {
      if (Object.prototype.hasOwnProperty.call(this.data, collectionPath)) {
        if (
          Object.prototype.hasOwnProperty.call(this.data[collectionPath], docId)
        ) {
          delete this.data[collectionPath][docId];
        }
      }
      await deleteDoc(doc(this.db, collectionPath, docId));
      return this.sendResponse({
        success: true,
        message: "line 1842",
        meta: {}
      });
    } else {
      return this.sendResponse({
        success: false,
        message: `You do not have permission to delete from "${collectionPath}"`,
        meta: {}
      });
    }
  };

  public stopSnapshot = (collectionPath: string): void => {
    if (this.unsubscribe[collectionPath] instanceof Function) {
      this.unsubscribe[collectionPath]();
      this.unsubscribe[collectionPath] = null;
    }
  };


  // File functions
  // TODO... add object to pass merge with customMetadata as var....
  public uploadFile = async (orgId: string, file: Blob,  filePath: string = "", isPublic: boolean = false, toR2: boolean = false): Promise<actionResponse> => {
   // Finish toCF function hook.
    this.state.currentUploadProgress = 0;
    let collectionPath = "organizations/" + orgId;
    if (filePath) {
      collectionPath = "organizations/" + orgId + "/" + filePath;
    }
    // Validate if file is provided
    if (!file) {
      return this.sendResponse({
        success: false,
        message: "No file provided for upload.",
        meta: {}
      });
    }
  
    // Check if the user has write permission to the filePath
    let hasWritePermission = await this.permissionCheck("write", collectionPath);
    if (isPublic) {
      hasWritePermission = true;
      filePath = "public";
      collectionPath = "public";
    }
    if (!hasWritePermission) {
      return this.sendResponse({
        success: false,
        message: "You do not have permission to upload files to this path.",
        meta: {}
      });
    }
  
    try {

      const fileDoc = {
        orgId,
        contentType: file.type,
        uploadCompletedToR2: false,
        fileName: file.name,
        name: file.name,
        fileSize: file.size,
        directory: filePath,
        filePath: '',
        r2FilePath: '',
        r2URL: '',
        isPublic: isPublic,
        toR2: toR2,
        uploadCompleted: false,
        uploadTime: new Date().getTime(), 
      };

      const result: any =  await this.runFunction("edgeFirebase-addUpdateFileDoc", fileDoc);
      const fileDocId = (result.data as { docId: string }).docId;
      let tempFilePath = `${collectionPath.replaceAll('/', '-')}` + '/' + fileDocId + '-' + file.name;
      if (isPublic) {
        tempFilePath = `${collectionPath.replaceAll('/', '-')}` + '/' + orgId + '-' + fileDocId + '-' + file.name;
      }
      await this.runFunction("edgeFirebase-addUpdateFileDoc", {orgId, docId: fileDocId, filePath: tempFilePath });
      const storage = getStorage();
      const fileRef = ref(storage, tempFilePath);
  
      const metadata = {
        cacheControl: isPublic ? 'public, max-age=31536000' : undefined,
        customMetadata: {
          orgId,
          uid: this.user.uid,
          contentType: file.type,
          fileName: file.name,
          name: file.name,
          fileSize: file.size.toString(),
          directory: filePath,
          fileDocId: fileDocId,
          filePath: tempFilePath,
          r2FilePath: '',
          r2URL: '',
          isPublic: isPublic ? 'true' : '',
          toR2: toR2 ? 'true' : '', 
        }
      };
  
      // Resumable upload
      const uploadTask = uploadBytesResumable(fileRef, file, metadata);
  
      // Wrap the upload task in a Promise
      const uploadPromise = new Promise<actionResponse>((resolve, reject) => {
        uploadTask.on('state_changed',
          (snapshot) => {
            // Progress, pause, and resume events
            const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
            this.state.currentUploadProgress = progress;
          },
          (error) => {
            // Handle unsuccessful uploads
            reject(this.sendResponse({
              success: false,
              message: "An error occurred during file upload.",
              meta: { error: error.message, fileDocId}
            }));
          },
          () => {
            // Handle successful uploads on complete
            resolve(this.sendResponse({
              success: true,
              message: "File uploaded successfully.",
              meta: { file: tempFilePath, fileDocId }
            }));
          }
        );
      });
     
      
      const uploadStatus = await uploadPromise;
      await this.runFunction("edgeFirebase-addUpdateFileDoc", {orgId, docId: fileDocId, uploadStatus, uploadCompleted: true });
      return uploadStatus;
  
    } catch (error) {
      return this.sendResponse({
        success: false,
        message: "An error occurred during file upload.",
        meta: { error: error.message }
      });
    }
  };
  

  public deleteFile = async (filePath: string): Promise<actionResponse> => {
    let hasDeletePermission = await this.permissionCheck("write", filePath);
    if (filePath.substring(0, 6) === 'public') {
      hasDeletePermission = true;
    }
    if (!hasDeletePermission) {
      return this.sendResponse({
        success: false,
        message: "You do not have permission to delete files in this path.",
        meta: {}
      });
    }
    try {
      const fileRef = ref(this.storage, filePath);
      await deleteObject(fileRef);
      this.sendResponse({
              success: true,
              message: "File deleted successfully.",
              meta: {}
            });
    } catch (error) {
      return this.sendResponse({
        success: false,
        message: "An error occurred during file deletion.",
        meta: {}
      });
    }
  };

  public listFiles = async (filePath: string): Promise<actionResponse> => {
    const hasReadPermission = await this.permissionCheck("read", filePath);
    if (!hasReadPermission) {
      return this.sendResponse({
        success: false,
        message: "You do not have permission to list files in this path.",
        meta: {}
      });
    }
  
    try {
      const listRef = ref(this.storage, filePath.replaceAll('/', '-'));
      const listResult = await listAll(listRef);
      const filesPromises = listResult.items.map(async (item) => {
        const downloadURL = await getDownloadURL(item);
        const metadata = await getMetadata(item);
        const fileName = metadata?.customMetadata?.name || item.name;
        return {
          fileName,
          fullPath: item.fullPath, // Assuming fullPath is a property available on the item
          downloadURL: downloadURL,
          metadata: metadata.customMetadata
        };
      });
      const files = await Promise.all(filesPromises);
      return this.sendResponse({
        success: true,
        message: "Files listed successfully.",
        meta: { files }
      });
    } catch (error) {
      return this.sendResponse({
        success: false,
        message: "An error occurred while listing files.",
        meta: {}
      });
    }
  }
};