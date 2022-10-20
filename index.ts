import { initializeApp } from "firebase/app";
import { reactive } from "vue";

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
  startAt,
  startAfter
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
  max: 0,
  after = ""
): Promise<{ [key: string]: unknown }> => {
  const data: { [key: string]: unknown } = {};
  const q = getQuery(collectionPath, queryList, orderList, max, after);
  const docs = await getDocs(q);
  docs.forEach((doc) => {
    const item = doc.data();
    item.docId = doc.id;
    data[doc.id] = item;
  });
  return data;
};

// Composable to start snapshot listener and set unsubscribe function
export const startSnapshot = (
  collectionPath: string,
  queryList: FirestoreQuery[] = [],
  orderList: FirestoreOrderBy[] = [],
  max = 0,
  after = ""
): void => {
  data[collectionPath] = {};
  const q = getQuery(collectionPath, queryList, orderList, max, after);
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
  after = ""
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
