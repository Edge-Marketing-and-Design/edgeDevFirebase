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
  where
} from "firebase/firestore";

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
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Simple Store Items (add matching key per firebase collection)
export const data: object = reactive({});
export const unsubscibe: object = reactive({});
export const user: object = ref({});

// Composable to start snapshot listener and set unsubscribe function
export const startSnapshot = (
  collectionPath: string,
  queryList: FirestoreQuery[] = []
): void => {
  // This first "if" is to prevent multiple listeners on the same collection
  if (!(data[collectionPath] instanceof Function)) {
    const queryConditions: QueryConstraint[] = queryList.map((condition) =>
      where(condition.field, condition.operator, condition.value)
    );
    const q = query(collection(db, collectionPath), ...queryConditions);
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
  }
};

export const storeDoc = (collectionPath: string, item: object): void => {
  const cloneItem = JSON.parse(JSON.stringify(item));
  const current_time = new Date().getTime();
  cloneItem.last_updated = current_time;
  cloneItem.uid = null;
  if (Object.prototype.hasOwnProperty.call(user, "uid")) {
    cloneItem.uid = user["uid"];
  }
  if (!Object.prototype.hasOwnProperty.call(cloneItem, "doc_created_at")) {
    cloneItem.doc_created_at = current_time;
  }
  if (Object.prototype.hasOwnProperty.call(cloneItem, "docId")) {
    const docId = cloneItem.docId;
    if (Object.prototype.hasOwnProperty.call(data, collectionPath)) {
      data[collectionPath][docId] = cloneItem;
    }
    delete cloneItem.docId;
    const docRef = doc(db, collectionPath, docId);
    updateDoc(docRef, cloneItem);
  } else {
    if (Object.prototype.hasOwnProperty.call(data, collectionPath)) {
      data[collectionPath][current_time] = cloneItem;
    }
    addDoc(collection(db, collectionPath), cloneItem);
  }
};

// Composable to stop snapshot listener
export const stopSnapshot = (collectionPath: string): void => {
  if (unsubscibe[collectionPath] instanceof Function) {
    unsubscibe[collectionPath]();
    unsubscibe[collectionPath] = null;
  }
};

interface FirestoreQuery {
  field: string;
  operator: WhereFilterOp; // '==' | '<' | '<=' | '>' | '>=' | 'array-contains' | 'in' | 'array-contains-any';
  value: unknown;
}
