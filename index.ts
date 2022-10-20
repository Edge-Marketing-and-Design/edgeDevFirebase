import { initializeApp } from "firebase/app";
import { reactive, ref } from "vue";

import {
  getFirestore,
  collection,
  addDoc,
  updateDoc,
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
  DocumentData
} from "firebase/firestore";

import {
  getAuth,
  setPersistence,
  browserSessionPersistence,
  browserLocalPersistence,
  Persistence,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
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

interface Credentials {
  email: string;
  password: string;
}

interface StaticDataResult {
  data: object;
  next: DocumentData | null;
}

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string,
  messagingSenderId: import.meta.env
    .VITE_FIREBASE_MESSAGING_SENDER_ID as string,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string
};

// Initialize Firebase
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

onAuthStateChanged(auth, (userAuth) => {
  if (userAuth) {
    user.email = userAuth.email;
    user.uid = userAuth.uid;
    user.loggedIn = true;
    user.logInError = false;
    user.logInErrorMessage = "";
  } else {
    user.email = "";
    user.uid = null;
    user.loggedIn = false;
    user.logInError = false;
    user.logInErrorMessage = "";
  }
});

// Composable to logout
export const logOut = (): void => {
  signOut(auth)
    .then(() => {
      Object.keys(unsubscibe).forEach((key) => {
        if (unsubscibe[key] instanceof Function) {
          unsubscibe[key]();
          unsubscibe[key] = null;
        }
      });
    })
    .catch(() => {
      // Do nothing
    });
};

// Composable to login and set persistence
export const logIn = (credentials: Credentials, isPersistant = false): void => {
  logOut();
  let persistence: Persistence = browserSessionPersistence;
  if (isPersistant) {
    persistence = browserLocalPersistence;
  }
  setPersistence(auth, persistence)
    .then(() => {
      signInWithEmailAndPassword(auth, credentials.email, credentials.password)
        .then(() => {
          // do nothing
        })
        .catch((error) => {
          user.email = "";
          user.uid = null;

          user.loggedIn = false;
          user.logInError = true;
          user.logInErrorMessage = error.code + ": " + error.message;
        });
    })
    .catch((error) => {
      user.email = "";
      user.uid = null;

      user.loggedIn = false;
      user.logInError = true;
      user.logInErrorMessage = error.code + ": " + error.message;
    });
};

// Keeping this for reference on how to Type a Ref.
// export const user = ref<UserDataObject>({
//   uid: null,
//   email: "",
//   loggedIn: false,
//   logInError: false,
//   logInErrorMessage: ""
// });

// Simple Store Items (add matching key per firebase collection)
export const data: CollectionDataObject = reactive({});
export const unsubscibe: CollectionUnsubscribeObject = reactive({});
export const user: UserDataObject = reactive({
  uid: null,
  email: "",
  loggedIn: false,
  logInError: false,
  logInErrorMessage: ""
});

export const getDocData = async (
  collectionPath: string,
  docId: string
): Promise<{ [key: string]: unknown }> => {
  const docRef = doc(db, collectionPath, docId);
  const docSnap = await getDoc(docRef);
  const docData = docSnap.data();
  docData.docId = docSnap.id;
  return docData;
};

export const getStaticData = async (
  collectionPath: string,
  queryList: FirestoreQuery[] = [],
  orderList: FirestoreOrderBy[] = [],
  max = 0,
  last: DocumentData | null = null
): Promise<StaticDataResult> => {
  const data: object = {};

  const q = getQuery(collectionPath, queryList, orderList, max, last);

  const docs = await getDocs(q);
  const nextLast: DocumentData = docs.docs[docs.docs.length - 1];

  docs.forEach((doc) => {
    const item = doc.data();
    item.docId = doc.id;
    data[doc.id] = item;
  });
  return { data, next: nextLast };
};

export class SearchStaticData {
  collectionPath = "";
  queryList: FirestoreQuery[] = [];
  orderList: FirestoreOrderBy[] = [];
  max = 0;

  data = ref({});
  pagination = ref([]);
  staticIsLastPage = ref<boolean>(true);
  staticIsFirstPage = ref<boolean>(true);
  staticCurrentPage = ref("");

  prev = async (): Promise<void> => {
    const findIndex = this.pagination.value.findIndex(
      (x) => x.key === this.staticCurrentPage.value
    );
    let last = null;
    if (findIndex === 1) {
      this.staticCurrentPage.value = "";
      this.staticIsLastPage.value = false;
      this.staticIsFirstPage.value = true;
    } else {
      last = this.pagination.value[findIndex - 2].next;
      this.staticCurrentPage.value = this.pagination.value[findIndex - 2].key;
    }
    await this.afterNextPrev(last);
  };

  next = async (): Promise<void> => {
    const findIndex = this.pagination.value.findIndex(
      (x) => x.key === this.staticCurrentPage.value
    );
    const last = this.pagination.value[findIndex].next;
    if (this.pagination.value.length === 1) {
      this.staticIsFirstPage.value = true;
    } else {
      this.staticIsFirstPage.value = false;
    }
    await this.afterNextPrev(last);
  };

