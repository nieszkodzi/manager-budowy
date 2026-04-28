# Remont — Materiały

A web app for tracking renovation materials room by room. Supports real-time sync via Firebase Firestore so everyone with access to the page sees the same data live. Falls back to local-only mode if Firebase is not configured.

## Featureshow can I add more storage 

- List materials per room with quantity, unit, and a link to the product
- Check off items as you buy them and track progress per room
- Add inspiration photos / visualizations to each room (stored locally only)
- Reorder items, rename rooms, delete entries
- Export and import data as JSON (for backup or sharing)
- Print-friendly view
- Real-time sync via Firestore (optional)

## Run locally

No build step needed. Because `app.js` uses ES modules, you need a local server (not a plain `file://` open):

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000` in your browser.

## Run online (GitHub Pages)

1. Push this repo to GitHub.
2. Go to **Settings → Pages**.
3. Under **Source**, select branch `main` and folder `/ (root)`.
4. Click **Save** — your app will be live at:

```
https://<your-username>.github.io/manager-budowy/
```

## Enable real-time sync with Firebase

Without Firebase the app works locally — data is saved in your browser only and others can't see it. To share a live list with others, set up a free Firebase project:

### 1. Create a Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and click **Add project**.
2. Name it (e.g. `remont-domu`), disable Google Analytics if you don't need it, click **Create project**.

### 2. Create a Firestore database

1. In the left menu go to **Build → Firestore Database**.
2. Click **Create database**.
3. Choose **Start in test mode** (allows read/write without login — fine for private/family use).
4. Pick a region close to you (e.g. `europe-west1`) and click **Enable**.

### 3. Get your config

1. In the left menu click the gear icon → **Project settings**.
2. Under **Your apps** click the `</>` (Web) icon to register a web app.
3. Give it a nickname, click **Register app**.
4. Copy the `firebaseConfig` object shown on screen.

### 4. Paste it into `firebase-config.js`

Open `firebase-config.js` and replace the placeholder values:

```js
window.FIREBASE_CONFIG = {
  apiKey:            "...",
  authDomain:        "your-project.firebaseapp.com",
  projectId:         "your-project",
  storageBucket:     "your-project.appspot.com",
  messagingSenderId: "...",
  appId:             "..."
};
```

Commit and push — all visitors to the page will now share the same live data.

