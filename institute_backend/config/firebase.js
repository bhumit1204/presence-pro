const { initializeApp, getApp, cert } = require("firebase-admin/app");
const { getFirestore }                = require("firebase-admin/firestore");
const path                            = require("path");

const existingServiceAccount  = require(path.join(__dirname, "firebase-main.json"));
const instituteServiceAccount = require(path.join(__dirname, "firebase-inst.json"));

let existingApp;
try {
  existingApp = getApp("existing");
} catch (e) {
  existingApp = initializeApp(
    { credential: cert(existingServiceAccount) },
    "existing"
  );
}

let instituteApp;
try {
  instituteApp = getApp("institute");
} catch (e) {
  instituteApp = initializeApp(
    { credential: cert(instituteServiceAccount) },
    "institute"
  );
}

const workingDb   = getFirestore(existingApp);
const instituteDb = getFirestore(instituteApp);

const COLLECTIONS = {
  COLLEGES:           "colleges",
  INSTITUTES:         "institutes",
  INSTITUTE_SESSIONS: "institute_sessions",
};

module.exports = { existingApp, instituteApp, workingDb, instituteDb, COLLECTIONS };