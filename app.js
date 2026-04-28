import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js";
import {
  initializeFirestore, persistentLocalCache,
  collection, doc, addDoc, setDoc, updateDoc,
  onSnapshot, writeBatch
} from "https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-storage.js";

// ---------------------------------------------------------------------------
// Firebase setup
// ---------------------------------------------------------------------------

const cfg = window.FIREBASE_CONFIG || {};
const firebaseReady = cfg.apiKey && !cfg.apiKey.startsWith("YOUR_");

let db = null;
let storage = null;

if (firebaseReady) {
  try {
    const app = initializeApp(cfg);
    db = initializeFirestore(app, { localCache: persistentLocalCache() });
    storage = getStorage(app);
    console.log("[Firebase] initialized OK");
  } catch (e) {
    console.error("[Firebase] init error:", e);
  }
}

// ---------------------------------------------------------------------------
// Firestore path helpers
//   projects/shared/rooms/{roomId}
//   projects/shared/rooms/{roomId}/materials/{matId}
//   projects/shared/rooms/{roomId}/photos/{photoId}
// ---------------------------------------------------------------------------

const PROJECT = "shared";
const roomsCol  = ()           => collection(db, "projects", PROJECT, "rooms");
const roomDoc   = (id)         => doc(db, "projects", PROJECT, "rooms", id);
const matsCol   = (rId)        => collection(db, "projects", PROJECT, "rooms", rId, "materials");
const matDoc    = (rId, mId)   => doc(db, "projects", PROJECT, "rooms", rId, "materials", mId);
const photosCol = (rId)        => collection(db, "projects", PROJECT, "rooms", rId, "photos");
const photoDoc  = (rId, pId)   => doc(db, "projects", PROJECT, "rooms", rId, "photos", pId);

// ---------------------------------------------------------------------------
// In-memory state  (rebuilt from Firestore snapshots — never written directly)
// ---------------------------------------------------------------------------

const ROOMS_DEFAULT = [
  "Wiatrołap","Kotłownia","Kuchnia","Jadalnia","Salon",
  "Korytarz górny","Sypialnia Główna","Sypialnia Remek",
  "Sypialnia Eliza","Sypialnia Tosia","Łazienka na piętrze",
  "Strych","Łazienka na strychu"
];

const roomsMap    = new Map(); // roomId  -> room object
const matsMap     = new Map(); // roomId  -> Map(matId   -> material)
const photosMap   = new Map(); // roomId  -> Map(photoId -> photo)

let activeRoomId    = localStorage.getItem('activeRoom') || null;
let subscribedRoomId = null;

let unsubRooms     = null;
let unsubMaterials = null;
let unsubPhotos    = null;
let roomSortable   = null;
let matSortable    = null;
let modalCb        = null;
let isEditing      = false;

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

const byOrder    = (a, b) => (a.order || 0) - (b.order || 0);
const sortedVals = map    => [...(map?.values() || [])].sort(byOrder);

function liveRooms()          { return sortedVals(roomsMap).filter(r => !r.deleted); }
function allRooms()           { return sortedVals(roomsMap); }
function liveMats(roomId)     { return sortedVals(matsMap.get(roomId)).filter(m => !m.deleted); }
function allMats(roomId)      { return sortedVals(matsMap.get(roomId)); }
function livePhotos(roomId)   { return sortedVals(photosMap.get(roomId)).filter(p => !p.deleted); }
function allPhotos(roomId)    { return sortedVals(photosMap.get(roomId)); }
function getRoom(id)          { return roomsMap.get(id); }
function getMat(rId, mId)     { return matsMap.get(rId)?.get(mId); }
function getPhoto(rId, pId)   { return photosMap.get(rId)?.get(pId); }
function nextOrder(items)     { return items.length ? Math.max(...items.map(i => i.order || 0)) + 1000 : 0; }

// ---------------------------------------------------------------------------
// Firestore listeners
// ---------------------------------------------------------------------------

