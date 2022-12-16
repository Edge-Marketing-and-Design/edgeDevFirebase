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
  deleteField
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
// NOTE: ONLY ROOT ADMIN OR USER THEMSELVES CAN SET OR UPDATE USERMETA DATA, UNLESS THE ON FIRST CREATE WHEN USER DOESN'T EXIST
// NOTE: user can have write but not assign, but if they have assign, they must have write
// DOCUMENT:  storeUser, storeCollectionPermissions, storeUserMeta, storeUserRoles, storeUserSpecialPermissions
// removeUserRoles, removeUserSpecialPermissions
// DOCUMENT listUsers (gets Users by Collection) and listCollectionsCanAssign

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
  role: "admin" | "user" | null;
  specialPermission: permissions | null;
  userId: string;
  docId: string;
  uid: string;
  last_updated: Date;
}

interface usersByCollection {
  [collectionPath: string]: [user];
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

  private initUserMetaPermissions = async (): Promise<void> => {
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
    const metaUnsubscribe = onSnapshot(
      doc(this.db, "users", this.user.email),
      (doc) => {
        if (!doc.exists()) {
          this.setUser({
            email: this.user.email,
            roles: [],
            specialPermissions: [],
            meta: {}
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

  private startUserMetaSync = async (): Promise<void> => {
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

  public removeUser = async (email: string): Promise<actionResponse> => {
    const removedFrom = [];
    const userRef = doc(this.db, "users", email);
    const userSnap = await getDoc(userRef);
    if (userSnap.data().roles) {
      for (const collectionPath in userSnap.data().roles) {
        const canAssign = await this.permissionCheck(
          "assign",
          collectionPath.replaceAll("-", "/")
        );
        if (canAssign) {
          this.removeUserRoles(email, collectionPath.replaceAll("-", "/"));
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
        message: ""
      });
    } else {
      return this.sendResponse({
        success: false,
        message: "You do not have permission to remove this user"
      });
    }
  };

  public setUser = async (newUser: newUser): Promise<actionResponse> => {
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
    // if (collections.length === 0) {
    //   canDo = false;
    // }
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
    const collectionRef = doc(
      this.db,
      "collection-data",
      collectionPath.replaceAll("/", "-")
    );
    const collectionSnap = await getDoc(collectionRef);

    if (collectionSnap.exists()) {
      const permissionData = collectionSnap.data()[role];
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

  private generateUserMeta = async (userMeta: userMeta): Promise<void> => {
    const roles: role[] = userMeta.roles;
    const specialPermissions: specialPermission[] = userMeta.specialPermissions;
    delete userMeta.roles;
    delete userMeta.specialPermissions;

    const docRef = doc(this.db, "users", userMeta.docId);
    const docSnap = await getDoc(docRef);
    const docData = docSnap.data();
    const canWrite = await this.permissionCheck("write", "users");
    if (!docData || canWrite) {
      setDoc(doc(this.db, "users", userMeta.docId), userMeta);
    }
    for (const role of roles) {
      await this.generatePermissions(role.collectionPath);
      this.storeUserRoles(userMeta.docId, role.collectionPath, role.role);
    }
    for (const specialPermission of specialPermissions) {
      await this.generatePermissions(specialPermission.collectionPath);
      this.storeUserSpecialPermissions(
        userMeta.docId,
        specialPermission.collectionPath,
        specialPermission.permissions
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
      const hasPermissions = await this.collectionExists(permissionCheck);
      const adminPermission: permissions = {
        assign: true,
        read: true,
        write: true,
        delete: true
      };
      const userPermission: permissions = {
        assign: false,
        read: false,
        write: false,
        delete: false
      };
      if (!hasPermissions) {
        await this.storeCollectionPermissions(
          permissionCheck,
          "admin",
          adminPermission
        );
        await this.storeCollectionPermissions(
          permissionCheck,
          "user",
          userPermission
        );
      }
      index = index - 1;
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
    const collectionRef = doc(
      this.db,
      "collection-data",
      collectionPath.replaceAll("/", "-")
    );
    const collectionSnap = await getDoc(collectionRef);
    if (collectionSnap.exists()) {
      return true;
    }
    return false;
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
        const canRead = await permissionCheck("read", collectionPath);

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
            message: ""
          });
        } else {
          return sendResponse({
            success: false,
            message: `You do not have permission to read from "${collectionPath}"`
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

  public listCollectionsCanAssign = async (): Promise<string[]> => {
    let collectionPaths = [];
    for (const role of this.user.roles) {
      const canAssign = await this.permissionCheck(
        "assign",
        role.collectionPath
      );
      if (canAssign) {
        collectionPaths.push(role.collectionPath);
      }
    }
    for (const specialPermission of this.user.specialPermissions) {
      const canAssign = await this.permissionCheck(
        "assign",
        specialPermission.collectionPath
      );
      if (canAssign) {
        collectionPaths.push(specialPermission.collectionPath);
      }
    }
    collectionPaths = [...new Set(collectionPaths)];
    let collectionPathList = [];
    for (const collectionPath of collectionPaths) {
      if (collectionPath === "-") {
        const collections = await getDocs(
          collection(this.db, "collection-data")
        );
        collections.forEach((doc) => {
          collectionPathList.push(doc.id);
        });
      } else {
        const collections = await getDocs(
          query(
            collection(this.db, "collection-data"),
            where("collectionPath", ">=", collectionPath),
            where("collectionPath", "<", collectionPath + "\uF8FF")
          )
        );
        collections.forEach((doc) => {
          collectionPathList.push(doc.id);
        });
      }
    }
    collectionPathList = [...new Set(collectionPathList)];
    return collectionPathList;
  };

  public listUsers = async (): Promise<usersByCollection> => {
    const userList = {};
    const collectionPathList = await this.listCollectionsCanAssign();
    for (const collectionPath of collectionPathList) {
      userList[collectionPath] = [];
      const roleUsers = await getDocs(
        query(
          collection(this.db, "users"),
          where(
            "roles." + collectionPath + ".collectionPath",
            "==",
            collectionPath
          )
        )
      );
      roleUsers.forEach((doc) => {
        const user = doc.data();
        userList[collectionPath].push({
          docId: user.docId,
          email: user.email,
          role: user.roles[collectionPath].role,
          specialPermission: null,
          meta: user.meta,
          last_updated: user.last_updated,
          userId: user.userId,
          uid: user.uid
        });
      });
      const specialPermissionsUsers = await getDocs(
        query(
          collection(this.db, "users"),
          where(
            "specialPermissions." + collectionPath + ".collectionPath",
            "==",
            collectionPath
          )
        )
      );
      specialPermissionsUsers.forEach((doc) => {
        const user = doc.data();
        userList[collectionPath].push({
          docId: user.docId,
          email: user.email,
          role: null,
          specialPermission:
            user.specialPermissions[collectionPath].permissions,
          meta: user.meta,
          last_updated: user.last_updated,
          userId: user.userId,
          uid: user.uid
        });
      });
    }
    return userList;
  };

  public removeUserRoles = async (
    email: string,
    collectionPath: string
  ): Promise<actionResponse> => {
    const canAssign = await this.permissionCheck("assign", collectionPath);
    if (canAssign) {
      await updateDoc(doc(this.db, "users/" + email), {
        ["roles." + collectionPath.replaceAll("/", "-")]: deleteField()
      });
      return this.sendResponse({
        success: true,
        message: ""
      });
    } else {
      return this.sendResponse({
        success: false,
        message:
          "Cannot remove permissions for collection path: " + collectionPath
      });
    }
  };

  public removeUserSpecialPermissions = async (
    email: string,
    collectionPath: string
  ): Promise<actionResponse> => {
    const canAssign = await this.permissionCheck("assign", collectionPath);
    if (canAssign) {
      await updateDoc(doc(this.db, "users/" + email), {
        ["specialPermissions." + collectionPath.replaceAll("/", "-")]:
          deleteField()
      });
      return this.sendResponse({
        success: true,
        message: ""
      });
    } else {
      return this.sendResponse({
        success: false,
        message:
          "Cannot remove permissions for collection path: " + collectionPath
      });
    }
  };

  public storeUserSpecialPermissions = async (
    email: string,
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
          }
        };
        updateDoc(doc(this.db, "users/" + email), permissionItem);
        return this.sendResponse({
          success: true,
          message: ""
        });
      } else {
        return this.sendResponse({
          success: false,
          message: collectionPath + " is not a valid collection path"
        });
      }
    } else {
      return this.sendResponse({
        success: false,
        message:
          "Cannot assign permissions for collection path: " + collectionPath
      });
    }
  };

  public storeUserRoles = async (
    email: string,
    collectionPath: string,
    role: "admin" | "user"
  ): Promise<actionResponse> => {
    const canAssign = await this.permissionCheck("assign", collectionPath);

    if (canAssign) {
      if (role === "admin" || role === "user") {
        const collectionExists = await this.collectionExists(collectionPath);
        if (collectionExists) {
          const roleItem = {
            ["roles." + collectionPath.replaceAll("/", "-")]: {
              collectionPath: collectionPath.replaceAll("/", "-"),
              role
            }
          };

          updateDoc(doc(this.db, "users/" + email), roleItem);
          return this.sendResponse({
            success: true,
            message: ""
          });
        } else {
          return this.sendResponse({
            success: false,
            message: collectionPath + " is not a valid collection path"
          });
        }
      } else {
        return this.sendResponse({
          success: false,
          message: "Role must be either 'admin' or 'user'"
        });
      }
    } else {
      return this.sendResponse({
        success: false,
        message:
          "Cannot assign permissions for collection path: " + collectionPath
      });
    }
  };

  public storeCollectionPermissions = async (
    collectionPath: string,
    role: "admin" | "user",
    permissions: permissions
  ): Promise<actionResponse> => {
    const canAssign = await this.permissionCheck("assign", collectionPath);

    if (canAssign) {
      if (role === "admin" || role === "user") {
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
          message: ""
        });
      } else {
        return this.sendResponse({
          success: false,
          message: "Role must be either 'admin' or 'user'"
        });
      }
    } else {
      return this.sendResponse({
        success: false,
        message:
          "Cannot assign permissions for collection path: " + collectionPath
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
        const canRead = await this.permissionCheck("read", collectionPath);
        if (canRead) {
          if (Object.prototype.hasOwnProperty.call(this.data, collectionPath)) {
            this.data[collectionPath][docId] = cloneItem;
          }
        }
        setDoc(doc(this.db, collectionPath, docId), cloneItem);
      } else {
        const docRef = await addDoc(
          collection(this.db, collectionPath),
          cloneItem
        );
        const canRead = await this.permissionCheck("read", collectionPath);
        if (canRead) {
          if (Object.prototype.hasOwnProperty.call(this.data, collectionPath)) {
            this.data[collectionPath][docRef.id] = cloneItem;
          }
        }
        this.storeDoc(
          collectionPath,
          { ...cloneItem, docId: docRef.id },
          generatePermissions
        );
      }
      return this.sendResponse({
        success: true,
        message: ""
      });
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
      deleteDoc(doc(this.db, collectionPath, docId));
      return this.sendResponse({
        success: true,
        message: ""
      });
    } else {
      return this.sendResponse({
        success: false,
        message: `You do not have permission to delete from "${collectionPath}"`
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
