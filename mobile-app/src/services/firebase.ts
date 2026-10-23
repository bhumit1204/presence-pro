import { initializeApp, getApps, getApp } from "firebase/app";
import { initializeAuth, getAuth } from "firebase/auth";
// @ts-ignore
import { getReactNativePersistence } from "firebase/auth";
import { getFirestore, initializeFirestore } from "firebase/firestore";
import ReactNativeAsyncStorage from "@react-native-async-storage/async-storage";

const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FB_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FB_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FB_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FB_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FB_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FB_APP_ID,
};

const firstInit = getApps().length === 0;

export const firebaseApp = firstInit ? initializeApp(firebaseConfig) : getApp();

export const auth = firstInit
  ? initializeAuth(firebaseApp, {
      persistence: getReactNativePersistence(ReactNativeAsyncStorage),
    })
  : getAuth(firebaseApp);

// React Native cannot rely on the streaming connection Firestore tries first: it can stall silently, and then live
// screens (such as the lecture card) stop updating until the app is reloaded. Long polling is slower to set up
// but dependable. Only the first initialisation may choose this; a hot reload reuses the existing instance.
export const db = firstInit
  ? initializeFirestore(firebaseApp, { experimentalForceLongPolling: true })
  : getFirestore(firebaseApp);