function subscribeToRooms() {
  if (!db) return;
  unsubRooms = onSnapshot(roomsCol(), snap => {
    snap.forEach(d => roomsMap.set(d.id, { id: d.id, ...d.data() }));
    snap.docChanges().forEach(ch => { if (ch.type === 'removed') roomsMap.delete(ch.doc.id); });

    // Seed default rooms on very first load (empty server collection)
    if (snap.empty && !snap.metadata.fromCache) {
      seedDefaultRooms();
      return;
    }

    // Fix activeRoomId if the room was deleted or never existed
    if (!activeRoomId || !roomsMap.has(activeRoomId) || getRoom(activeRoomId)?.deleted) {
      const first = liveRooms()[0];
      activeRoomId = first?.id || null;
      activeRoomId ? localStorage.setItem('activeRoom', activeRoomId)
                   : localStorage.removeItem('activeRoom');
    }

    subscribeToRoom(activeRoomId);
    renderSidebar();
  }, err => {
    console.error("[Firestore] rooms:", err);
    setBanner("error", "Błąd połączenia: " + (err.code || err.message));
  });
}

function subscribeToRoom(roomId) {
  if (subscribedRoomId === roomId) return;
  subscribedRoomId = roomId;
  if (unsubMaterials) { unsubMaterials(); unsubMaterials = null; }
  if (unsubPhotos)    { unsubPhotos();    unsubPhotos    = null; }

  if (!roomId || !db) { renderContent(); return; }

  unsubMaterials = onSnapshot(matsCol(roomId), snap => {
    if (!matsMap.has(roomId)) matsMap.set(roomId, new Map());
    const m = matsMap.get(roomId);
    snap.forEach(d => m.set(d.id, { id: d.id, ...d.data() }));
    snap.docChanges().forEach(ch => { if (ch.type === 'removed') m.delete(ch.doc.id); });
    renderContent();
  }, err => console.error("[Firestore] materials:", err));

  unsubPhotos = onSnapshot(photosCol(roomId), snap => {
    if (!photosMap.has(roomId)) photosMap.set(roomId, new Map());
    const p = photosMap.get(roomId);
    snap.forEach(d => p.set(d.id, { id: d.id, ...d.data() }));
    snap.docChanges().forEach(ch => { if (ch.type === 'removed') p.delete(ch.doc.id); });
    renderContent();
  }, err => console.error("[Firestore] photos:", err));
}

