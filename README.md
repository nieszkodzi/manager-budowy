# Remont — Materiały

A simple, offline-first web app for tracking renovation materials room by room. No backend, no login — everything is stored in your browser's `localStorage`.

## Features

- List materials per room with quantity, unit, and a link to the product
- Check off items as you buy them and track progress per room
- Add inspiration photos / visualizations to each room
- Reorder items, rename rooms, delete entries
- Export and import data as JSON (for backup or sharing)
- Print-friendly view

## Run locally

No build step needed — just open the file directly in your browser:

```bash
open index.html
```

Or serve it with any static file server, for example Python's built-in one:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000` in your browser.

## Run online (GitHub Pages)

1. Push this repo to GitHub (already done).
2. Go to **Settings → Pages**.
3. Under **Source**, select branch `main` and folder `/ (root)`.
4. Click **Save** — your app will be live at:

```
https://<your-username>.github.io/manager-budowy/
```

Data is stored locally in each visitor's browser. To share your list with someone, use **Eksportuj JSON** and send them the file — they can load it with **Importuj JSON**.
