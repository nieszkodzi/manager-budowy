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
        name: img.name,
        url: img.url,
        path: img.path // Path in Firebase Storage to allow deletion
      }))
    }))
  };
}

function save(pushToFirestore = true) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
  if (db && pushToFirestore) {
    setDoc(doc(db, FIRESTORE_DOC), stateForStorage()).catch(err => {
      console.error("Firestore write failed:", err);
      setBanner("error", "Błąd zapisu: " + (err.code || err.message));
    });
  }
}

function loadLocalImages() {
  // After a remote update overwrites state, restore images from localStorage
  const local = JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}');
  if (!local.rooms) return;
  state.rooms.forEach(r => {
    const localRoom = local.rooms.find(lr => lr.id === r.id);
    if (localRoom) r.images = localRoom.images || [];
  });
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

  if (db) {
    console.log("[Firestore] attaching listener to", FIRESTORE_DOC);
    setBanner("sync", "Łączenie z Firestore…");
    unsubscribe = onSnapshot(doc(db, FIRESTORE_DOC), snapshot => {
      console.log("[Firestore] snapshot received, exists:", snapshot.exists(), "fromCache:", snapshot.metadata.fromCache);
      if (snapshot.metadata.hasPendingWrites) {
        console.log("[Firestore] pending writes, skipping update");
        return;
      }
      if (snapshot.exists()) {
        const remote = snapshot.data();
        console.log("[Firestore] data received from remote");
        
        // Merge strategy: preserve local data if we have pending changes or newer images
        const remoteRooms = remote.rooms || [];
        remoteRooms.forEach(rr => {
          const lr = state.rooms.find(l => l.id === rr.id);
          if (!lr) return;

          // 1. Preserve local images if they seem more complete
          if (lr.images?.length > (rr.images?.length || 0)) {
            console.log(`[Firestore] preserving local images for room ${rr.id}`);
            rr.images = lr.images;
          }

          // 2. If user is currently editing THIS room, we must be careful.
          // For now, we allow the remote update but the UI won't re-render 
          // the content area thanks to the isEditing check in renderContent.
          // This allows the state to be updated in background without jumping the cursor.
        });

        state.rooms = remoteRooms;
        // Do not update state.activeRoom from remote to allow independent navigation
        localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
        setBanner("sync", "Zsynchronizowano", 2000);
      } else {
        // First time OR document deleted — push local state to Firestore if it has data
        console.log("[Firestore] document does not exist");
        if (state.rooms.length > 0) {
          console.log("[Firestore] pushing local state to new document");
          save(true);
        }
        setBanner("sync", "Gotowy (nowy dokument)", 2000);
      }
      render(false);
    }, err => {
      console.error("Firestore listen failed:", err);
      setBanner("error", "Błąd połączenia: " + (err.code || err.message));
      // Fallback to local if permission denied
      if (err.code === 'permission-denied') {
        console.warn("[Firestore] access denied - check Security Rules");
      }
    });
  } else {
    setBanner("local", "Tryb lokalny (bez synchronizacji)");
  }

  render();
}

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

  const imgGrid = room.images.map((img, i) => `
    <div class="img-thumb" onclick="openImage('${img.url || img.data}')">
      <img src="${img.url || img.data}" alt="wizualizacja">
      <button class="img-del" onclick="event.stopPropagation();delImg('${room.id}',${i})">✕</button>
    </div>`).join('');

  const matRows = room.materials.map((m, i) => `
    <div class="mat-row ${m.done ? 'done-row' : ''}" data-idx="${i}">
      <div class="drag-handle">⋮⋮</div>
      <input type="checkbox" class="mat-check" ${m.done ? 'checked' : ''} onchange="toggleMat('${room.id}',${i})">
      <div class="mat-name-cell">
        <div class="mat-name" contenteditable="true" onfocus="setEditing(true)" onblur="setEditing(false);editMat('${room.id}',${i},'name',this.innerText)">${escHtml(m.name)}</div>
        <textarea class="mat-notes" placeholder="Notatki..." 
          onfocus="setEditing(true)" 
          oninput="autoResize(this)"
          onblur="setEditing(false);editMat('${room.id}',${i},'notes',this.value)">${escHtml(m.notes || '')}</textarea>
      </div>
      <div class="mat-qty">
        <input type="number" value="${m.qty}" min="0" step="0.1"
          style="width:60px;font-size:13px;padding:3px 6px;border-radius:6px;border:0.5px solid #ddd;text-align:center"
          onfocus="setEditing(true)" onblur="setEditing(false)" onchange="editMat('${room.id}',${i},'qty',this.value)">
      </div>
      <div class="mat-unit">
        <input type="text" value="${escHtml(m.unit || 'szt.')}"
          style="width:54px;font-size:12px;padding:3px 6px;border-radius:6px;border:0.5px solid #ddd;text-align:center;color:#888"
          onfocus="setEditing(true)" onblur="setEditing(false)" onchange="editMat('${room.id}',${i},'unit',this.value)">
      </div>
      <div class="mat-link">
        <input type="url" value="${escHtml(m.link || '')}" placeholder="https://..."
          style="width:120px;font-size:12px;padding:3px 6px;border-radius:6px;border:0.5px solid #ddd"
          onfocus="setEditing(true)" onblur="setEditing(false)" onchange="editMat('${room.id}',${i},'link',this.value)">
        ${m.link ? `<br><a href="${escHtml(m.link)}" target="_blank" rel="noopener">↗ otwórz</a>` : ''}
      </div>
      <div class="mat-del"><button onclick="delMat('${room.id}',${i})" title="Usuń">×</button></div>
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
        onfocus="setEditing(true)" 
        oninput="autoResize(this)"
        onblur="setEditing(false);renameRoomNotes('${room.id}',this.value)">${escHtml(room.notes || '')}</textarea>
    </div>
    <div class="summary-bar">
      <div class="sum-card"><div class="sum-label">Wszystkich pozycji</div><div class="sum-val">${total}</div></div>
      <div class="sum-card"><div class="sum-label">Kupione</div><div class="sum-val" style="color:#3B6D11">${done}</div></div>
      <div class="sum-card"><div class="sum-label">Do kupienia</div><div class="sum-val" style="color:#BA7517">${total - done}</div></div>
      <div class="sum-card"><div class="sum-label">Postęp</div><div class="sum-val">${pct}%</div></div>
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
  getRoom(roomId).materials.push({ id: uid(), name, qty, unit, link, done: false, notes: '' });
  render(true);
  document.getElementById('in-name')?.focus();
};

window.toggleMat = function(roomId, idx) { getRoom(roomId).materials[idx].done = !getRoom(roomId).materials[idx].done; render(); };

window.editMat = function(roomId, idx, field, val) {
  const r = getRoom(roomId);
  r.materials[idx][field] = field === 'qty' ? (parseFloat(val) || 0) : val.trim();
  render(true);
};

window.delMat = function(roomId, idx) {
  const r = getRoom(roomId);
  const m = r.materials[idx];
  if (!confirm(`Czy na pewno chcesz usunąć materiał: "${m.name}"?`)) return;
  r.materials.splice(idx, 1);
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
        r.images.push({ data: e.target.result, name: f.name });
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
  
  let successCount = 0;
  let failCount = 0;

  const uploads = files.map(async f => {
    const fileId = uid();
    const path = `rooms/${roomId}/${fileId}_${f.name}`;
    const storageRef = ref(storage, path);
    
    try {
      console.log(`[Storage] Uploading ${f.name} to ${path}...`);
      const snapshot = await uploadBytes(storageRef, f);
      console.log(`[Storage] Upload successful for ${f.name}`);
      const url = await getDownloadURL(snapshot.ref);
      console.log(`[Storage] URL obtained: ${url}`);
      
      // Get FRESH room reference to avoid race conditions with sync
      const r = getRoom(roomId);
      if (r) {
        r.images.push({ url, path, name: f.name });
        successCount++;
      } else {
        console.error(`[Storage] Room ${roomId} not found after upload!`);
        failCount++;
      }
    } catch (err) {
      console.error(`[Storage] Error during upload of ${f.name}:`, err.code, err.message);
      failCount++;
      setBanner("error", "Błąd: " + (err.code || err.message));
    }
  });

  Promise.all(uploads).then(() => {
    if (successCount > 0) {
      console.log(`[Storage] Finished ${successCount} uploads, saving state...`);
      setBanner("sync", failCount > 0 ? `Przesłano ${successCount}, błąd ${failCount}` : "Zdjęcia przesłane", 3000);
      render(true);
    } else if (failCount > 0) {
      console.error(`[Storage] All uploads failed`);
      setBanner("error", "Nie udało się przesłać zdjęć");
    }
  });
};

window.delImg = function(roomId, idx) {
  if (!confirm('Czy na pewno chcesz usunąć to zdjęcie?')) return;
  const r = getRoom(roomId);
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
