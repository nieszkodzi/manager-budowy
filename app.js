import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js";
import { getFirestore, doc, onSnapshot, setDoc } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-storage.js";

// ---------------------------------------------------------------------------
// Firebase setup — skipped gracefully if config is missing or incomplete
// ---------------------------------------------------------------------------

const cfg = window.FIREBASE_CONFIG || {};
const firebaseReady = cfg.apiKey && !cfg.apiKey.startsWith("YOUR_");

console.log("[Firebase] config loaded:", !!window.FIREBASE_CONFIG);
console.log("[Firebase] firebaseReady:", firebaseReady);
if (window.FIREBASE_CONFIG) {
  console.log("[Firebase] projectId:", window.FIREBASE_CONFIG.projectId);
  console.log("[Firebase] apiKey starts with:", window.FIREBASE_CONFIG.apiKey?.slice(0, 8));
}

let db = null;
let storage = null;
let unsubscribe = null;
let pendingSaveCount = 0; // number of setDoc calls not yet acknowledged by Firestore
let saveDebounceTimer = null;

function debouncedSave() {
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => save(true), 600);
}

if (firebaseReady) {
  try {
    const app = initializeApp(cfg);
    db = getFirestore(app);
    storage = getStorage(app);
    console.log("[Firebase] initialized OK");
  } catch (e) {
    console.error("[Firebase] init error:", e);
  }
} else {
  console.warn("[Firebase] skipping init — config missing or placeholder");
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const ROOMS_DEFAULT = [
  "Wiatrołap","Kotłownia","Kuchnia","Jadalnia","Salon",
  "Korytarz górny","Sypialnia Główna","Sypialnia Remek",
  "Sypialnia Eliza","Sypialnia Tosia","Łazienka na piętrze",
  "Strych","Łazienka na strychu"
];

let state = { rooms: [], activeRoom: null };
let modalCb = null;
let roomSortable = null;
let matSortable = null;

function uid() { return Math.random().toString(36).slice(2, 10); }
function getRoom(id) { return state.rooms.find(r => r.id === id); }
function findMat(roomId, matId) { return getRoom(roomId)?.materials.find(m => m.id === matId); }

// Ensure every material and image has a stable id — called after loading from any source.
function ensureIds() {
  state.rooms.forEach(r => {
    r.materials.forEach(m => { if (!m.id) m.id = uid(); });
    r.images.forEach(img => { if (!img.id) img.id = uid(); });
  });
}

// ---------------------------------------------------------------------------
// Persistence — Firestore when available, localStorage as fallback
// ---------------------------------------------------------------------------

const LOCAL_KEY = 'remont_v2';
const FIRESTORE_DOC = 'shared/state';

function stateForStorage() {
  return {
    rooms: state.rooms.map(r => ({
      ...r,
      images: r.images.map(img => ({
        id: img.id,
        name: img.name,
        url: img.url,
        path: img.path
        // data (local data URLs) intentionally not persisted to Firestore
      }))
    }))
  };
}

function save(pushToFirestore = true) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
  if (db && pushToFirestore) {
    pendingSaveCount++;
    setDoc(doc(db, FIRESTORE_DOC), stateForStorage())
      .then(() => { pendingSaveCount = Math.max(0, pendingSaveCount - 1); })
      .catch(err => {
        pendingSaveCount = Math.max(0, pendingSaveCount - 1);
        console.error("Firestore write failed:", err);
        setBanner("error", "Błąd zapisu: " + (err.code || err.message));
      });
  }
}

