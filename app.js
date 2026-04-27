import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js";
import { getFirestore, doc, onSnapshot, setDoc } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js";

// ---------------------------------------------------------------------------
// Firebase setup — skipped gracefully if config is missing or incomplete
// ---------------------------------------------------------------------------

const cfg = window.FIREBASE_CONFIG || {};
const firebaseReady = cfg.apiKey && !cfg.apiKey.startsWith("YOUR_");

let db = null;
let unsubscribe = null;

if (firebaseReady) {
  const app = initializeApp(cfg);
  db = getFirestore(app);
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
let ignoreNextRemoteUpdate = false;

function uid() { return Math.random().toString(36).slice(2, 10); }
function getRoom(id) { return state.rooms.find(r => r.id === id); }

// ---------------------------------------------------------------------------
// Persistence — Firestore when available, localStorage as fallback
// ---------------------------------------------------------------------------

const LOCAL_KEY = 'remont_v2';
const FIRESTORE_DOC = 'shared/state';

function stateForStorage() {
  // Strip base64 images — too large for Firestore (1 MB doc limit).
  // Images stay local only.
  return {
    activeRoom: state.activeRoom,
    rooms: state.rooms.map(r => ({ ...r, images: [] }))
  };
}

function save() {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
  if (db) {
    ignoreNextRemoteUpdate = true;
    setDoc(doc(db, FIRESTORE_DOC), stateForStorage()).catch(err => {
      console.error("Firestore write failed:", err);
      ignoreNextRemoteUpdate = false;
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
    setBanner("sync", "Łączenie z Firestore…");
    unsubscribe = onSnapshot(doc(db, FIRESTORE_DOC), snapshot => {
      if (ignoreNextRemoteUpdate) { ignoreNextRemoteUpdate = false; return; }
      if (snapshot.exists()) {
        const remote = snapshot.data();
        // Merge: keep active room from remote, restore local images
        state.rooms = remote.rooms || [];
        state.activeRoom = remote.activeRoom || (state.rooms[0]?.id ?? null);
        loadLocalImages();
        localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
      } else {
        // First time — push local state to Firestore
        save();
      }
      setBanner("sync", "Zsynchronizowano", 2000);
      render();
    }, err => {
      console.error("Firestore listen failed:", err);
      setBanner("error", "Brak połączenia z Firestore — tryb lokalny");
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

function render() { renderSidebar(); renderContent(); save(); }

function renderSidebar() {
  const el = document.getElementById('room-list');
  el.innerHTML = state.rooms.map(r => {
    const total = r.materials.length, done = r.materials.filter(m => m.done).length;
    const cls = total === 0 ? 'empty' : done === total ? 'done' : 'partial';
    const active = r.id === state.activeRoom ? 'active' : '';
    return `<div class="room-item ${active}" onclick="selectRoom('${r.id}')">
      <div class="room-dot ${cls}"></div><span>${escHtml(r.name)}</span>
    </div>`;
  }).join('');
}

function renderContent() {
  const el = document.getElementById('content');
  const room = getRoom(state.activeRoom);
  if (!room) { el.innerHTML = '<div class="empty-state">Wybierz pomieszczenie</div>'; return; }
  const total = room.materials.length, done = room.materials.filter(m => m.done).length;
  const pct = total ? Math.round(done / total * 100) : 0;

  const imgGrid = room.images.map((img, i) => `
    <div class="img-thumb">
      <img src="${img.data}" alt="wizualizacja">
      <button class="img-del" onclick="delImg('${room.id}',${i})">✕</button>
    </div>`).join('');

  const matRows = room.materials.map((m, i) => `
    <div class="mat-row ${m.done ? 'done-row' : ''}">
      <input type="checkbox" class="mat-check" ${m.done ? 'checked' : ''} onchange="toggleMat('${room.id}',${i})">
      <div class="mat-name" contenteditable="true" onblur="editMat('${room.id}',${i},'name',this.innerText)">${escHtml(m.name)}</div>
      <div class="mat-qty">
        <input type="number" value="${m.qty}" min="0" step="0.1"
          style="width:60px;font-size:13px;padding:3px 6px;border-radius:6px;border:0.5px solid #ddd;text-align:center"
          onchange="editMat('${room.id}',${i},'qty',this.value)">
      </div>
      <div class="mat-unit">
        <input type="text" value="${escHtml(m.unit || 'szt.')}"
          style="width:54px;font-size:12px;padding:3px 6px;border-radius:6px;border:0.5px solid #ddd;text-align:center;color:#888"
          onchange="editMat('${room.id}',${i},'unit',this.value)">
      </div>
      <div class="mat-link">
        <input type="url" value="${escHtml(m.link || '')}" placeholder="https://..."
          style="width:120px;font-size:12px;padding:3px 6px;border-radius:6px;border:0.5px solid #ddd"
          onchange="editMat('${room.id}',${i},'link',this.value)">
        ${m.link ? `<br><a href="${escHtml(m.link)}" target="_blank" rel="noopener">↗ otwórz</a>` : ''}
      </div>
      <div class="mat-del"><button onclick="delMat('${room.id}',${i})" title="Usuń">×</button></div>
      <div style="display:flex;flex-direction:column;gap:1px">
        <button onclick="moveMat('${room.id}',${i},-1)" ${i === 0 ? 'disabled' : ''} title="W górę"
          style="background:none;border:none;cursor:pointer;color:${i === 0 ? '#ddd' : '#888'};font-size:11px;padding:1px 3px">▲</button>
        <button onclick="moveMat('${room.id}',${i},1)" ${i === room.materials.length - 1 ? 'disabled' : ''} title="W dół"
          style="background:none;border:none;cursor:pointer;color:${i === room.materials.length - 1 ? '#ddd' : '#888'};font-size:11px;padding:1px 3px">▼</button>
      </div>
    </div>`).join('');

  el.innerHTML = `
    <div class="room-header">
      <div class="room-title-row">
        <div class="room-title" contenteditable="true" onblur="renameRoom('${room.id}',this.innerText)">${escHtml(room.name)}</div>
        ${total ? `<span class="progress-badge">${done}/${total} kupione</span>` : ''}
      </div>
      <div class="room-actions">
        <label class="btn" style="cursor:pointer;font-size:13px">+ Dodaj zdjęcie
          <input type="file" accept="image/*" multiple onchange="addImages('${room.id}',event)">
        </label>
        <button class="btn danger" onclick="deleteRoom('${room.id}')">Usuń pomieszczenie</button>
      </div>
    </div>
    <div class="summary-bar">
      <div class="sum-card"><div class="sum-label">Wszystkich pozycji</div><div class="sum-val">${total}</div></div>
      <div class="sum-card"><div class="sum-label">Kupione</div><div class="sum-val" style="color:#3B6D11">${done}</div></div>
      <div class="sum-card"><div class="sum-label">Do kupienia</div><div class="sum-val" style="color:#BA7517">${total - done}</div></div>
      <div class="sum-card"><div class="sum-label">Postęp</div><div class="sum-val">${pct}%</div></div>
    </div>
    ${room.images.length ? `<div class="img-section"><div class="img-label">Wizualizacje / inspiracje (tylko lokalnie)</div><div class="img-grid">${imgGrid}</div></div>` : ''}
    <div class="materials-section">
      <div class="mat-header">
        <div style="width:16px"></div>
        <div style="flex:2">Materiał / produkt</div>
        <div style="width:70px;text-align:center">Ilość</div>
        <div style="width:60px;text-align:center">Jednostka</div>
        <div style="width:140px">Link</div>
        <div style="width:56px"></div>
      </div>
      ${matRows || `<div style="padding:1.5rem;text-align:center;color:#aaa;font-size:13px">Brak materiałów — dodaj poniżej</div>`}
      <div class="add-mat-row">
        <input class="in-name" id="in-name" placeholder="Nazwa materiału..."
          onkeydown="if(event.key==='Enter')addMat('${room.id}')">
        <input class="in-qty" type="number" id="in-qty" placeholder="Ilość" min="0" step="0.1">
        <input class="in-unit" id="in-unit" placeholder="szt.">
        <input class="in-link" type="url" id="in-link" placeholder="https://... (opcjonalnie)">
        <button class="btn primary" onclick="addMat('${room.id}')">Dodaj</button>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Actions — exposed to inline handlers via window.*
// ---------------------------------------------------------------------------

function escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

window.selectRoom = function(id) { state.activeRoom = id; render(); };

window.renameRoom = function(id, name) {
  const r = getRoom(id); if (r && name.trim()) { r.name = name.trim(); save(); renderSidebar(); }
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
  const name = document.getElementById('in-name').value.trim();
  if (!name) return;
  const qty = parseFloat(document.getElementById('in-qty').value) || 1;
  const unit = document.getElementById('in-unit').value.trim() || 'szt.';
  const link = document.getElementById('in-link').value.trim();
  getRoom(roomId).materials.push({ id: uid(), name, qty, unit, link, done: false });
  render();
};

window.toggleMat = function(roomId, idx) { getRoom(roomId).materials[idx].done = !getRoom(roomId).materials[idx].done; render(); };

window.editMat = function(roomId, idx, field, val) {
  const r = getRoom(roomId);
  r.materials[idx][field] = field === 'qty' ? (parseFloat(val) || 0) : val.trim();
  save(); renderSidebar();
};

window.moveMat = function(roomId, idx, dir) {
  const r = getRoom(roomId), to = idx + dir;
  if (to < 0 || to >= r.materials.length) return;
  [r.materials[idx], r.materials[to]] = [r.materials[to], r.materials[idx]];
  render();
};

window.delMat = function(roomId, idx) { getRoom(roomId).materials.splice(idx, 1); render(); };

window.addImages = function(roomId, evt) {
  const r = getRoom(roomId);
  [...evt.target.files].forEach(f => {
    const fr = new FileReader();
    fr.onload = e => { r.images.push({ data: e.target.result, name: f.name }); render(); };
    fr.readAsDataURL(f);
  });
};

window.delImg = function(roomId, idx) { getRoom(roomId).images.splice(idx, 1); render(); };

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
        ? 'Synchronizacja przez Firestore jest aktywna — wszystkie osoby z dostępem do strony widzą te same dane w czasie rzeczywistym.'
        : 'Firestore nie jest skonfigurowany — dane są przechowywane lokalnie w przeglądarce.'}
    </p>
    <p style="font-size:13px;color:#555;margin-bottom:12px">
      Możesz też wyeksportować dane do pliku JSON i wysłać go drugiej osobie — zaimportuje go przyciskiem "Importuj JSON".
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