  afterNextPrev = async (last): Promise<void> => {
    let results = await getStaticData(
      "users",
      this.queryList,
      this.orderList,
      this.max,
      last
    );

    if (last && Object.keys(results.data).length === 0) {
      this.staticIsLastPage.value = true;
      if (this.pagination.value.length === 1) {
        last = null;
        this.staticCurrentPage.value = "";
        this.staticIsFirstPage.value = true;
      } else {
        last = this.pagination.value[this.pagination.value.length - 2].next;
        this.staticCurrentPage.value =
          this.pagination.value[this.pagination.value.length - 2].key;
      }
      results = await getStaticData(
        "users",
        this.queryList,
        this.orderList,
        this.max,
        last
      );
    } else {
      this.staticIsLastPage.value = false;
      if (this.pagination.value.length === 1) {
        this.staticIsFirstPage.value = false;
      }
    }
    this.data.value = results.data;
    this.staticCurrentPage.value = results.next.id;
    if (!this.staticIsLastPage.value) {
      if (results.next) {
        const findItem = this.pagination.value.find(
          (x) => x.key === results.next.id
        );
        if (!findItem) {
          this.pagination.value.push({
            key: results.next.id,
            next: results.next
          });
        }
      }
    }
  };

  getData = async (
    collectionPath: string,
    queryList: FirestoreQuery[] = [],
    orderList: FirestoreOrderBy[] = [],
    max = 0
  ): Promise<void> => {
    this.collectionPath = collectionPath;
    this.queryList = queryList;
    this.orderList = orderList;
    this.max = max;
    this.staticIsLastPage.value = false;
    this.staticIsFirstPage.value = true;
    this.staticCurrentPage.value = "";
    this.pagination.value = [];
    this.pagination.value = [];
    this.data.value = {};
    const results = await getStaticData(
      collectionPath,
      queryList,
      orderList,
      max
    );
    if (Object.keys(results.data).length > 0) {
      this.data.value = results.data;
      this.staticCurrentPage.value = results.next.id;
      this.pagination.value.push({ key: results.next.id, next: results.next });
    }
  };
}

// Composable to start snapshot listener and set unsubscribe function
export const startSnapshot = (
  collectionPath: string,
  queryList: FirestoreQuery[] = [],
  orderList: FirestoreOrderBy[] = [],
  max = 0
): void => {
  data[collectionPath] = {};
  const q = getQuery(collectionPath, queryList, orderList, max);
  const unsubscribe = onSnapshot(q, (querySnapshot) => {
    const items = {};
    querySnapshot.forEach((doc) => {
      const item = doc.data();
      item.docId = doc.id;
      items[doc.id] = item;
    });
    data[collectionPath] = items;
  });
  unsubscibe[collectionPath] = unsubscribe;
};

const getQuery = (
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
      collection(db, collectionPath),
      ...queryConditions,
      ...orderConditions,
      ...limitConditions,
      startAfter(after)
    );
  }
  return query(
    collection(db, collectionPath),
    ...queryConditions,
    ...orderConditions,
    ...limitConditions
  );
};

// Composable to update/add a document
export const storeDoc = async (
  collectionPath: string,
  item: object
): Promise<void> => {
  const cloneItem = JSON.parse(JSON.stringify(item));
  const currentTime = new Date().getTime();
  cloneItem.last_updated = currentTime;
  cloneItem.uid = user.uid;
  if (!Object.prototype.hasOwnProperty.call(cloneItem, "doc_created_at")) {
    cloneItem.doc_created_at = currentTime;
  }
  if (Object.prototype.hasOwnProperty.call(cloneItem, "docId")) {
    const docId = cloneItem.docId;
    if (Object.prototype.hasOwnProperty.call(data, collectionPath)) {
      data[collectionPath][docId] = cloneItem;
    }
    const docRef = doc(db, collectionPath, docId);
    updateDoc(docRef, cloneItem);
  } else {
    const docRef = await addDoc(collection(db, collectionPath), cloneItem);
    if (Object.prototype.hasOwnProperty.call(data, collectionPath)) {
      data[collectionPath][docRef.id] = cloneItem;
    }
    storeDoc(collectionPath, { ...cloneItem, docId: docRef.id });
  }
};

// Composable to delete a document
export const removeDoc = (collectionPath: string, docId: string): void => {
  // Just in case getting collection back from firebase is slow:
  if (Object.prototype.hasOwnProperty.call(data, collectionPath)) {
    if (Object.prototype.hasOwnProperty.call(data[collectionPath], docId)) {
      delete data[collectionPath][docId];
    }
  }
  deleteDoc(doc(db, collectionPath, docId));
};

// Composable to stop snapshot listener
export const stopSnapshot = (collectionPath: string): void => {
  if (unsubscibe[collectionPath] instanceof Function) {
    unsubscibe[collectionPath]();
    unsubscibe[collectionPath] = null;
  }
};