function init() {
  const saved = localStorage.getItem(LOCAL_KEY);
  if (saved) {
    try { state = JSON.parse(saved); } catch (e) {}
  } else {
    state.rooms = ROOMS_DEFAULT.map(n => ({ id: uid(), name: n, images: [], materials: [] }));
    state.activeRoom = state.rooms[0].id;
  }
  if (!state.activeRoom && state.rooms.length) state.activeRoom = state.rooms[0].id;
  ensureIds();

  if (db) {
    console.log("[Firestore] attaching listener to", FIRESTORE_DOC);
    setBanner("sync", "Łączenie z Firestore…");
    unsubscribe = onSnapshot(doc(db, FIRESTORE_DOC), snapshot => {
      console.log("[Firestore] snapshot received, exists:", snapshot.exists(), "fromCache:", snapshot.metadata.fromCache);

      // Skip snapshots that include our own pending writes — they will be
      // followed by a confirmed snapshot once the write is acknowledged.
      if (snapshot.metadata.hasPendingWrites) {
        console.log("[Firestore] pending writes, skipping update");
        return;
      }

      // Block incoming remote state while we have saves in-flight or the user
      // is actively typing. The confirmed snapshot from our own write will
      // arrive once Firestore acknowledges it, carrying our latest data.
      if (pendingSaveCount > 0) {
        console.log("[Firestore] save in flight, skipping remote update");
        return;
      }
      if (isEditing) {
        console.log("[Firestore] user is editing, deferring remote update");
        return;
      }

      if (snapshot.exists()) {
        const remote = snapshot.data();
        console.log("[Firestore] applying remote state");

        // Firestore is the single source of truth. We do NOT re-add locally
        // cached images: doing so would resurrect images deleted on other tabs.
        state.rooms = remote.rooms || [];
        ensureIds(); // assign ids to any items created before this fix
        // Do not update state.activeRoom from remote to allow independent navigation
        localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
        setBanner("sync", "Zsynchronizowano", 2000);
      } else {
        // Document does not exist in Firestore. This can happen on a genuine
        // first run, but also transiently when the SDK reconnects from
        // offline/background before the server confirms the cached document.
        // We NEVER push local state here — doing so would overwrite real data
        // with a stale local copy (e.g. a phone waking up from sleep).
        // On a true first run the document will be created the first time the
        // user makes a change (addMat, addRoom, etc.) which calls save(true).
        console.log("[Firestore] document does not exist — waiting for first user action to create it");
        setBanner("sync", "Gotowy", 2000);
      }
      render(false);
    }, err => {
      console.error("Firestore listen failed:", err);
      setBanner("error", "Błąd połączenia: " + (err.code || err.message));
      if (err.code === 'permission-denied') {
        console.warn("[Firestore] access denied - check Security Rules");
      }
    });
  } else {
    setBanner("local", "Tryb lokalny (bez synchronizacji)");
  }

  render();
}

window.addEventListener('beforeunload', () => { if (unsubscribe) unsubscribe(); });

// ---------------------------------------------------------------------------
// Sync banner
// ---------------------------------------------------------------------------

