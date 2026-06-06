// firebase.js — central Firebase init

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";

import {
  browserLocalPersistence,
  getAuth,
  setPersistence
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import {
  getFirestore
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import {
  getStorage
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

import {
  getMessaging,
  isSupported
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js";

/* =====================================================
   IMPORTANT SECURITY NOTES

   1. Firebase Web API key is PUBLIC by design.
      Restrict it in Google Cloud Console:
      APIs & Services → Credentials → HTTP Referrers

   2. Enable:
      - Phone Authentication
      - Firestore Database

   3. Add your domain in:
      Firebase Console → Authentication → Settings
      → Authorized domains

   4. Production:
      Enable App Check for better protection
===================================================== */

const firebaseConfig = {

  apiKey: "AIzaSyBaPN1a6qKdycroI-_IMLQA6ry7qPzrtRo",

  authDomain: "magneetoz.firebaseapp.com",

  projectId: "magneetoz",

  storageBucket: "magneetoz.appspot.com",

  messagingSenderId: "751957852049",
  appId: "1:751957852049:web:1735cbaa412b70ba17a430",
  measurementId: "G-ZS11LFZQRK"
};

/* ---------- initialize ---------- */

const app = initializeApp(firebaseConfig);

/* ---------- services ---------- */

export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch(error => {
  console.warn("Firebase auth persistence unavailable:", error);
});

export const db = getFirestore(app);

export const storage = getStorage(app);

export const messagingReady = isSupported()
  .then(supported => supported ? getMessaging(app) : null)
  .catch(() => null);

export { app };
