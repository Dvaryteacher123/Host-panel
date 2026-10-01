// =========================================================
// FIREBASE CLIENT CONFIG
// Hii SI siri — ni config ya kawaida ya "Firebase Web App" ambayo
// Google yenyewe inasema ni salama kuwa kwenye frontend, kwa sababu
// ulinzi wa kweli wa data upo kwenye Firestore Security Rules
// (angalia firestore.rules), sio kwenye kuficha config hii.
//
// PATA CONFIG YAKO: Firebase Console -> Project Settings -> "Your apps"
// -> Web app (</>) -> SDK setup and configuration
// =========================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  serverTimestamp,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// !!! WEKA CONFIG YAKO YA FIREBASE HAPA CHINI !!!
const firebaseConfig = {
  apiKey: "WEKA_FIREBASE_API_KEY",
  authDomain: "WEKA_PROJECT_ID.firebaseapp.com",
  projectId: "WEKA_PROJECT_ID",
  storageBucket: "WEKA_PROJECT_ID.appspot.com",
  messagingSenderId: "WEKA_MESSAGING_SENDER_ID",
  appId: "WEKA_APP_ID",
};

// !!! WEKA URL YA BACKEND YAKO YA RENDER HAPA (baada ya kudeploy) !!!
export const API_BASE_URL = "https://WEKA-RENDER-DOMAIN-YAKO.onrender.com";

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);

export {
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  collection,
  doc,
  setDoc,
  getDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  serverTimestamp,
  getDocs,
};
