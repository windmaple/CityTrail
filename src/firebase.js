import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
} from 'firebase/firestore';
import { firebaseConfig } from './firebase-config.js';

// Firestore Enterprise edition database (asia-east1). Enterprise databases are
// always named — there is no "(default)" — so the ID must be passed explicitly.
const DATABASE_ID = 'citytrail';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// We intentionally use a standard real-time listener (onSnapshot) plus the
// persistent offline cache rather than Pipelines: the map must update live
// across tabs/devices and keep working offline, which Pipelines don't provide.
const db = initializeFirestore(
  app,
  { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) },
  DATABASE_ID,
);

/* ---------- Auth: Google ---------- */

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    // Some mobile browsers / in-app webviews block popups — fall back to redirect.
    if (
      err?.code === 'auth/popup-blocked' ||
      err?.code === 'auth/operation-not-supported-in-this-environment'
    ) {
      await signInWithRedirect(auth, provider);
      return;
    }
    throw err;
  }
}

/* ---------- Auth: session ---------- */

export const signOutUser = () => signOut(auth);

export const watchAuth = (callback) => onAuthStateChanged(auth, callback);

/* ---------- Visited cities (users/{uid}/cities/{cityId}) ---------- */

const citiesCol = (uid) => collection(db, 'users', uid, 'cities');

export function watchCities(uid, onChange, onError) {
  const q = query(citiesCol(uid), orderBy('addedAt', 'desc'));
  return onSnapshot(
    q,
    (snap) => {
      const cities = snap.docs.map((d) => {
        const data = d.data({ serverTimestamps: 'estimate' });
        return { id: d.id, ...data, addedAt: data.addedAt?.toDate?.() ?? new Date() };
      });
      onChange(cities);
    },
    onError,
  );
}

export function addCity(uid, city) {
  return setDoc(doc(citiesCol(uid), city.id), {
    name: city.name,
    region: city.region || '',
    country: city.country,
    countryCode: city.countryCode,
    lat: city.lat,
    lng: city.lng,
    addedAt: serverTimestamp(),
  });
}

export function removeCity(uid, cityId) {
  return deleteDoc(doc(citiesCol(uid), cityId));
}
