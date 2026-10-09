# CityTrail

A private travel map. Sign in with Google, pin every city you've visited, and watch your trail grow.

**Live:** https://citytrail-10092006.web.app

## Stack

| Concern | Choice |
| --- | --- |
| Build | Vite (vanilla JS, no framework) |
| Map | MapLibre GL + [OpenFreeMap](https://openfreemap.org) vector tiles (free, no API key) |
| City search | [Photon](https://photon.komoot.io) autocomplete (OpenStreetMap data) |
| Tap-to-pick | [Nominatim](https://nominatim.org) reverse geocoding at city level |
| Auth | Firebase Auth — **Google sign-in only** |
| Data | Cloud Firestore **Enterprise** edition, database `citytrail` (asia-east1), real-time updates enabled, offline cache on |
| Hosting | Firebase Hosting |

## Data model

```
users/{uid}/cities/{cityId}
  name         string   "Kyoto"
  region       string   "Kyoto Prefecture"
  country      string   "Japan"
  countryCode  string   "jp"
  lat, lng     number
  addedAt      timestamp (server)
```

`cityId` is a slug of `countryCode--region--name`, so the same city found through
search or by tapping the map ends up as one document.

`firestore.rules` restricts each user to their own documents, enforces a strict
schema with size/range limits, requires `addedAt` to be the server time, and
treats cities as immutable (create + delete only). `firestore.indexes.json`
indexes `addedAt` (Enterprise edition creates no indexes by default).

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
```

## Deploy

```bash
npm run deploy                                         # build + hosting + firestore rules
npx -y firebase-tools@latest deploy --only firestore   # rules + indexes
npx -y firebase-tools@latest deploy --only auth        # auth providers from firebase.json
```

> The CLI can enable auth providers from `firebase.json` but does not disable
> them — turn providers off in the Firebase console
> (Authentication → Sign-in method).