async function seedDefaultRooms() {
  console.log("[Firestore] seeding default rooms");
  const batch = writeBatch(db);
  ROOMS_DEFAULT.forEach((name, i) => {
    batch.set(doc(roomsCol()), { name, notes: '', order: i * 1000, deleted: false });
  });
  await batch.commit();
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
  const styles = { sync: 'background:#eaf3de;color:#3B6D11', error: 'background:#fcebeb;color:#a32d2d', local: 'background:#f5f4f0;color:#888' };
  el.style.cssText += ';' + (styles[type] || styles.local);
  el.style.opacity = '1';
  el.textContent = text;
  if (autoClearMs) setTimeout(() => { el.style.opacity = '0'; }, autoClearMs);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

window.setEditing  = val => { isEditing = val; };
window.autoResize  = el  => { if (!el) return; el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; };

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function formatPrice(val) {
  if (val == null || val === '') return '—';
  return Number(val).toLocaleString('pl-PL', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' zł';
}

function renderSidebar() {
  const el = document.getElementById('room-list');
  el.innerHTML = liveRooms().map(r => {
    const mats = liveMats(r.id);
    const total = mats.length, done = mats.filter(m => m.done).length;
    const cls = total === 0 ? 'empty' : done === total ? 'done' : 'partial';
    return `<div class="room-item ${r.id === activeRoomId ? 'active' : ''}" data-id="${r.id}">
      <div class="drag-handle">⋮⋮</div>
      <div class="room-click-area" onclick="selectRoom('${r.id}')">
        <div class="room-dot ${cls}"></div><span>${escHtml(r.name)}</span>
      </div>
    </div>`;
  }).join('');

  const hasDeletedRooms   = allRooms().some(r => r.deleted);
  const hasDeletedContent = [...roomsMap.keys()].some(rId =>
    allMats(rId).some(m => m.deleted) || allPhotos(rId).some(p => p.deleted)
  );
  if (hasDeletedRooms || hasDeletedContent) {
    el.innerHTML += `<div class="room-item trash-item" onclick="openTrash()">
      <div style="width:24px"></div>
      <div class="room-click-area" style="color:#aaa;font-size:12px"><span>🗑 Kosz</span></div>
    </div>`;
  }

  initRoomSortable();
}

function renderContent() {
  const el = document.getElementById('content');
  const room = getRoom(activeRoomId);
  if (!room || room.deleted) { el.innerHTML = '<div class="empty-state">Wybierz pomieszczenie</div>'; return; }
  if (isEditing && document.activeElement && el.contains(document.activeElement)) return;

  const mats  = liveMats(room.id);
  const imgs  = livePhotos(room.id);
  const total = mats.length, done = mats.filter(m => m.done).length;
  const pct   = total ? Math.round(done / total * 100) : 0;
  const estTotal   = mats.reduce((s, m) => s + (parseFloat(m.priceEst)   || 0), 0);
  const finalTotal = mats.reduce((s, m) => s + (parseFloat(m.priceFinal) || 0), 0);

  const imgGrid = imgs.map(img => {
    const src = escHtml(img.url || '');
    const cap = img.description ? escHtml(img.description) : '';
    return `<div class="img-thumb" onclick="openImage('${src}','${room.id}','${img.id}')">
      <div class="img-thumb-photo"><img src="${src}" alt="wizualizacja"></div>
      <div class="img-thumb-caption ${cap ? '' : 'empty'}">${cap || 'dodaj opis...'}</div>
      <button class="img-del" onclick="event.stopPropagation();delImg('${room.id}','${img.id}')">✕</button>
    </div>`;
  }).join('');

  const matRows = mats.map(m => `
    <div class="mat-row ${m.done ? 'done-row' : ''}" data-id="${m.id}">
      <div class="drag-handle">⋮⋮</div>
      <input type="checkbox" class="mat-check" ${m.done ? 'checked' : ''} onchange="toggleMat('${room.id}','${m.id}')">
      <div class="mat-name-cell">
        <div class="mat-name" contenteditable="true"
          onfocus="setEditing(true)"
          onblur="setEditing(false);editMat('${room.id}','${m.id}','name',this.innerText)">${escHtml(m.name)}</div>
        <textarea class="mat-notes" placeholder="Notatki..."
          onfocus="setEditing(true);autoResize(this)"
          oninput="autoResize(this)"
          onblur="setEditing(false);editMat('${room.id}','${m.id}','notes',this.value)">${escHtml(m.notes || '')}</textarea>
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

  const trashCount = allMats(room.id).filter(m => m.deleted).length +
                     allPhotos(room.id).filter(p => p.deleted).length;

  el.innerHTML = `
    <div class="room-header">
      <div class="room-title-row">
        <div class="room-title" contenteditable="true"
          onfocus="setEditing(true)"
          onblur="setEditing(false);renameRoom('${room.id}',this.innerText)">${escHtml(room.name)}</div>
        ${total ? `<span class="progress-badge">${done}/${total} kupione</span>` : ''}
      </div>
      <div class="room-actions">
        ${trashCount ? `<button class="btn" style="color:#aaa;font-size:13px" onclick="openTrash('${room.id}')">🗑 Kosz (${trashCount})</button>` : ''}
        <button class="btn danger" onclick="deleteRoom('${room.id}')">Usuń pomieszczenie</button>
      </div>
    </div>
    <div class="room-notes-section">
      <textarea class="room-notes" placeholder="Notatki do pomieszczenia..."
        onfocus="setEditing(true);autoResize(this)"
        oninput="autoResize(this)"
        onblur="setEditing(false);updateRoomNotes('${room.id}',this.value)">${escHtml(room.notes || '')}</textarea>
    </div>
    <div class="summary-bar">
      <div class="sum-card"><div class="sum-label">Wszystkich pozycji</div><div class="sum-val">${total}</div></div>
      <div class="sum-card"><div class="sum-label">Kupione</div><div class="sum-val" style="color:#3B6D11">${done}</div></div>
      <div class="sum-card"><div class="sum-label">Do kupienia</div><div class="sum-val" style="color:#BA7517">${total - done}</div></div>
      <div class="sum-card"><div class="sum-label">Postęp</div><div class="sum-val">${pct}%</div></div>
      ${estTotal   > 0 ? `<div class="sum-card"><div class="sum-label">Szacunkowy koszt</div><div class="sum-val" style="font-size:1rem">${formatPrice(estTotal)}</div></div>` : ''}
      ${finalTotal > 0 ? `<div class="sum-card"><div class="sum-label">Koszt końcowy</div><div class="sum-val" style="font-size:1rem;color:#3B6D11">${formatPrice(finalTotal)}</div></div>` : ''}
    </div>
    <div class="img-section">
      ${imgs.length ? `<div class="img-label">Wizualizacje / inspiracje</div><div class="img-grid">${imgGrid}</div>` : ''}
      <div class="img-drop-zone" id="img-drop-zone-${room.id}"
        ondragover="event.preventDefault();this.classList.add('drag-over')"
        ondragleave="this.classList.remove('drag-over')"
        ondrop="handleImgDrop('${room.id}',event)">
        Przeciągnij zdjęcia tutaj lub <label style="color:#888;cursor:pointer;text-decoration:underline">wybierz z dysku<input type="file" accept="image/*" multiple style="display:none" onchange="addImages('${room.id}',event)"></label>
      </div>
    </div>
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
  el.querySelectorAll('textarea').forEach(t => window.autoResize(t));
}

// ---------------------------------------------------------------------------
// Sortable
// ---------------------------------------------------------------------------

function initRoomSortable() {
  const el = document.getElementById('room-list');
  if (!el) return;
  if (roomSortable) { try { roomSortable.destroy(); } catch (e) {} roomSortable = null; }
  roomSortable = Sortable.create(el, {
    animation: 150, handle: '.drag-handle', ghostClass: 'sortable-ghost', filter: '.trash-item',
    onEnd: async evt => {
      if (!db) return;
      const live = liveRooms();
      const [moved] = live.splice(evt.oldIndex, 1);
      live.splice(evt.newIndex, 0, moved);
      const batch = writeBatch(db);
      live.forEach((r, i) => batch.update(roomDoc(r.id), { order: i * 1000 }));
      await batch.commit();
    }
  });
}

function initMatSortable(roomId) {
  const el = document.getElementById('mat-list');
  if (matSortable) { try { matSortable.destroy(); } catch (e) {} matSortable = null; }
  if (!el || (el.children.length <= 1 && el.innerText.includes('Brak'))) return;
  matSortable = Sortable.create(el, {
    animation: 150, handle: '.drag-handle', ghostClass: 'sortable-ghost',
    onEnd: async evt => {
      if (!db) return;
      const mats = liveMats(roomId);
      const [moved] = mats.splice(evt.oldIndex, 1);
      mats.splice(evt.newIndex, 0, moved);
      const batch = writeBatch(db);
      mats.forEach((m, i) => batch.update(matDoc(roomId, m.id), { order: i * 1000 }));
      await batch.commit();
    }
  });
}

// ---------------------------------------------------------------------------
// Trash modal
// ---------------------------------------------------------------------------

window.openTrash = function(roomId) {
  const buildBody = () => {
    let html = '';
    if (roomId) {
      const deletedMats  = allMats(roomId).filter(m => m.deleted);
      const deletedImgs  = allPhotos(roomId).filter(p => p.deleted);
      if (deletedMats.length) {
        html += `<div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Materiały</div>`;
        html += deletedMats.map(m => `<div class="trash-row">
          <span style="flex:1;font-size:13px">${escHtml(m.name)}</span>
          <button class="btn" style="font-size:12px;padding:4px 10px" onclick="restoreMat('${roomId}','${m.id}')">Przywróć</button>
        </div>`).join('');
      }
      if (deletedImgs.length) {
        html += `<div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em;margin:12px 0 8px">Zdjęcia</div>`;
        html += `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px">`;
        html += deletedImgs.map(img => `
          <div style="position:relative;width:80px;height:60px;border-radius:6px;overflow:hidden;border:0.5px solid #ddd">
            <img src="${escHtml(img.url)}" style="width:100%;height:100%;object-fit:cover;opacity:0.5">
            <button class="btn" style="position:absolute;bottom:2px;right:2px;font-size:10px;padding:2px 6px" onclick="restorePhoto('${roomId}','${img.id}')">↩</button>
          </div>`).join('');
        html += '</div>';
      }
      if (!deletedMats.length && !deletedImgs.length) html = '<p style="color:#aaa;font-size:13px">Kosz jest pusty.</p>';
    } else {
      const deletedRooms = allRooms().filter(r => r.deleted);
      if (deletedRooms.length) {
        html += `<div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Pomieszczenia</div>`;
        html += deletedRooms.map(r => `<div class="trash-row">
          <span style="flex:1;font-size:13px">${escHtml(r.name)}</span>
          <button class="btn" style="font-size:12px;padding:4px 10px" onclick="restoreRoom('${r.id}')">Przywróć</button>
        </div>`).join('');
      }
      const withDeleted = [...roomsMap.keys()].filter(rId => {
        const r = getRoom(rId);
        return r && !r.deleted && (allMats(rId).some(m => m.deleted) || allPhotos(rId).some(p => p.deleted));
      });
      if (withDeleted.length) {
        html += `<div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em;margin:12px 0 8px">Usunięte elementy w pomieszczeniach</div>`;
        html += withDeleted.map(rId => {
          const r = getRoom(rId);
          const dc = allMats(rId).filter(m => m.deleted).length + allPhotos(rId).filter(p => p.deleted).length;
          return `<div class="trash-row">
            <span style="flex:1;font-size:13px">${escHtml(r.name)} <span style="color:#aaa">(${dc})</span></span>
            <button class="btn" style="font-size:12px;padding:4px 10px" onclick="closeModal();openTrash('${rId}')">Pokaż</button>
          </div>`;
        }).join('');
      }
      if (!deletedRooms.length && !withDeleted.length) html = '<p style="color:#aaa;font-size:13px">Kosz jest pusty.</p>';
    }
    return html;
  };
  showModal('Kosz', buildBody, null, false);
};

window.restoreRoom = function(id) {
  if (!db) return;
  updateDoc(roomDoc(id), { deleted: false });
  if (!activeRoomId) { activeRoomId = id; localStorage.setItem('activeRoom', id); }
  closeModal();
};

window.restoreMat = function(roomId, matId) {
  if (!db) return;
  updateDoc(matDoc(roomId, matId), { deleted: false });
  closeModal();
};

window.restorePhoto = function(roomId, photoId) {
  if (!db) return;
  updateDoc(photoDoc(roomId, photoId), { deleted: false });
  closeModal();
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

window.selectRoom = function(id) {
  if (activeRoomId === id) return;
  activeRoomId = id;
  localStorage.setItem('activeRoom', id);
  subscribeToRoom(id);
  renderSidebar();
  window.toggleSidebar(false);
};

window.toggleSidebar = function(force) {
  const sb      = document.querySelector('.sidebar');
  const overlay = document.querySelector('.sidebar-overlay');
  if (sb) {
    const isOpen = force !== undefined ? force : !sb.classList.contains('open');
    sb.classList.toggle('open', isOpen);
    overlay?.classList.toggle('show', isOpen);
  }
};

window.addRoom = function() {
  showModal('Nowe pomieszczenie',
    () => `<input id="modal-input" placeholder="Nazwa pomieszczenia..." onkeydown="if(event.key==='Enter')modalConfirm()">`,
    async val => {
      if (!val?.trim() || !db) return;
      const order = nextOrder(liveRooms());
      const ref = doc(roomsCol());
      await setDoc(ref, { name: val.trim(), notes: '', order, deleted: false });
      activeRoomId = ref.id;
      localStorage.setItem('activeRoom', ref.id);
      subscribeToRoom(ref.id);
    });
};

window.renameRoom = function(id, name) {
  if (!name.trim() || !db) return;
  updateDoc(roomDoc(id), { name: name.trim() });
};

window.updateRoomNotes = function(id, notes) {
  if (!db) return;
  updateDoc(roomDoc(id), { notes });
};

window.deleteRoom = function(id) {
  if (!confirm('Przenieść to pomieszczenie do kosza?') || !db) return;
  updateDoc(roomDoc(id), { deleted: true });
  const next = liveRooms().find(r => r.id !== id);
  activeRoomId = next?.id || null;
  activeRoomId ? localStorage.setItem('activeRoom', activeRoomId)
               : localStorage.removeItem('activeRoom');
  subscribeToRoom(activeRoomId);
};

window.addMat = function(roomId) {
  if (!db) return;
  const name = document.getElementById('in-name').value.trim();
  if (!name) return;
  const qty          = parseFloat(document.getElementById('in-qty').value) || 1;
  const unit         = document.getElementById('in-unit').value.trim() || 'szt.';
  const link         = document.getElementById('in-link').value.trim();
  const priceEstRaw  = document.getElementById('in-price-est').value;
  const priceFinalRaw= document.getElementById('in-price-final').value;
  const priceEst     = priceEstRaw   !== '' ? parseFloat(priceEstRaw)   : null;
  const priceFinal   = priceFinalRaw !== '' ? parseFloat(priceFinalRaw) : null;
  const order        = nextOrder(liveMats(roomId));
  addDoc(matsCol(roomId), { name, qty, unit, link, done: false, notes: '', priceEst, priceFinal, order, deleted: false });
  ['in-name','in-qty','in-unit','in-link','in-price-est','in-price-final'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('in-name')?.focus();
};

window.toggleMat = function(roomId, matId) {
  if (!db) return;
  const m = getMat(roomId, matId);
  if (!m) return;
  updateDoc(matDoc(roomId, matId), { done: !m.done });
};

window.editMat = function(roomId, matId, field, val) {
  if (!db) return;
  let parsed = val;
  if      (field === 'qty')                            parsed = parseFloat(val) || 0;
  else if (field === 'priceEst' || field === 'priceFinal') parsed = val !== '' ? parseFloat(val) : null;
  else if (field === 'name')                           { parsed = val.trim(); if (!parsed) return; }
  else if (field === 'unit' || field === 'link')       parsed = val.trim();
  updateDoc(matDoc(roomId, matId), { [field]: parsed });
};

window.delMat = function(roomId, matId) {
  if (!db) return;
  updateDoc(matDoc(roomId, matId), { deleted: true });
};

window.addImages = function(roomId, evt) {
  if (!storage) { alert("Cloud Storage nie jest skonfigurowany."); return; }
  const files = [...evt.target.files];
  if (!files.length) return;
  setBanner("sync", `Przesyłanie ${files.length} zdjęć…`);
  let failCount = 0;
  const baseOrder = nextOrder(livePhotos(roomId));
  Promise.all(files.map(async (f, i) => {
    const fileId = Math.random().toString(36).slice(2, 10);
    const path = `rooms/${roomId}/${fileId}_${f.name}`;
    try {
      const snap = await uploadBytes(ref(storage, path), f);
      const url  = await getDownloadURL(snap.ref);
      await addDoc(photosCol(roomId), { url, path, name: f.name, description: '', order: baseOrder + i * 100, deleted: false });
    } catch (err) {
      console.error('[Storage] upload error:', err.code, err.message);
      failCount++;
    }
  })).then(() => {
    setBanner("sync", failCount > 0 ? `Przesłano ${files.length - failCount}, błąd ${failCount}` : "Zdjęcia przesłane", 3000);
  });
};

window.delImg = function(roomId, photoId) {
  if (!db) return;
  updateDoc(photoDoc(roomId, photoId), { deleted: true });
};

window.openImage = function(url, roomId, photoId) {
  const photo = getPhoto(roomId, photoId);
  const overlay = document.createElement('div');
  overlay.className = 'img-overlay';
  overlay.innerHTML = `
    <img src="${url}" alt="enlarged">
    <div class="img-overlay-footer">
      <textarea class="img-overlay-desc" placeholder="Opis zdjęcia (opcjonalnie)...">${photo ? escHtml(photo.description || '') : ''}</textarea>
      <span class="img-overlay-hint">Kliknij zdjęcie lub naciśnij Esc, żeby zamknąć</span>
    </div>`;
  const close = () => {
    const desc = overlay.querySelector('.img-overlay-desc').value;
    if (photo && db && desc !== (photo.description || '')) {
      updateDoc(photoDoc(roomId, photoId), { description: desc });
    }
    document.body.removeChild(overlay);
  };
  overlay.querySelector('img').onclick = close;
  overlay.querySelector('.img-overlay-desc').onclick = e => e.stopPropagation();
  overlay.onkeydown = e => { if (e.key === 'Escape') close(); };
  document.body.appendChild(overlay);
  overlay.querySelector('.img-overlay-desc').focus();
};

window.handleImgDrop = function(roomId, evt) {
  evt.preventDefault();
  document.getElementById(`img-drop-zone-${roomId}`)?.classList.remove('drag-over');
  const files = [...(evt.dataTransfer.files || [])].filter(f => f.type.startsWith('image/'));
  if (files.length) window.addImages(roomId, { target: { files } });
};

// ---------------------------------------------------------------------------
// Export / Import
// ---------------------------------------------------------------------------

window.exportJSON = function() {
  const data = {
    rooms: allRooms().map(r => ({
      ...r,
      materials: allMats(r.id),
      photos:    allPhotos(r.id)
    }))
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'remont_materialy.json';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
};

window.importJSON = function(evt) {
  const f = evt.target.files[0]; if (!f || !db) return;
  const fr = new FileReader();
  fr.onload = async e => {
    try {
      const data = JSON.parse(e.target.result);
      const rooms = data.rooms || [];
      if (!confirm(`Importować ${rooms.length} pomieszczeń? Dane zostaną dodane obok istniejących.`)) return;
      setBanner("sync", "Importowanie…");
      for (let i = 0; i < rooms.length; i++) {
        const r    = rooms[i];
        const rRef = doc(roomsCol());
        await setDoc(rRef, { name: r.name || 'Pomieszczenie', notes: r.notes || '', order: nextOrder(liveRooms()) + i * 1000, deleted: false });
        const mats = r.materials || [];
        for (let j = 0; j < mats.length; j++) {
          const m = mats[j];
          await addDoc(matsCol(rRef.id), {
            name: m.name || '', qty: m.qty || 1, unit: m.unit || 'szt.',
            link: m.link || '', done: m.done || false, notes: m.notes || '',
            priceEst: m.priceEst ?? null, priceFinal: m.priceFinal ?? null,
            order: j * 1000, deleted: false
          });
        }
      }
      setBanner("sync", "Zaimportowano", 3000);
    } catch { alert('Błąd pliku JSON.'); }
  };
  fr.readAsText(f);
};

window.openShareModal = function() {
  showModal('Udostępnij listę', () => `
    <p style="font-size:13px;color:#555;margin-bottom:12px">
      ${db
        ? 'Synchronizacja przez Firestore jest aktywna — wszystkie osoby z dostępem do strony widzą te same dane i zdjęcia w czasie rzeczywistym.'
        : 'Firestore nie jest skonfigurowany — skonfiguruj firebase-config.js.'}
    </p>`, null, false);
};

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

function showModal(title, bodyFn, cb, hasInput = true) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = typeof bodyFn === 'function' ? bodyFn() : '';
  document.getElementById('modal-btns').innerHTML = cb
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
// Init
// ---------------------------------------------------------------------------

function init() {
  if (db) {
    setBanner("sync", "Łączenie…");
    subscribeToRooms();
  } else {
    setBanner("local", "Tryb lokalny — skonfiguruj firebase-config.js");
    document.getElementById('content').innerHTML = '<div class="empty-state">Brak połączenia z Firebase</div>';
  }
}

window.addEventListener('beforeunload', () => {
  if (unsubRooms)     unsubRooms();
  if (unsubMaterials) unsubMaterials();
  if (unsubPhotos)    unsubPhotos();
});

init();