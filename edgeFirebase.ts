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
  setDoc
} from "firebase/firestore";

import {
  getAuth,
  setPersistence,
  browserSessionPersistence,
  browserLocalPersistence,
  Persistence,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  createUserWithEmailAndPassword
} from "firebase/auth";
import { C, F } from "~~/dist/_nuxt/entry.6e4c92d1";
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

interface collectionPermissions extends permissions {
  docId: "admin" | "user";
}

interface role {
  collectionPath: "-" | string; // - is root
  role: "admin" | "user";
}

// TODO:  add to readme... roles defined in user, by collectionPath and role being admin or user
// specialPermissions defined in user, by collectionPath and being of type permissions
// each collection has a permissions object, with assign, read, write, delete
// what a user can do is determined by their upper most role, and their specialPermissions.
// for example if user has collectionPath of "organization" and role of "admin", they will
// have all permissions for "organzation" all collections under "organization"
// If a user has "assign" permission for a collection, they can add users/edit users/assign users to
// that collection and all subcollections of that collection.

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
    }
  ) {
    this.firebaseConfig = firebaseConfig;
    this.app = initializeApp(this.firebaseConfig);
    this.auth = getAuth(this.app);
    this.db = getFirestore(this.app);
    this.setOnAuthStateChanged();
  }

  private firebaseConfig = null;

  public app = null;
  public auth = null;
  public db = null;

  private startUserMetaSync = (): void => {
    const metaUnsubscribe = onSnapshot(
      doc(this.db, "users", this.user.email),
      (doc) => {
        if (!doc.exists()) {
          this.addUser({
            email: this.user.email,
            roles: [],
            specialPermissions: [],
            meta: {}
          });
          this.user.meta = {};
        } else {
          this.user.meta = doc.data().meta;
        }
      }
    );

    let q = this.getQuery("users/" + this.user.email + "/roles");
    const rolesUnsubscribe = onSnapshot(q, (querySnapshot) => {
      const items = [];
      querySnapshot.forEach((doc) => {
        const item = doc.data();
        item.collectionPath = doc.id;
        delete item.docId;
        items.push(item);
      });
      this.user.roles = items;
    });

    q = this.getQuery("users/" + this.user.email + "/specialPermissions");
    const specialPermissionsUnsubscribe = onSnapshot(q, (querySnapshot) => {
      const items = [];
      querySnapshot.forEach((doc) => {
        const item = doc.data();
        item.collectionPath = doc.id;
        delete item.docId;
        items.push(item);
      });
      this.user.specialPermissions = items;
    });

    this.unsubscibe.specialPermissionsUnsubscribe =
      specialPermissionsUnsubscribe;
    this.unsubscibe.userRoles = rolesUnsubscribe;
    this.unsubscibe.userMeta = metaUnsubscribe;
  };

  private setOnAuthStateChanged = (): void => {
    onAuthStateChanged(this.auth, (userAuth) => {
      if (userAuth) {
        this.user.email = userAuth.email;
        this.user.uid = userAuth.uid;
        this.user.loggedIn = true;
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

  public registerUser = (userRegister: userRegister): void => {
    createUserWithEmailAndPassword(
      this.auth,
      userRegister.email,
      userRegister.password
    ).then((userCredential) => {
      console.log(userCredential);

      // TODO update user with userID = uuid;
      // TODO UPDATE ANY NEW META DATA
    });
    console.log(userRegister);
  };

  public addUser = async (newUser: newUser): Promise<actionResponse> => {
    const canAssignRole = await this.multiPermissionCheck(
      "assign",
      newUser.roles
    );
    const canAssignSpecialPermissions = await this.multiPermissionCheck(
      "assign",
      newUser.specialPermissions
    );
    if (canAssignRole.canDo && canAssignSpecialPermissions.canDo) {
      const userMeta: userMeta = {
        docId: newUser.email,
        userId: "",
        email: newUser.email,
        roles: newUser.roles,
        specialPermissions: newUser.specialPermissions,
        meta: newUser.meta
      };
      this.generateUserMeta(userMeta);
      return this.sendResponse({
        success: true,
        message: ""
      });
    } else {
      return this.sendResponse({
        success: false,
        message:
          "Cannot assign role or special permission for collection path(s): " +
          canAssignRole.badCollectionPaths
            .concat(canAssignSpecialPermissions.badCollectionPaths)
            .join(", ")
      });
    }
  };

  private multiPermissionCheck = async (
    action: action,
    collections = []
  ): Promise<permissionStatus> => {
    let canDo = true;
    const badCollectionPaths = [];
    if (collections.length === 0) {
      canDo = false;
    }
    for (const collection of collections) {
      if (!(await this.permissionCheck(action, collection.collectionPath))) {
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
  // TODO: NEED TO WRITE UPDATE COLLECTION PERMISSIONS FUNCTION
  // TODO: NEED TO WRITE UPDATE ROLES FOR USER FUNCTION
  // TODO: NEED TO WRITE UPDATE SPECIAL PERMISSIONS FOR USER FUNCTION

  // TODO: NEED TO IMPLEMENT permissionCheck into all functions that need it
  // So far have completed:  startSnapshot, addUser, storeDoc

  private permissionCheck = async (
    action: action,
    collectionPath: string
  ): Promise<boolean> => {
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
          permissionData = await this.getCollectionPermissions(
            collectionPath,
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
        permissionData = await this.getCollectionPermissions(
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

  private getCollectionPermissions = async (
    collectionPath: string,
    role: string
  ): Promise<permissions> => {
    const docRef = doc(this.db, collectionPath + "/permissions/roles", role);
    const docSnap = await getDoc(docRef);
    const permissionData = docSnap.data();
    if (permissionData) {
      return {
        read: permissionData.read,
        write: permissionData.write,
        delete: permissionData.delete,
        assign: permissionData.assign
      };
    } else {
      return {
        read: false,
        write: false,
        delete: false,
        assign: false
      };
    }
  };

  private generateUserMeta = (userMeta: userMeta): void => {
    const roles: role[] = userMeta.roles;
    const specialPermissions: specialPermission[] = userMeta.specialPermissions;
    delete userMeta.roles;
    delete userMeta.specialPermissions;
    this.storeDoc("users", userMeta, false);
    for (const role of roles) {
      this.generatePermissions(role.collectionPath);
      this.storeDoc(
        "users/" + userMeta.docId + "/roles",
        {
          docId: role.collectionPath.replaceAll("/", "-"),
          role: role.role
        },
        false
      );
    }
    for (const specialPermission of specialPermissions) {
      this.generatePermissions(specialPermission.collectionPath);
      this.storeDoc(
        "users/" + userMeta.docId + "/specialPermissions",
        {
          docId: specialPermission.collectionPath.replaceAll("/", "-"),
          permissions: specialPermission.permissions
        },
        false
      );
    }
  };

  private generatePermissions = async (
    collectionPath: string
  ): Promise<void> => {
    const collection = collectionPath.split("/");
    let index = collection.length;
    while (index > 0) {
      const collectionArray = JSON.parse(JSON.stringify(collection));
      const permissionCheck = collectionArray.splice(0, index).join("/");
      const hasPermissions = await this.collectionExists(
        permissionCheck + "/permissions/roles"
      );
      if (!hasPermissions) {
        let newPerimission: collectionPermissions = {
          docId: "admin",
          assign: true,
          read: true,
          write: true,
          delete: true
        };
        this.storeDoc(
          permissionCheck + "/permissions/roles",
          newPerimission,
          false
        );
        newPerimission = {
          docId: "user",
          assign: false,
          read: false,
          write: false,
          delete: false
        };
        this.storeDoc(
          permissionCheck + "/permissions/roles",
          newPerimission,
          false
        );
      }
      index = index - 2;
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
  public logIn = (credentials: Credentials, isPersistant = false): void => {
    this.logOut();
    let persistence: Persistence = browserSessionPersistence;
    if (isPersistant) {
      persistence = browserLocalPersistence;
    }
    setPersistence(this.auth, persistence)
      .then(() => {
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
    specialPermissions: []
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

  private collectionExists = async (
    collectionPath: string
  ): Promise<boolean> => {
    const q = query(collection(this.db, collectionPath), limit(1));
    const collectionSnap = await getDocs(q);
    return collectionSnap.size > 0;
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
          "users",
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
            "users",
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
      ): Promise<void> => {
        this.collectionPath = collectionPath;
        this.queryList = queryList;
        this.orderList = orderList;
        this.max = max;
        this.results.staticIsLastPage = true;
        this.results.staticIsFirstPage = true;
        this.results.staticCurrentPage = "";
        this.results.pagination = [];
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
      };
    };
  }

  // Class for wrapping a getSaticData to handle pagination
  public SearchStaticDatas = new (class {})();

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

  public startSnapshot = async (
    collectionPath: string,
    queryList: FirestoreQuery[] = [],
    orderList: FirestoreOrderBy[] = [],
    max = 0
  ): Promise<actionResponse> => {
    const canRead = await this.permissionCheck("read", collectionPath);
    this.data[collectionPath] = {};
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
        message: ""
      });
    } else {
      return this.sendResponse({
        success: false,
        message: `You do not have permission to read from "${collectionPath}"`
      });
    }
  };

  // Composable to update/add a document
  public storeDoc = async (
    collectionPath: string,
    item: object,
    generatePermissions = true
  ): Promise<actionResponse> => {
    const canWrite = await this.permissionCheck("write", collectionPath);
    if (!canWrite) {
      return this.sendResponse({
        success: false,
        message: `You do not have permission to write to "${collectionPath}"`
      });
    } else {
      if (generatePermissions) {
        // TODO: Need to generatePermissions for every segment of collection if does not exist
        collectionPath = collectionPath.replaceAll("-", "_");
        this.generatePermissions(collectionPath);
      }
      const cloneItem = JSON.parse(JSON.stringify(item));
      const currentTime = new Date().getTime();
      cloneItem.last_updated = currentTime;
      cloneItem.uid = this.user.uid;
      if (!Object.prototype.hasOwnProperty.call(cloneItem, "doc_created_at")) {
        cloneItem.doc_created_at = currentTime;
      }
      if (Object.prototype.hasOwnProperty.call(cloneItem, "docId")) {
        const docId = cloneItem.docId;
        if (Object.prototype.hasOwnProperty.call(this.data, collectionPath)) {
          this.data[collectionPath][docId] = cloneItem;
        }
        setDoc(doc(this.db, collectionPath, docId), cloneItem);
      } else {
        const docRef = await addDoc(
          collection(this.db, collectionPath),
          cloneItem
        );
        if (Object.prototype.hasOwnProperty.call(this.data, collectionPath)) {
          this.data[collectionPath][docRef.id] = cloneItem;
        }
        this.storeDoc(collectionPath, { ...cloneItem, docId: docRef.id });
      }
      return this.sendResponse({
        success: true,
        message: ""
      });
    }
  };

  // Composable to delete a document
  public removeDoc = (collectionPath: string, docId: string): void => {
    // Just in case getting collection back from firebase is slow:
    if (Object.prototype.hasOwnProperty.call(this.data, collectionPath)) {
      if (
        Object.prototype.hasOwnProperty.call(this.data[collectionPath], docId)
      ) {
        delete this.data[collectionPath][docId];
      }
    }
    deleteDoc(doc(this.db, collectionPath, docId));
  };

  // Composable to stop snapshot listener
  public stopSnapshot = (collectionPath: string): void => {
    if (this.unsubscibe[collectionPath] instanceof Function) {
      this.unsubscibe[collectionPath]();
      this.unsubscibe[collectionPath] = null;
    }
  };
};