function setBanner(type, text, autoClearMs = 0) {
  let el = document.getElementById('sync-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sync-banner';
    el.style.cssText = 'position:fixed;bottom:12px;right:16px;font-size:12px;padding:5px 12px;border-radius:20px;z-index:200;transition:opacity 0.4s';
    document.body.appendChild(el);
  }
  const styles = {
    sync:  'background:#eaf3de;color:#3B6D11',
    error: 'background:#fcebeb;color:#a32d2d',
    local: 'background:#f5f4f0;color:#888'
  };
  el.style.cssText += ';' + (styles[type] || styles.local);
  el.style.opacity = '1';
  el.textContent = text;
  if (autoClearMs) {
    setTimeout(() => { el.style.opacity = '0'; }, autoClearMs);
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(pushToFirestore = true) {
  renderSidebar();
  renderContent();
  save(pushToFirestore);
}

function renderSidebar() {
  const el = document.getElementById('room-list');
  el.innerHTML = state.rooms.map(r => {
    const total = r.materials.length, done = r.materials.filter(m => m.done).length;
    const cls = total === 0 ? 'empty' : done === total ? 'done' : 'partial';
    const active = r.id === state.activeRoom ? 'active' : '';
    return `<div class="room-item ${active}" data-id="${r.id}">
      <div class="drag-handle">⋮⋮</div>
      <div class="room-click-area" onclick="selectRoom('${r.id}')">
        <div class="room-dot ${cls}"></div><span>${escHtml(r.name)}</span>
      </div>
    </div>`;
  }).join('');
  initRoomSortable();
}

function initRoomSortable() {
  const el = document.getElementById('room-list');
  if (!el) return;
  if (roomSortable) {
    try { roomSortable.destroy(); } catch (e) {}
    roomSortable = null;
  }
  roomSortable = Sortable.create(el, {
    animation: 150,
    handle: '.drag-handle',
    ghostClass: 'sortable-ghost',
    onEnd: (evt) => {
      const moved = state.rooms.splice(evt.oldIndex, 1)[0];
      state.rooms.splice(evt.newIndex, 0, moved);
      save(true);
    }
  });
}

let isEditing = false;
function setEditing(val) { isEditing = val; }

function autoResize(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function renderContent() {
  const el = document.getElementById('content');
  const room = getRoom(state.activeRoom);
  if (!room) { el.innerHTML = '<div class="empty-state">Wybierz pomieszczenie</div>'; return; }

  // If user is currently typing, don't re-render the content area to avoid losing focus/cursor position.
  // We'll rely on the blur events to update the state and trigger a proper render if needed.
  if (isEditing && document.activeElement && el.contains(document.activeElement)) {
    console.log("[Render] skipping content render due to active editing");
    return;
  }
  const total = room.materials.length, done = room.materials.filter(m => m.done).length;
  const pct = total ? Math.round(done / total * 100) : 0;
  const estTotal = room.materials.reduce((s, m) => s + (parseFloat(m.priceEst) || 0), 0);
  const finalTotal = room.materials.reduce((s, m) => s + (parseFloat(m.priceFinal) || 0), 0);

  // Use img.id for deletion — never array index, which can shift after remote sync.
  const imgGrid = room.images.map(img => {
    const src = escHtml(img.url || img.data || '');
    return `<div class="img-thumb" onclick="openImage('${src}')">
      <img src="${src}" alt="wizualizacja">
      <button class="img-del" onclick="event.stopPropagation();delImg('${room.id}','${img.id}')">✕</button>
    </div>`;
  }).join('');

  // Use m.id for all operations — never array index, which can shift after remote sync.
  const matRows = room.materials.map(m => `
    <div class="mat-row ${m.done ? 'done-row' : ''}" data-id="${m.id}">
      <div class="drag-handle">⋮⋮</div>
      <input type="checkbox" class="mat-check" ${m.done ? 'checked' : ''} onchange="toggleMat('${room.id}','${m.id}')">
      <div class="mat-name-cell">
        <div class="mat-name" contenteditable="true" onfocus="setEditing(true)" onblur="setEditing(false);editMat('${room.id}','${m.id}','name',this.innerText)">${escHtml(m.name)}</div>
        <textarea class="mat-notes" placeholder="Notatki..."
          oninput="autoResize(this);updateMatField('${room.id}','${m.id}','notes',this.value)">${escHtml(m.notes || '')}</textarea>
      </div>
      <div class="mat-qty">
        <input type="number" value="${m.qty}" min="0" step="0.1"
          style="width:60px;font-size:13px;padding:3px 6px;border-radius:6px;border:0.5px solid #ddd;text-align:center"
          onfocus="setEditing(true)" onblur="setEditing(false)" onchange="editMat('${room.id}','${m.id}','qty',this.value)">
      </div>
      <div class="mat-unit">
        <input type="text" value="${escHtml(m.unit || 'szt.')}"
          style="width:54px;font-size:12px;padding:3px 6px;border-radius:6px;border:0.5px solid #ddd;text-align:center;color:#888"
          onfocus="setEditing(true)" onblur="setEditing(false)" onchange="editMat('${room.id}','${m.id}','unit',this.value)">
      </div>
      <div class="mat-link">
        <input type="url" value="${escHtml(m.link || '')}" placeholder="https://..."
          style="width:120px;font-size:12px;padding:3px 6px;border-radius:6px;border:0.5px solid #ddd"
          onfocus="setEditing(true)" onblur="setEditing(false)" onchange="editMat('${room.id}','${m.id}','link',this.value)">
        ${m.link ? `<br><a href="${escHtml(m.link)}" target="_blank" rel="noopener">↗ otwórz</a>` : ''}
      </div>
      <div class="mat-price-est">
        <input type="number" value="${m.priceEst ?? ''}" min="0" step="0.01" placeholder="—"
          style="width:80px;font-size:13px;padding:3px 6px;border-radius:6px;border:0.5px solid #ddd;text-align:right"
          onfocus="setEditing(true)" onblur="setEditing(false)" onchange="editMat('${room.id}','${m.id}','priceEst',this.value)">
      </div>
      <div class="mat-price-final">
        <input type="number" value="${m.priceFinal ?? ''}" min="0" step="0.01" placeholder="—"
          style="width:80px;font-size:13px;padding:3px 6px;border-radius:6px;border:0.5px solid #ddd;text-align:right"
          onfocus="setEditing(true)" onblur="setEditing(false)" onchange="editMat('${room.id}','${m.id}','priceFinal',this.value)">
      </div>
      <div class="mat-del"><button onclick="delMat('${room.id}','${m.id}')" title="Usuń">×</button></div>
    </div>`).join('');

  el.innerHTML = `
    <div class="room-header">
      <div class="room-title-row">
        <div class="room-title" contenteditable="true" onfocus="setEditing(true)" onblur="setEditing(false);renameRoom('${room.id}',this.innerText)">${escHtml(room.name)}</div>
        ${total ? `<span class="progress-badge">${done}/${total} kupione</span>` : ''}
      </div>
      <div class="room-actions">
        <label class="btn" style="cursor:pointer;font-size:13px">+ Dodaj zdjęcie
          <input type="file" accept="image/*" multiple onchange="addImages('${room.id}',event)">
        </label>
        <button class="btn danger" onclick="deleteRoom('${room.id}')">Usuń pomieszczenie</button>
      </div>
    </div>
    <div class="room-notes-section">
      <textarea class="room-notes" placeholder="Notatki do pomieszczenia..."
        oninput="autoResize(this);updateRoomNotes('${room.id}',this.value)">${escHtml(room.notes || '')}</textarea>
    </div>
    <div class="summary-bar">
      <div class="sum-card"><div class="sum-label">Wszystkich pozycji</div><div class="sum-val">${total}</div></div>
      <div class="sum-card"><div class="sum-label">Kupione</div><div class="sum-val" style="color:#3B6D11">${done}</div></div>
      <div class="sum-card"><div class="sum-label">Do kupienia</div><div class="sum-val" style="color:#BA7517">${total - done}</div></div>
      <div class="sum-card"><div class="sum-label">Postęp</div><div class="sum-val">${pct}%</div></div>
      ${estTotal > 0 ? `<div class="sum-card"><div class="sum-label">Szacunkowy koszt</div><div class="sum-val" style="font-size:1rem">${formatPrice(estTotal)}</div></div>` : ''}
      ${finalTotal > 0 ? `<div class="sum-card"><div class="sum-label">Koszt końcowy</div><div class="sum-val" style="font-size:1rem;color:#3B6D11">${formatPrice(finalTotal)}</div></div>` : ''}
    </div>
    ${room.images.length ? `<div class="img-section"><div class="img-label">Wizualizacje / inspiracje</div><div class="img-grid">${imgGrid}</div></div>` : ''}
    <div class="materials-section">
      <div class="mat-header">
        <div style="width:24px"></div>
        <div style="width:16px"></div>
        <div style="flex:2">Materiał / produkt</div>
        <div style="width:70px;text-align:center">Ilość</div>
        <div style="width:60px;text-align:center">Jednostka</div>
        <div style="width:140px">Link</div>
        <div style="width:88px;text-align:right">Cena szac.</div>
        <div style="width:88px;text-align:right">Cena końc.</div>
        <div style="width:56px"></div>
      </div>
      <div id="mat-list">
        ${matRows || `<div style="padding:1.5rem;text-align:center;color:#aaa;font-size:13px">Brak materiałów — dodaj poniżej</div>`}
      </div>
      <div class="add-mat-row">
        <input class="in-name" id="in-name" placeholder="Nazwa materiału..."
          onfocus="setEditing(true)" onblur="setEditing(false)"
          onkeydown="if(event.key==='Enter')addMat('${room.id}')">
        <input class="in-qty" type="number" id="in-qty" placeholder="Ilość" min="0" step="0.1"
          onfocus="setEditing(true)" onblur="setEditing(false)">
        <input class="in-unit" id="in-unit" placeholder="szt."
          onfocus="setEditing(true)" onblur="setEditing(false)">
        <input class="in-link" type="url" id="in-link" placeholder="https://... (opcjonalnie)"
          onfocus="setEditing(true)" onblur="setEditing(false)">
        <input class="in-price-est" type="number" id="in-price-est" placeholder="Cena szac." min="0" step="0.01"
          onfocus="setEditing(true)" onblur="setEditing(false)">
        <input class="in-price-final" type="number" id="in-price-final" placeholder="Cena końc." min="0" step="0.01"
          onfocus="setEditing(true)" onblur="setEditing(false)">
        <button class="btn primary" onclick="addMat('${room.id}')">Dodaj</button>
      </div>
    </div>`;
  initMatSortable(room.id);

  // Auto-resize all textareas after render
  el.querySelectorAll('textarea').forEach(autoResize);
}

function initMatSortable(roomId) {
  const el = document.getElementById('mat-list');
  if (matSortable) {
    try { matSortable.destroy(); } catch (e) {}
    matSortable = null;
  }
  if (!el || (el.children.length <= 1 && el.innerText.includes('Brak'))) return;
  matSortable = Sortable.create(el, {
    animation: 150,
    handle: '.drag-handle',
    ghostClass: 'sortable-ghost',
    onEnd: (evt) => {
      const room = getRoom(roomId);
      if (!room) return;
      const moved = room.materials.splice(evt.oldIndex, 1)[0];
      room.materials.splice(evt.newIndex, 0, moved);
      save(true);
      render(false); // Update indices and UI
    }
  });
}

// ---------------------------------------------------------------------------
// Actions — exposed to inline handlers via window.*
// ---------------------------------------------------------------------------

function escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function formatPrice(val) {
  if (val == null || val === '') return '—';
  return Number(val).toLocaleString('pl-PL', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' zł';
}

window.selectRoom = function(id) {
  if (state.activeRoom === id) return;
  state.activeRoom = id;
  render(false); // No need to push state just because we changed local tab
  window.toggleSidebar(false);
};

window.toggleSidebar = function(force) {
  const sb = document.querySelector('.sidebar');
  const overlay = document.querySelector('.sidebar-overlay');
  if (sb) {
    const isOpen = force !== undefined ? force : !sb.classList.contains('open');
    sb.classList.toggle('open', isOpen);
    overlay?.classList.toggle('show', isOpen);
  }
};

window.renameRoom = function(id, name) {
  const r = getRoom(id); if (r && name.trim()) { r.name = name.trim(); render(true); }
};

window.renameRoomNotes = function(id, notes) {
  const r = getRoom(id); if (r) { r.notes = notes; save(true); }
};

// Called on every oninput keystroke — writes to state immediately and debounces the Firestore save.
window.updateRoomNotes = function(id, notes) {
  const r = getRoom(id); if (!r) return;
  r.notes = notes;
  debouncedSave();
};

window.updateMatField = function(roomId, matId, field, val) {
  const m = findMat(roomId, matId); if (!m) return;
  m[field] = val;
  debouncedSave();
};

window.addRoom = function() {
  showModal('Nowe pomieszczenie', () => `<input id="modal-input" placeholder="Nazwa pomieszczenia..." onkeydown="if(event.key==='Enter')modalConfirm()">`,
    val => { if (!val || !val.trim()) return; const r = { id: uid(), name: val.trim(), images: [], materials: [] }; state.rooms.push(r); state.activeRoom = r.id; render(); });
};

window.deleteRoom = function(id) {
  if (!confirm('Usunąć to pomieszczenie wraz z całą jego zawartością?')) return;
  state.rooms = state.rooms.filter(r => r.id !== id);
  state.activeRoom = state.rooms.length ? state.rooms[0].id : null;
  render();
};

window.addMat = function(roomId) {
  const nameInp = document.getElementById('in-name');
  const name = nameInp.value.trim();
  if (!name) return;
  const qty = parseFloat(document.getElementById('in-qty').value) || 1;
  const unit = document.getElementById('in-unit').value.trim() || 'szt.';
  const link = document.getElementById('in-link').value.trim();
  const priceEstRaw = document.getElementById('in-price-est').value;
  const priceFinalRaw = document.getElementById('in-price-final').value;
  const priceEst = priceEstRaw !== '' ? parseFloat(priceEstRaw) : null;
  const priceFinal = priceFinalRaw !== '' ? parseFloat(priceFinalRaw) : null;
  getRoom(roomId).materials.push({ id: uid(), name, qty, unit, link, done: false, notes: '', priceEst, priceFinal });
  render(true);
  document.getElementById('in-name')?.focus();
};

window.toggleMat = function(roomId, matId) {
  const m = findMat(roomId, matId);
  if (!m) return;
  m.done = !m.done;
  render();
};

window.editMat = function(roomId, matId, field, val) {
  const m = findMat(roomId, matId);
  if (!m) return;
  if (field === 'qty') {
    m[field] = parseFloat(val) || 0;
  } else if (field === 'priceEst' || field === 'priceFinal') {
    m[field] = val !== '' ? parseFloat(val) : null;
  } else {
    m[field] = val.trim();
  }
  // Save without re-rendering — the user just blurred, the DOM already reflects
  // what they typed. A full render here would rebuild the DOM mid-interaction.
  save(true);
};

window.delMat = function(roomId, matId) {
  const r = getRoom(roomId);
  if (!r) return;
  const m = r.materials.find(mat => mat.id === matId);
  if (!m) return;
  if (!confirm(`Czy na pewno chcesz usunąć materiał: "${m.name}"?`)) return;
  r.materials = r.materials.filter(mat => mat.id !== matId);
  render();
};

window.addImages = function(roomId, evt) {
  if (!storage) {
    alert("Cloud Storage nie jest skonfigurowany. Zdjęcia pozostaną tylko lokalnie.");
    const r = getRoom(roomId);
    if (!r) return;
    [...evt.target.files].forEach(f => {
      const fr = new FileReader();
      fr.onload = e => {
        r.images.push({ id: uid(), data: e.target.result, name: f.name });
        render();
      };
      fr.readAsDataURL(f);
    });
    return;
  }

  const files = [...evt.target.files];
  if (!files.length) return;

  setBanner("sync", `Przesyłanie ${files.length} zdjęć…`);
  console.log(`[Storage] Starting upload of ${files.length} files for room ${roomId}`);

  // Collect results in a local array — never touch state.rooms inside the async callbacks.
  // This prevents a Firestore snapshot that fires between two awaits from causing
  // some images to be pushed to a detached (replaced) room object and lost.
  const newImages = [];
  let failCount = 0;

  const uploads = files.map(async f => {
    const fileId = uid();
    const path = `rooms/${roomId}/${fileId}_${f.name}`;
    const storageRef = ref(storage, path);

    try {
      console.log(`[Storage] Uploading ${f.name} to ${path}...`);
      const snap = await uploadBytes(storageRef, f);
      console.log(`[Storage] Upload successful for ${f.name}`);
      const url = await getDownloadURL(snap.ref);
      console.log(`[Storage] URL obtained: ${url}`);
      newImages.push({ id: uid(), url, path, name: f.name });
    } catch (err) {
      console.error(`[Storage] Error during upload of ${f.name}:`, err.code, err.message);
      failCount++;
      setBanner("error", "Błąd: " + (err.code || err.message));
    }
  });

  Promise.all(uploads).then(() => {
    if (newImages.length > 0) {
      // Get a single fresh room reference after all uploads are done and apply atomically.
      const r = getRoom(roomId);
      if (r) {
        console.log(`[Storage] Pushing ${newImages.length} images to room atomically`);
        r.images.push(...newImages);
        setBanner("sync", failCount > 0 ? `Przesłano ${newImages.length}, błąd ${failCount}` : "Zdjęcia przesłane", 3000);
        render(true);
      } else {
        console.error(`[Storage] Room ${roomId} not found — files uploaded to Storage but not linked`);
        setBanner("error", "Pokój nie istnieje — zdjęcia przesłane do Storage, ale nie zapisane");
      }
    } else if (failCount > 0) {
      console.error(`[Storage] All uploads failed`);
      setBanner("error", "Nie udało się przesłać zdjęć");
    }
  });
};

window.delImg = function(roomId, imgId) {
  if (!confirm('Czy na pewno chcesz usunąć to zdjęcie?')) return;
  const r = getRoom(roomId);
  if (!r) return;
  const idx = r.images.findIndex(img => img.id === imgId);
  if (idx === -1) return;
  const img = r.images[idx];

  if (img.path && storage) {
    const storageRef = ref(storage, img.path);
    deleteObject(storageRef).catch(err => {
      console.warn("Could not delete file from storage:", err);
    });
  }

  r.images.splice(idx, 1);
  render(true);
};

window.openImage = function(url) {
  const overlay = document.createElement('div');
  overlay.className = 'img-overlay';
  overlay.innerHTML = `<img src="${url}" alt="enlarged">`;
  overlay.onclick = () => document.body.removeChild(overlay);
  document.body.appendChild(overlay);
};

window.exportJSON = function() {
  const json = JSON.stringify(state, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'remont_materialy.json';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
};

window.importJSON = function(evt) {
  const f = evt.target.files[0]; if (!f) return;
  const fr = new FileReader();
  fr.onload = e => {
    try {
      state = JSON.parse(e.target.result);
      if (!state.activeRoom && state.rooms.length) state.activeRoom = state.rooms[0].id;
      ensureIds();
      render();
    } catch (err) { alert('Błąd pliku — upewnij się, że to prawidłowy plik JSON z tej aplikacji.'); }
  };
  fr.readAsText(f);
};

window.openShareModal = function() {
  showModal('Udostępnij listę', () => `
    <p style="font-size:13px;color:#555;margin-bottom:12px">
      ${db
        ? 'Synchronizacja przez Firestore jest aktywna — wszystkie osoby z dostępem do strony widzą te same dane i zdjęcia w czasie rzeczywistym.'
        : 'Firestore nie jest skonfigurowany — dane są przechowywane lokalnie w przeglądarce.'}
    </p>
    <p style="font-size:13px;color:#555;margin-bottom:12px">
      Zdjęcia są przechowywane w Firebase Cloud Storage i dostępne dla każdego współdzielącego listę.
    </p>
  `, null, false);
};

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

function showModal(title, bodyFn, cb, hasInput = true) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = typeof bodyFn === 'function' ? bodyFn() : '';
  const btns = document.getElementById('modal-btns');
  btns.innerHTML = cb
    ? `<button class="btn" onclick="closeModal()">Anuluj</button><button class="btn primary" onclick="modalConfirm()">OK</button>`
    : `<button class="btn primary" onclick="closeModal()">Zamknij</button>`;
  document.getElementById('modal').style.display = 'flex';
  if (hasInput) setTimeout(() => document.getElementById('modal-input')?.focus(), 50);
  modalCb = cb;
}

window.modalConfirm = function() {
  const val = document.getElementById('modal-input')?.value;
  const cb = modalCb; modalCb = null;
  document.getElementById('modal').style.display = 'none';
  if (cb) cb(val);
};

window.closeModal = function() {
  modalCb = null;
  document.getElementById('modal').style.display = 'none';
};

document.getElementById('modal').addEventListener('click', e => { if (e.target.id === 'modal') window.closeModal(); });

// ---------------------------------------------------------------------------

init();