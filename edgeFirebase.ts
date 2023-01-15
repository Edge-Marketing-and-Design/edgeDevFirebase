import { initializeApp } from "firebase/app";
import { reactive, computed } from "vue";
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
  confirmPasswordReset
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
}

interface newUser {
  email: string;
  roles: role[];
  specialPermissions: specialPermission[];
  meta: object;
}

interface user {
  email: string;
  roles: role[];
  specialPermissions: specialPermission[];
  userId: string;
  docId: string;
  uid: string;
  last_updated: Date;
}

interface usersByEmail {
  [email: string]: [user];
}
interface userMeta extends newUser {
  docId: string;
  userId: string;
}

interface userRegister {
  email: string;
  password: string;
  meta: object;
}

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
      appId: ""
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
    this.db = getFirestore(this.app);
    this.setOnAuthStateChanged();
  }

  private firebaseConfig = null;

  public app = null;
  public auth = null;
  public db = null;

  private initUserMetaPermissions = async (): Promise<void> => {
    updateDoc(doc(this.db, "users", this.user.email), {
      userId: this.user.uid
    });
    this.user.meta = {};
    const docRef = doc(this.db, "users", this.user.email);
    const docSnap = await getDoc(docRef);
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
    }
    this.stopSnapshot('userMeta')
    const metaUnsubscribe = onSnapshot(
      doc(this.db, "users", this.user.email),
      (doc) => {
        if (!doc.exists()) {
          this.setUser({
            email: this.user.email,
            roles: [],
            specialPermissions: [],
            meta: {},
          });
          this.user.meta = {};
        } else {
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
        this.startUserMetaSync();
      } else {
        this.user.email = "";
        this.user.uid = null;
        this.user.loggedIn = false;
        this.user.logInError = false;
        this.user.logInErrorMessage = "";
      }
    });
  };

  public registerUser = async (
    userRegister: userRegister
  ): Promise<actionResponse> => {
    const userRef = doc(this.db, "users", userRegister.email);
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
        createUserWithEmailAndPassword(
          this.auth,
          userRegister.email,
          userRegister.password
        ).then(() => {
          const metaUpdate = {};
          for (const [key, value] of Object.entries(userRegister.meta)) {
            metaUpdate["meta." + key] = value;
          }
          if (Object.keys(metaUpdate).length > 0) {
            updateDoc(doc(this.db, "users", this.user.email), metaUpdate);
          }
          return this.sendResponse({
            success: true,
            message: "",
            meta: {}
          });
        });
      }
    } else {
      return this.sendResponse({
        success: false,
        message: "User doesn't exist",
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

  setUserMeta = async (meta: unknown): Promise<actionResponse> => {
    for (const [key, value] of Object.entries(meta)) {
      await updateDoc(doc(this.db, "users/" + this.user.email), {
        ["meta." + key]: value
      });
    }
    return this.sendResponse({
      success: true,
      message: "",
      meta: {}
    });
  };

  public removeUser = async (email: string): Promise<actionResponse> => {
    const removedFrom = [];
    const userRef = doc(this.db, "users", email);
    const userSnap = await getDoc(userRef);
    if (userSnap.data().roles) {
      for (const collectionPath in userSnap.data().roles) {
        const canAssign = this.permissionCheck(
          "assign",
          collectionPath.replaceAll("-", "/")
        );
        if (canAssign) {
          await this.removeUserRoles(email, collectionPath.replaceAll("-", "/"));
          removedFrom.push(collectionPath.replaceAll("-", "/"));
        }
      }
    }
    if (userSnap.data().specialPermissions) {
      for (const collectionPath in userSnap.data().specialPermissions) {
        const canAssign = this.permissionCheck(
          "assign",
          collectionPath.replaceAll("-", "/")
        );
        if (canAssign) {
          this.removeUserSpecialPermissions(
            email,
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

  public setUser = async (newUser: newUser): Promise<actionResponse> => {
    const canAssignRole = this.multiPermissionCheck(
      "assign",
      newUser.roles
    );
    const canAssignSpecialPermissions = this.multiPermissionCheck(
      "assign",
      newUser.specialPermissions
    );
    if (canAssignRole.canDo && canAssignSpecialPermissions.canDo) {
      const userRef = doc(this.db, "users", newUser.email);
      const userSnap = await getDoc(userRef);
      if (!userSnap.exists()) {
        const userMeta: userMeta = {
          docId: newUser.email,
          userId: "",
          email: newUser.email,
          roles: newUser.roles,
          specialPermissions: newUser.specialPermissions,
          meta: newUser.meta
        };
        await this.generateUserMeta(userMeta);
        return this.sendResponse({
          success: true,
          message: "",
          meta: {}
        });
      } else {
        return this.sendResponse({
          success: false,
          message: "User already exists",
          meta: {}
        });
      }
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
      if (!(this.permissionCheck(action, collection.collectionPath))) {
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

  private permissionCheck = (
    action: action,
    collectionPath: string
  ): boolean => {
    const collection = collectionPath.split("/");
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

  private generateUserMeta = async (userMeta: userMeta): Promise<void> => {
    const roles: role[] = userMeta.roles;
    const specialPermissions: specialPermission[] = userMeta.specialPermissions;
    delete userMeta.roles;
    delete userMeta.specialPermissions;

    const docRef = doc(this.db, "users", userMeta.docId);
    const docSnap = await getDoc(docRef);
    const docData = docSnap.data();
    const canWrite = this.permissionCheck("write", "users");
    if (!docData || canWrite) {
      await setDoc(doc(this.db, "users", userMeta.docId), userMeta);
    }
    for (const role of roles) {
      await this.storeUserRoles(userMeta.docId, role.collectionPath, role.role);
    }
    for (const specialPermission of specialPermissions) {
      await this.storeUserSpecialPermissions(
        userMeta.docId,
        specialPermission.collectionPath,
        specialPermission.permissions
      );
    }
  };

  // Composable to logout
  public logOut = (): void => {
    signOut(this.auth)
      .then(() => {
        Object.keys(this.unsubscibe).forEach((key) => {
          if (this.unsubscibe[key] instanceof Function) {
            this.unsubscibe[key]();
            this.unsubscibe[key] = null;
          }
        });
      })
      .catch(() => {
        // Do nothing
      });
  };

  // Composable to login and set persistence
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
  private usersByCollections: CollectionDataObject = reactive({});

  public users = computed(() => {
    const userList = {};
    const keys = Object.keys(JSON.parse(JSON.stringify(this.usersByCollections)));
    keys.forEach(key => {
      const users = this.usersByCollections[key];
      if (key.startsWith("ROLES|")) {
        const collectionPathCheck = key.replace("ROLES|", "")
        const userKeys = Object.keys(users);
        if (Object.keys(users).length > 0) {
          userKeys.forEach(userKey => {
            const user = users[userKey];
            if (!Object.prototype.hasOwnProperty.call(userList, user.docId)) {
              userList[user.email] = {
                docId: user.docId,
                email: user.email,
                roles: [{collectionPath: collectionPathCheck, role: user.roles[collectionPathCheck].role }],
                specialPermissions: [],
                meta: user.meta,
                last_updated: user.last_updated,
                userId: user.userId,
                uid: user.uid
              }
            } else {
              userList[user.email].roles.push({ collectionPath: collectionPathCheck, role: user.roles[collectionPathCheck].role }) 
            }
          });
        }
      }
      if (key.startsWith("SPECIALPERMISSIONS|")) {
        const collectionPathCheck = key.replace("SPECIALPERMISSIONS|", "")
        const userKeys = Object.keys(users);
        if (Object.keys(users).length > 0) {
          userKeys.forEach(userKey => {
            const user = users[userKey];
            if (!Object.prototype.hasOwnProperty.call(userList, user.docId)) {
              userList[user.email] = {
                docId: user.docId,
                email: user.email,
                roles: [],
                specialPermissions: [{ collectionPath: collectionPathCheck, permissions: user.specialPermissions[collectionPathCheck].permissions }],
                meta: user.meta,
                last_updated: user.last_updated,
                userId: user.userId,
                uid: user.uid
              }
            } else {
              userList[user.email].specialPermissions.push({ collectionPath: collectionPathCheck, permissions: user.specialPermissions[collectionPathCheck].permissions }) 
            }
          });
        }
      }
    });
    return userList;
  });

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
  });

  public state = reactive({
    collectionPermissions: {},
    users: {},
  });

  public getDocData = async (
    collectionPath: string,
    docId: string
  ): Promise<{ [key: string]: unknown }> => {
    const docRef = doc(this.db, collectionPath, docId);
    const docSnap = await getDoc(docRef);
    const docData = docSnap.data();
    docData.docId = docSnap.id;
    return docData;
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

    const q = this.getQuery(collectionPath, queryList, orderList, max, last);

    const docs = await getDocs(q);

    const nextLast: DocumentData = docs.docs[docs.docs.length - 1];
    docs.forEach((doc) => {
      const item = doc.data();
      item.docId = doc.id;
      data[doc.id] = item;
    });

    return { data, next: nextLast };
  };

  // Class for wrapping a getSaticData to handle pagination
  get SearchStaticData() {
    const getStaticData = this.getStaticData;
    const permissionCheck = this.permissionCheck;
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
        const canRead = permissionCheck("read", collectionPath);

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

  public startSnapshot = (
    collectionPath: string,
    queryList: FirestoreQuery[] = [],
    orderList: FirestoreOrderBy[] = [],
    max = 0
  ): actionResponse => {
    const canRead = this.permissionCheck("read", collectionPath);
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

  public startUsersSnapshot = (collectionPath = ''): void => {
    this.stopSnapshot('users')
    // TODO: need to build users object appropriately and only show roles
    // and special permmisions for collectionPaths the user has assign access for
    this.state.users = {};
    if (collectionPath) {
      if (this.permissionCheck('assign', collectionPath)) {
        const q = query(
          collection(this.db, "users"),
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
            const newRoles = [];
            const newSpecialPermissions = [];

            if (user.roles) {
              const roles: role[] = Object.values(user.roles);
              roles.forEach((role) => {
                if (this.permissionCheck('assign', role.collectionPath)) {
                  newRoles.push(role)
                }
              });
            }
            if (user.specialPermissions) {
              const permissions: specialPermission[] = Object.values(user.specialPermissions);
              permissions.forEach(permission => {
                if (this.permissionCheck('assign', permission.collectionPath)) {
                  newSpecialPermissions.push(permission)
                }
              });
            }
            const item = {
              docId: user.docId,
              email: user.email,
              roles: newRoles,
              specialPermissions: newSpecialPermissions,
              meta: user.meta,
              last_updated: user.last_updated,
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
    email: string,
    collectionPath: string
  ): Promise<actionResponse> => {
    const canAssign = this.permissionCheck("assign", collectionPath);
    if (canAssign) {
      await updateDoc(doc(this.db, "users/" + email), {
        ["roles." + collectionPath.replaceAll("/", "-")]: deleteField()
      });
      await updateDoc(doc(this.db, "users/" + email), {
        collectionPaths: arrayRemove(collectionPath.replaceAll("/", "-"))
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
    email: string,
    collectionPath: string
  ): Promise<actionResponse> => {
    const canAssign = this.permissionCheck("assign", collectionPath);
    if (canAssign) {
      await updateDoc(doc(this.db, "users/" + email), {
        ["specialPermissions." + collectionPath.replaceAll("/", "-")]:
          deleteField()
      });
      await updateDoc(doc(this.db, "users/" + email), {
        collectionPaths: arrayRemove(collectionPath.replaceAll("/", "-"))
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
    email: string,
    collectionPath: string,
    permissions: permissions
  ): Promise<actionResponse> => {
    const canAssign = this.permissionCheck("assign", collectionPath);
    if (canAssign) {
      const collectionExists = await this.collectionExists(collectionPath);
      if (collectionExists) {
        const permissionItem = {
          ["specialPermissions." + collectionPath.replaceAll("/", "-")]: {
            collectionPath: collectionPath.replaceAll("/", "-"),
            permissions
          }
        };
        await updateDoc(doc(this.db, "users/" + email), permissionItem);
        await updateDoc(doc(this.db, "users/" + email), {
          collectionPaths: arrayUnion(collectionPath.replaceAll("/", "-"))
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
    email: string,
    collectionPath: string,
    role: "admin" | "editor" | "writer" | "user"
  ): Promise<actionResponse> => {
    const canAssign = this.permissionCheck("assign", collectionPath);

    if (canAssign) {
      if (role === "admin" || role === "user" || role === "editor" || role === "writer") {
        const collectionExists = await this.collectionExists(collectionPath);
        if (collectionExists) {
          const roleItem = {
            ["roles." + collectionPath.replaceAll("/", "-")]: {
              collectionPath: collectionPath.replaceAll("/", "-"),
              role
            }
          };

          await updateDoc(doc(this.db, "users/" + email), roleItem);
          await updateDoc(doc(this.db, "users/" + email), {
            collectionPaths: arrayUnion(collectionPath.replaceAll("/", "-"))
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
    const canAssign = this.permissionCheck("assign", collectionPath);
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
    const canAssign = this.permissionCheck("assign", collectionPath);
    // TODO: check if collectionPath starts with "users" and deny if so
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
    const canWrite = this.permissionCheck("write", collectionPath);
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
        const canRead = this.permissionCheck("read", collectionPath);
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
        const canRead = this.permissionCheck("read", collectionPath);
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
    const canDelete = this.permissionCheck("delete", collectionPath);
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
