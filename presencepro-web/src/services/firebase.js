// src/services/firebase.js
//
// STUB — fill in your Firebase project's *web* config below.
// Firebase Console → Project Settings → General → "Your apps" → Web app (</>)
// This MUST be the same Firebase project used by the React Native app's
// services/firebase.js, otherwise logins won't match the same users/teachers/students.

import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app); // not used by login yet, kept for the college-registration flow later
export default app;