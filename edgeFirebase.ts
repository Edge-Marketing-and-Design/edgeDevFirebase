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

interface UserDataObject {
  uid: string | null;
  email: string;
  loggedIn: boolean;
  logInError: boolean;
  logInErrorMessage: string;
}

interface collectionRole {
  docId: string;
  assign: boolean;
  read: boolean;
  write: boolean;
  delete: boolean;
}

interface userRole {
  group: string;
  role: collectionRole;
}

interface userRegister {
  docId: string;
  email: string;
  password: string;
  groups: userRole[] | null;
  more: object;
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

  public userMeta: unknown = reactive({});

  private startUserMetaSync = (): void => {
    // TODO:  create usermeta document for user if does not exist
    // const usersRef = db.collection('users').doc('id')
    // usersRef.get()
    //   .then((docSnapshot) => {
    //     if (docSnapshot.exists) {
    //       usersRef.onSnapshot((doc) => {
    //         // do stuff with the data
    //       });
    //     } else {
    //       usersRef.set({...}) // create the document
    //     }
    // });
    // TODO: START SNAPSHOTS FOR USER USERMETA
    // LOOP THROUGH DOCUMENT KEYS AND SET REACTVIE KEYS TO VALUES
  };

  private setOnAuthStateChanged = (): void => {
    onAuthStateChanged(this.auth, (userAuth) => {
      if (userAuth) {
        this.user.email = userAuth.email;
        this.user.uid = userAuth.uid;
        this.user.loggedIn = true;
        this.user.logInError = false;
        this.user.logInErrorMessage = "";
      } else {
        this.user.email = "";
        this.user.uid = null;
        this.user.loggedIn = false;
        this.user.logInError = false;
        this.user.logInErrorMessage = "";
      }
    });
  };

  // IMPORTANT TODO!!!! : AT USER_META LEVEL CHAGE GROUPS ROLES TO BE EITHER ADMIN OR USER...
  // THEN!!!! CHANGE COLLECTIONROLES TO BE READ, WRITE, DELETE ETC... TO BE BASED ON USER OR ADMIN...
  // THEN!!! TAKE OUT CODE THAT DOESN'T PUT USER_META COLEECTION ROLES IN PLACE......

  // TODO: NEED TO FIGURE OUT CREATE USER...
  // EITHER ADDING A USER GOES TO A QUEUE AND ONLY THOSE IN QUEE CAN REGISTER.. PERHAPS SENDINNG INVITE EMAIL
  // OR A WAY FOR ADMIN TO CREATE USER WITHOUT BEING LOGGED IN AS THAT USER...

  public registerUser = (userRegister: userRegister): void => {
    const tempApp = initializeApp(this.firebaseConfig);
    const tempAuth = getAuth(tempApp);
    createUserWithEmailAndPassword(
      tempAuth,
      userRegister.email,
      userRegister.password
    ).then((userCredential) => {
      userRegister.docId = userCredential.user.uid;
      this.storeDoc("user-meta", userRegister);
    });
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
    logInErrorMessage: ""
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

  // Composable to start snapshot listener and set unsubscribe function
  public startSnapshot = (
    collectionPath: string,
    queryList: FirestoreQuery[] = [],
    orderList: FirestoreOrderBy[] = [],
    max = 0
  ): void => {
    this.data[collectionPath] = {};
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
  };

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

  // Composable to update/add a document
  public storeDoc = async (
    collectionPath: string,
    item: object
  ): Promise<void> => {
    if (
      !collectionPath.includes("/roles/") &&
      !collectionPath.includes("user-meta")
    ) {
      const hasRole = await this.collectionExists(
        collectionPath + "/roles/users"
      );
      if (!hasRole) {
        const newRole: collectionRole = {
          docId: this.user.uid,
          assign: true,
          read: true,
          write: true,
          delete: true
        };
        this.storeDoc(collectionPath + "/roles/users", newRole);
      }
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
