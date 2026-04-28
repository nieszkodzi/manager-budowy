import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js";
import { getFirestore, doc, onSnapshot, setDoc } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-storage.js";

// ---------------------------------------------------------------------------
// Firebase setup
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
let pendingSaveCount = 0;
let saveDebounceTimer = null;

function debouncedSave() {
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => save(true), 600);
}

// Cancel any pending debounce and save immediately — called on textarea blur
// so notes are in Firestore (pendingSaveCount > 0) before any snapshot can arrive.
window.flushSave = function() {
  clearTimeout(saveDebounceTimer);
  save(true);
};

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

// Back-fill stable ids and deleted:false on items that predate this feature.
function ensureIds() {
  state.rooms.forEach(r => {
    if (!r.id) r.id = uid();
    if (r.deleted === undefined) r.deleted = false;
    r.materials.forEach(m => {
      if (!m.id) m.id = uid();
      if (m.deleted === undefined) m.deleted = false;
    });
    r.images.forEach(img => {
      if (!img.id) img.id = uid();
      if (img.deleted === undefined) img.deleted = false;
    });
  });
}

// ---------------------------------------------------------------------------
// Persistence
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
        path: img.path,
        deleted: img.deleted
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
    state.rooms = ROOMS_DEFAULT.map(n => ({ id: uid(), name: n, images: [], materials: [], deleted: false }));
    state.activeRoom = state.rooms[0].id;
  }
  if (!state.activeRoom && state.rooms.length) state.activeRoom = state.rooms[0].id;
  ensureIds();

  if (db) {
    console.log("[Firestore] attaching listener to", FIRESTORE_DOC);
    setBanner("sync", "Łączenie z Firestore…");
    unsubscribe = onSnapshot(doc(db, FIRESTORE_DOC), snapshot => {
      console.log("[Firestore] snapshot received, exists:", snapshot.exists(), "fromCache:", snapshot.metadata.fromCache);

      if (snapshot.metadata.hasPendingWrites) {
        console.log("[Firestore] pending writes, skipping update");
        return;
      }
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
        state.rooms = remote.rooms || [];
        ensureIds();
        localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
        setBanner("sync", "Zsynchronizowano", 2000);
      } else {
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
  const liveRooms = state.rooms.filter(r => !r.deleted);
  el.innerHTML = liveRooms.map(r => {
    const liveMats = r.materials.filter(m => !m.deleted);
    const total = liveMats.length, done = liveMats.filter(m => m.done).length;
    const cls = total === 0 ? 'empty' : done === total ? 'done' : 'partial';
    const active = r.id === state.activeRoom ? 'active' : '';
    return `<div class="room-item ${active}" data-id="${r.id}">
      <div class="drag-handle">⋮⋮</div>
      <div class="room-click-area" onclick="selectRoom('${r.id}')">
        <div class="room-dot ${cls}"></div><span>${escHtml(r.name)}</span>
      </div>
    </div>`;
  }).join('');

  // Trash entry at the bottom — only if there's anything deleted
  const hasDeletedRooms = state.rooms.some(r => r.deleted);
  const hasDeletedContent = state.rooms.some(r =>
    r.materials.some(m => m.deleted) || r.images.some(img => img.deleted)
  );
  if (hasDeletedRooms || hasDeletedContent) {
    el.innerHTML += `<div class="room-item trash-item" onclick="openTrash()">
      <div style="width:24px"></div>
      <div class="room-click-area" style="color:#aaa;font-size:12px">
        <span>🗑 Kosz</span>
      </div>
    </div>`;
  }

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
    filter: '.trash-item',
    onEnd: (evt) => {
      // Sortable operates on the visible (live) room list only.
      // Map DOM indices back to the full state.rooms array.
      const liveRooms = state.rooms.filter(r => !r.deleted);
      const movedRoom = liveRooms[evt.oldIndex];
      if (!movedRoom) return;
      // Re-order within the live subset, then rebuild state.rooms preserving deleted rooms at their positions.
      const reordered = [...liveRooms];
      const [moved] = reordered.splice(evt.oldIndex, 1);
      reordered.splice(evt.newIndex, 0, moved);
      // Reconstruct full array: replace live slots with reordered, keep deleted in place.
      let liveIdx = 0;
      state.rooms = state.rooms.map(r => r.deleted ? r : reordered[liveIdx++]);
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
  if (!room || room.deleted) { el.innerHTML = '<div class="empty-state">Wybierz pomieszczenie</div>'; return; }

  if (isEditing && document.activeElement && el.contains(document.activeElement)) {
    console.log("[Render] skipping content render due to active editing");
    return;
  }

  const liveMats = room.materials.filter(m => !m.deleted);
  const liveImages = room.images.filter(img => !img.deleted);
  const total = liveMats.length, done = liveMats.filter(m => m.done).length;
  const pct = total ? Math.round(done / total * 100) : 0;
  const estTotal = liveMats.reduce((s, m) => s + (parseFloat(m.priceEst) || 0), 0);
  const finalTotal = liveMats.reduce((s, m) => s + (parseFloat(m.priceFinal) || 0), 0);

  const imgGrid = liveImages.map(img => {
    const src = escHtml(img.url || img.data || '');
    return `<div class="img-thumb" onclick="openImage('${src}')">
      <img src="${src}" alt="wizualizacja">
      <button class="img-del" onclick="event.stopPropagation();delImg('${room.id}','${img.id}')">✕</button>
    </div>`;
  }).join('');

  const matRows = liveMats.map(m => `
    <div class="mat-row ${m.done ? 'done-row' : ''}" data-id="${m.id}">
      <div class="drag-handle">⋮⋮</div>
      <input type="checkbox" class="mat-check" ${m.done ? 'checked' : ''} onchange="toggleMat('${room.id}','${m.id}')">
      <div class="mat-name-cell">
        <div class="mat-name" contenteditable="true" onfocus="setEditing(true)" onblur="setEditing(false);editMat('${room.id}','${m.id}','name',this.innerText)">${escHtml(m.name)}</div>
        <textarea class="mat-notes" placeholder="Notatki..."
          onfocus="setEditing(true);autoResize(this)"
          oninput="autoResize(this)"
          onblur="setEditing(false);updateMatField('${room.id}','${m.id}','notes',this.value);save(true)">${escHtml(m.notes || '')}</textarea>
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

  const deletedMatCount = room.materials.filter(m => m.deleted).length;
  const deletedImgCount = room.images.filter(img => img.deleted).length;
  const trashCount = deletedMatCount + deletedImgCount;

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
        ${trashCount ? `<button class="btn" style="color:#aaa;font-size:13px" onclick="openTrash('${room.id}')">🗑 Kosz (${trashCount})</button>` : ''}
        <button class="btn danger" onclick="deleteRoom('${room.id}')">Usuń pomieszczenie</button>
      </div>
    </div>
    <div class="room-notes-section">
      <textarea class="room-notes" placeholder="Notatki do pomieszczenia..."
        onfocus="setEditing(true);autoResize(this)"
        oninput="autoResize(this)"
        onblur="setEditing(false);updateRoomNotes('${room.id}',this.value);save(true)">${escHtml(room.notes || '')}</textarea>
    </div>
    <div class="summary-bar">
      <div class="sum-card"><div class="sum-label">Wszystkich pozycji</div><div class="sum-val">${total}</div></div>
      <div class="sum-card"><div class="sum-label">Kupione</div><div class="sum-val" style="color:#3B6D11">${done}</div></div>
      <div class="sum-card"><div class="sum-label">Do kupienia</div><div class="sum-val" style="color:#BA7517">${total - done}</div></div>
      <div class="sum-card"><div class="sum-label">Postęp</div><div class="sum-val">${pct}%</div></div>
      ${estTotal > 0 ? `<div class="sum-card"><div class="sum-label">Szacunkowy koszt</div><div class="sum-val" style="font-size:1rem">${formatPrice(estTotal)}</div></div>` : ''}
      ${finalTotal > 0 ? `<div class="sum-card"><div class="sum-label">Koszt końcowy</div><div class="sum-val" style="font-size:1rem;color:#3B6D11">${formatPrice(finalTotal)}</div></div>` : ''}
    </div>
    ${liveImages.length ? `<div class="img-section"><div class="img-label">Wizualizacje / inspiracje</div><div class="img-grid">${imgGrid}</div></div>` : ''}
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
      const liveMats = room.materials.filter(m => !m.deleted);
      const [moved] = liveMats.splice(evt.oldIndex, 1);
      liveMats.splice(evt.newIndex, 0, moved);
      let liveIdx = 0;
      room.materials = room.materials.map(m => m.deleted ? m : liveMats[liveIdx++]);
      save(true);
      render(false);
    }
  });
}

// ---------------------------------------------------------------------------
// Trash modal
// ---------------------------------------------------------------------------

window.openTrash = function(roomId) {
  // If roomId given: show deleted materials + images for that room.
  // If no roomId: show all deleted rooms.
  const buildBody = () => {
    let html = '';

    if (roomId) {
      const room = getRoom(roomId);
      if (!room) return '<p style="color:#aaa">Brak usuniętych elementów.</p>';

      const deletedMats = room.materials.filter(m => m.deleted);
      const deletedImgs = room.images.filter(img => img.deleted);

      if (deletedMats.length) {
        html += `<div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Materiały</div>`;
        html += deletedMats.map(m => `
          <div class="trash-row">
            <span style="flex:1;font-size:13px">${escHtml(m.name)}</span>
            <button class="btn" style="font-size:12px;padding:4px 10px" onclick="restoreMat('${roomId}','${m.id}')">Przywróć</button>
          </div>`).join('');
      }

      if (deletedImgs.length) {
        html += `<div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em;margin:12px 0 8px">Zdjęcia</div>`;
        html += `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px">`;
        html += deletedImgs.map(img => {
          const src = escHtml(img.url || img.data || '');
          return `<div style="position:relative;width:80px;height:60px;border-radius:6px;overflow:hidden;border:0.5px solid #ddd">
            <img src="${src}" style="width:100%;height:100%;object-fit:cover;opacity:0.5">
            <button class="btn" style="position:absolute;bottom:2px;right:2px;font-size:10px;padding:2px 6px" onclick="restoreImg('${roomId}','${img.id}')">↩</button>
          </div>`;
        }).join('');
        html += '</div>';
      }

      if (!deletedMats.length && !deletedImgs.length) {
        html = '<p style="color:#aaa;font-size:13px">Kosz jest pusty.</p>';
      }
    } else {
      // Global trash — deleted rooms
      const deletedRooms = state.rooms.filter(r => r.deleted);
      if (deletedRooms.length) {
        html += `<div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Pomieszczenia</div>`;
        html += deletedRooms.map(r => `
          <div class="trash-row">
            <span style="flex:1;font-size:13px">${escHtml(r.name)}</span>
            <button class="btn" style="font-size:12px;padding:4px 10px" onclick="restoreRoom('${r.id}')">Przywróć</button>
          </div>`).join('');
      }

      // Also show rooms that have deleted content
      const roomsWithDeletedContent = state.rooms.filter(r =>
        !r.deleted && (r.materials.some(m => m.deleted) || r.images.some(img => img.deleted))
      );
      if (roomsWithDeletedContent.length) {
        html += `<div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em;margin:12px 0 8px">Usunięte elementy w pomieszczeniach</div>`;
        html += roomsWithDeletedContent.map(r => {
          const dc = r.materials.filter(m => m.deleted).length + r.images.filter(img => img.deleted).length;
          return `<div class="trash-row">
            <span style="flex:1;font-size:13px">${escHtml(r.name)} <span style="color:#aaa">(${dc})</span></span>
            <button class="btn" style="font-size:12px;padding:4px 10px" onclick="closeModal();openTrash('${r.id}')">Pokaż</button>
          </div>`;
        }).join('');
      }

      if (!deletedRooms.length && !roomsWithDeletedContent.length) {
        html = '<p style="color:#aaa;font-size:13px">Kosz jest pusty.</p>';
      }
    }
    return html;
  };

  showModal('Kosz', buildBody, null, false);
};

window.restoreRoom = function(id) {
  const r = getRoom(id);
  if (!r) return;
  r.deleted = false;
  if (!state.activeRoom) state.activeRoom = id;
  closeModal();
  render();
};

window.restoreMat = function(roomId, matId) {
  const m = findMat(roomId, matId);
  if (!m) return;
  m.deleted = false;
  closeModal();
  render();
};

window.restoreImg = function(roomId, imgId) {
  const r = getRoom(roomId);
  if (!r) return;
  const img = r.images.find(i => i.id === imgId);
  if (!img) return;
  img.deleted = false;
  closeModal();
  render();
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function formatPrice(val) {
  if (val == null || val === '') return '—';
  return Number(val).toLocaleString('pl-PL', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' zł';
}

window.selectRoom = function(id) {
  if (state.activeRoom === id) return;
  state.activeRoom = id;
  render(false);
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

window.updateRoomNotes = function(id, notes) {
  const r = getRoom(id); if (!r) return;
  r.notes = notes;
};

window.updateMatField = function(roomId, matId, field, val) {
  const m = findMat(roomId, matId); if (!m) return;
  m[field] = val;
};

window.addRoom = function() {
  showModal('Nowe pomieszczenie', () => `<input id="modal-input" placeholder="Nazwa pomieszczenia..." onkeydown="if(event.key==='Enter')modalConfirm()">`,
    val => {
      if (!val || !val.trim()) return;
      const r = { id: uid(), name: val.trim(), images: [], materials: [], notes: '', deleted: false };
      state.rooms.push(r);
      state.activeRoom = r.id;
      render();
    });
};

window.deleteRoom = function(id) {
  if (!confirm('Przenieść to pomieszczenie do kosza?')) return;
  const r = getRoom(id);
  if (!r) return;
  r.deleted = true;
  const liveRooms = state.rooms.filter(r => !r.deleted);
  state.activeRoom = liveRooms.length ? liveRooms[0].id : null;
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
  getRoom(roomId).materials.push({ id: uid(), name, qty, unit, link, done: false, notes: '', priceEst, priceFinal, deleted: false });
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
  save(true);
};

window.delMat = function(roomId, matId) {
  const m = findMat(roomId, matId);
  if (!m) return;
  m.deleted = true;
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
        r.images.push({ id: uid(), data: e.target.result, name: f.name, deleted: false });
        render();
      };
      fr.readAsDataURL(f);
    });
    return;
  }

  const files = [...evt.target.files];
  if (!files.length) return;

  setBanner("sync", `Przesyłanie ${files.length} zdjęć…`);
  const newImages = [];
  let failCount = 0;

  const uploads = files.map(async f => {
    const fileId = uid();
    const path = `rooms/${roomId}/${fileId}_${f.name}`;
    const storageRef = ref(storage, path);
    try {
      const snap = await uploadBytes(storageRef, f);
      const url = await getDownloadURL(snap.ref);
      newImages.push({ id: uid(), url, path, name: f.name, deleted: false });
    } catch (err) {
      console.error(`[Storage] Error during upload of ${f.name}:`, err.code, err.message);
      failCount++;
      setBanner("error", "Błąd: " + (err.code || err.message));
    }
  });

  Promise.all(uploads).then(() => {
    if (newImages.length > 0) {
      const r = getRoom(roomId);
      if (r) {
        r.images.push(...newImages);
        setBanner("sync", failCount > 0 ? `Przesłano ${newImages.length}, błąd ${failCount}` : "Zdjęcia przesłane", 3000);
        render(true);
      } else {
        setBanner("error", "Pokój nie istnieje — zdjęcia przesłane do Storage, ale nie zapisane");
      }
    } else if (failCount > 0) {
      setBanner("error", "Nie udało się przesłać zdjęć");
    }
  });
};

window.delImg = function(roomId, imgId) {
  const r = getRoom(roomId);
  if (!r) return;
  const img = r.images.find(i => i.id === imgId);
  if (!img) return;
  img.deleted = true;
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