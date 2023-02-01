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
  connectAuthEmulator,
} from "firebase/auth";

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
  loggedIn: boolean;
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
  subCreate?: {rootPath: string, role: string};
}

interface userRegister {
  email: string;
  password: string;
  meta: object;
  registrationCode: string;
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
  emulatorFirestore?: string;
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

export const EdgeFirebase = class {
  constructor(
    firebaseConfig: firebaseConfig = {
      apiKey: "",
      authDomain: "",
      projectId: "",
      storageBucket: "",
      messagingSenderId: "",
      appId: "",
      emulatorAuth: "",
      emulatorFirestore: ""
    },
    isPersistant: false
  ) {
    this.firebaseConfig = firebaseConfig;
    this.app = initializeApp(this.firebaseConfig);
    let persistence: Persistence = browserSessionPersistence;
    if (isPersistant) {
      persistence = browserLocalPersistence;
    }

    this.auth = initializeAuth(this.app, { persistence });
    if (this.firebaseConfig.emulatorAuth) {
      connectAuthEmulator(this.auth, `http://localhost:${this.firebaseConfig.emulatorAuth}`)
    }

    this.db = getFirestore(this.app);
    if (this.firebaseConfig.emulatorFirestore) {
      connectFirestoreEmulator(this.db, "localhost", this.firebaseConfig.emulatorFirestore)
    }

    this.setOnAuthStateChanged();
  }

  private firebaseConfig = null;
  private newRegistration = null;
  private newRegistrationStagedUser = null;

  public app = null;
  public auth = null;
  public db = null;

  private initUserMetaPermissions = async (): Promise<void> => {
    this.user.meta = {};
    const docRef = doc(this.db, "users", this.user.uid);
    const docSnap = await getDoc(docRef);
    console.log('data')
    console.log(docSnap.data())
    if (docSnap) {
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
    console.log(this.user)
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
    this.unsubscibe.userMeta = metaUnsubscribe;
  };

  private startCollectionPermissionsSync = async (): Promise<void> => {
    // TODO: In future get roles from user and only sync those collections 
    // Perhaps by getting all "first segments" and get all that start with that
    const q = this.getQuery('collection-data');
    const docs = await getDocs(q);
    let items = {}
    docs.forEach((doc) => {
      const item = doc.data();
      item.docId = doc.id;
      items[doc.id] = item;
    });
    this.state.collectionPermissions = items;
    if (!this.state.collectionPermissions['-default-']) {
      const collectionItem = {
        collectionPath:  '-default-',
        docId: '-default-',
        admin: {
          assign: true,
          read: true,
          write: true,
          delete: true
        },
        editor: {
          assign: false,
          read: true,
          write: true,
          delete: true
        },
        writer: {
          assign: false,
          read: true,
          write: true,
          delete: false
        },
        user: {
          assign: false,
          read: true,
          write: false,
          delete: false
        }
      };
      await setDoc(
        doc(this.db, "collection-data", "-default-"),
        collectionItem
      );
    }
    this.stopSnapshot('collection-data');
    const unsubscribe = onSnapshot(q, (querySnapshot) => {
      items = {};
      querySnapshot.forEach((doc) => {
        const item = doc.data();
        item.docId = doc.id;
        items[doc.id] = item;
      });
      this.state.collectionPermissions = items;
    });
    this.unsubscibe['collection-data'] = unsubscribe
  }



  private startUserMetaSync = async (): Promise<void> => {
    await this.startCollectionPermissionsSync()
    await this.initUserMetaPermissions();
    this.user.loggedIn = true;
  };

  private setOnAuthStateChanged = (): void => {
    onAuthStateChanged(this.auth, (userAuth) => {
      if (userAuth) {
        this.user.email = userAuth.email;
        this.user.uid = userAuth.uid;
        this.user.logInError = false;
        this.user.logInErrorMessage = "";
        if (this.newRegistration) {
          let metaUpdate = {};
          if (Object.prototype.hasOwnProperty.call(this.newRegistration, 'meta')) {
            metaUpdate = this.newRegistration.meta;
          }else{
            metaUpdate = this.newRegistrationStagedUser.meta;
          }

          let stagedUserUpdate: {userId?: string, templateUserId?: string, uid: string} = {userId: this.user.uid, uid: this.user.uid}
          if (this.newRegistrationStagedUser.isTemplate) {
            stagedUserUpdate = {templateUserId: this.user.uid, uid: this.user.uid}
          }
          const userData = {roles: this.newRegistrationStagedUser.roles, specialPermissions: this.newRegistrationStagedUser.specialPermissions, meta: metaUpdate, uid: this.user.uid, userId: this.user.uid, stagedDocId: this.newRegistration.registrationCode}
          const initRoleHelper = {uid: this.user.uid}
          initRoleHelper["edge-assignment-helper"] = {permissionType: "roles"}
          setDoc(doc(this.db, "rule-helpers", this.user.uid), initRoleHelper).then(() => {
            setDoc(doc(this.db, "users/" + this.user.uid), userData).then(() => {
              updateDoc(doc(this.db, "staged-users/" + this.newRegistration.registrationCode), stagedUserUpdate).then(() => {
                this.startUserMetaSync();
              });
            });
          });
        } else {
          this.startUserMetaSync();
        }
      } else {
        this.user.email = "";
        this.user.uid = null;
        this.user.loggedIn = false;
        this.user.logInError = false;
        this.user.logInErrorMessage = "";
      }
    });
  };
  //TODO: Add to documentation update registraiton process
  public registerUser = async (
    userRegister: userRegister
  ): Promise<actionResponse> => {
    if (!Object.prototype.hasOwnProperty.call(userRegister, 'registrationCode') || userRegister.registrationCode === "") {
      return this.sendResponse({
        success: false,
        message: "Registration code is required.",
        meta: {}
      });
    }
    const userRef = doc(this.db, "staged-users", userRegister.registrationCode);
    const userSnap = await getDoc(userRef);
    if (userSnap.exists()) {
      const user = userSnap.data();
      if (user.userId) {
        return this.sendResponse({
          success: false,
          message: "User already registered",
          meta: {}
        });
      } else {
        // TODO: check if user is already registered, if so return error with auth
        this.newRegistration = userRegister;
        this.newRegistrationStagedUser = user;
        const response = await createUserWithEmailAndPassword(
          this.auth,
          userRegister.email,
          userRegister.password
        );
        
        return this.sendResponse({
          success: true,
          message: "",
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
        message: "",
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
        message: "",
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
        message: "",
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

  public setUserMeta = async (meta: unknown): Promise<actionResponse> => {
    //TODO: Change setUserMeta to also be used by someone with assign permissions and 
    // add a permissionCheck here for it.
    for (const [key, value] of Object.entries(meta)) {
      await updateDoc(doc(this.db, "staged-users/" + this.user.stagedDocId), {
        ["meta." + key]: value, uid: this.user.uid
      });
    }
    return this.sendResponse({
      success: true,
      message: "",
      meta: {}
    });
  };

  public removeUser = async (docId: string): Promise<actionResponse> => {
    const removedFrom = [];
    const userRef = doc(this.db, "users", docId);
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
          this.removeUserSpecialPermissions(
            docId,
            collectionPath.replaceAll("-", "/")
          );
          removedFrom.push(collectionPath.replaceAll("-", "/"));
        }
      }
    }
    if (removedFrom.length > 0) {
      return this.sendResponse({
        success: true,
        message: "",
        meta: {}
      });
    } else {
      return this.sendResponse({
        success: false,
        message: "You do not have permission to remove this user",
        meta: {}
      });
    }
  };
  
  //TODO: Change documentation "addUser"... this only use to create a new user...
  //not to update anything.
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
      await this.generateUserMeta(newUser);
      return this.sendResponse({
        success: true,
        message: "",
        meta: {}
      });
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
          permissionData = this.getCollectionPermissions(
            permissionCheck,
            role.role
          );
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
        permissionData = this.getCollectionPermissions(
          "-",
          rootRole.role
        );
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

  private getCollectionPermissions = (
    collectionPath: string,
    role: string
  ): permissions => {
    if (Object.prototype.hasOwnProperty.call(this.state.collectionPermissions, collectionPath)) {
      if (Object.prototype.hasOwnProperty.call(this.state.collectionPermissions[collectionPath], role)) {
        const permissionData = this.state.collectionPermissions[collectionPath][role];
        return {
          read: permissionData.read,
          write: permissionData.write,
          delete: permissionData.delete,
          assign: permissionData.assign
        };
      }
    }
    if (Object.prototype.hasOwnProperty.call(this.state.collectionPermissions, '-default-')) {
      return this.state.collectionPermissions['-default-'][role];
    }
    return {
      read: false,
      write: false,
      delete: false,
      assign: false
    };
  };

  private generateUserMeta = async (userMeta: newUser): Promise<void> => {
    const roles: role[] = userMeta.roles;
    const specialPermissions: specialPermission[] = userMeta.specialPermissions;
    delete userMeta.roles;
    delete userMeta.specialPermissions;

    let isTemplate = false
    if (Object.prototype.hasOwnProperty.call(userMeta, "isTemplate") && userMeta.isTemplate) {
      isTemplate = true
    }

    let subCreate = {}
    if (Object.prototype.hasOwnProperty.call(userMeta, "subCreate")) {
      subCreate = userMeta.subCreate
    }

    const onlyMeta = { meta: userMeta.meta, userId:  "", uid: this.user.uid, roles:{}, specialPermissions:{}, isTemplate, subCreate };

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
    
  };

  public logOut = (): void => {
    Object.keys(this.unsubscibe).forEach((key) => {
      if (this.unsubscibe[key] instanceof Function) {
        this.unsubscibe[key]();
        this.unsubscibe[key] = null;
      }
    });
    signOut(this.auth).then(() => {
      this.newRegistration = null;
      this.newRegistrationStagedUser = null;
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
      // do nothing
    })
    .catch((error) => {
      this.user.email = "";
      this.user.uid = null;

      this.user.loggedIn = false;
      this.user.logInError = true;
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

  public unsubscibe: CollectionUnsubscribeObject = reactive({});
  
  public user: UserDataObject = reactive({
    uid: null,
    email: "",
    loggedIn: false,
    logInError: false,
    logInErrorMessage: "",
    meta: {},
    roles: [],
    specialPermissions: [],
    stagedDocId: null,
  });

  public state = reactive({
    collectionPermissions: {},
    users: {},
    registrationCode: "",
    registrationMeta: {},
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

  // Class for wrapping a getSaticData to handle pagination
  get SearchStaticData() {
    const getStaticData = this.getStaticData;
    const permissionCheckOnly = this.permissionCheckOnly;
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
        staticCurrentPage: ""
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
            message: "",
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

  public startSnapshot = async(
    collectionPath: string,
    queryList: FirestoreQuery[] = [],
    orderList: FirestoreOrderBy[] = [],
    max = 0
  ): Promise<actionResponse> => {
    const canRead = await this.permissionCheck("read", collectionPath);
    this.data[collectionPath] = {};
    this.stopSnapshot(collectionPath);
    this.unsubscibe[collectionPath] = null;
    if (canRead) {
      const q = this.getQuery(collectionPath, queryList, orderList, max);
      const unsubscribe = onSnapshot(q, (querySnapshot) => {
        const items = {};
        querySnapshot.forEach((doc) => {
          const item = doc.data();
          item.docId = doc.id;
          items[doc.id] = item;
        });
        this.data[collectionPath] = items;
      });
      this.unsubscibe[collectionPath] = unsubscribe;
      return this.sendResponse({
        success: true,
        message: "",
        meta: {}
      });
    } else {
      return this.sendResponse({
        success: false,
        message: `You do not have permission to read from "${collectionPath}"`,
        meta: {}
      });
    }
  };

  public startUsersSnapshot = async(collectionPath = ''): Promise<void> => {
    this.stopSnapshot('users')
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
        const unsubscibe = onSnapshot(q, (querySnapshot) => {
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
        this.unsubscibe.users = unsubscibe;
      }
    }
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
        collectionPaths: arrayRemove(collectionPath.replaceAll("/", "-")),
        ["roles." + collectionPath.replaceAll("/", "-")]: deleteField()
      });
      return this.sendResponse({
        success: true,
        message: "",
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
        collectionPaths: arrayRemove(collectionPath.replaceAll("/", "-")),
        ["specialPermissions." + collectionPath.replaceAll("/", "-")]:
          deleteField()
      });
      return this.sendResponse({
        success: true,
        message: "",
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
          message: "",
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
            message: "",
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
        message: "",
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
    // TODO: check if collectionPath starts with "users", "collection-data", "staged-users" and deny if so
    // TODO add above check to rules as well
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
          message: "",
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

  // Composable to update/add a document
  public storeDoc = async (
    collectionPath: string,
    item: object,
  ): Promise<actionResponse> => {
    const canWrite = await this.permissionCheck("write", collectionPath);
    if (!canWrite) {
      return this.sendResponse({
        success: false,
        message: `You do not have permission to write to "${collectionPath}"`,
        meta: {}
      });
    } else {
      const cloneItem = JSON.parse(JSON.stringify(item));
      const currentTime = new Date().getTime();
      cloneItem.last_updated = currentTime;
      cloneItem.uid = this.user.uid;
      if (!Object.prototype.hasOwnProperty.call(cloneItem, "doc_created_at")) {
        cloneItem.doc_created_at = currentTime;
      }
      if (Object.prototype.hasOwnProperty.call(cloneItem, "docId")) {
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
          message: "",
          meta: {docId}
        });
      } else {
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
          message: "",
          meta: {docId: docRef.id}
        });
      }
    }
  };

  // Composable to delete a document
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
        message: "",
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

  // Composable to stop snapshot listener
  public stopSnapshot = (collectionPath: string): void => {
    if (this.unsubscibe[collectionPath] instanceof Function) {
      this.unsubscibe[collectionPath]();
      this.unsubscibe[collectionPath] = null;
    }
  };
};