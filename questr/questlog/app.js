(() => {
'use strict';

/* =========================================================
   Questlog - side quests with photos, videos, a diary and funds
   Local-first: everything works on this device. If Supabase
   is configured (config.js) and you sign in, it syncs.
   ========================================================= */

const CFG = window.QUESTLOG_CONFIG || {};
const sb = (CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && window.supabase)
  ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;

const LS = 'questlog.v1';
const BUCKET = 'media';
const TABLES = { quests: 'quests', media: 'media_items', entries: 'diary_entries', txns: 'transactions' };
const KEYS = ['quests', 'media', 'entries', 'txns']; // quests first so foreign keys exist
const STATUSES = [['idea', 'Idea'], ['active', 'Active'], ['paused', 'Paused'], ['done', 'Done']];
const TYPES = { income: 'Income', personal: 'Personal' };
const MAX_VIDEO = 50 * 1024 * 1024;

let state = { quests: [], media: [], entries: [], txns: [], pendingDeletes: [] };
let session = null;
let syncStatus = 'local'; // local | syncing | synced | error

const ui = {
  view: 'home',
  questId: null,
  statusFilter: 'all',
  typeFilter: 'all',
  allBars: false,
  descOpen: false,
  showTxns: false,
  diaryQuest: '',
  diaryQuery: '',
  fundsQuest: '',
  fundsKind: '',
  fundsLimit: 200,
  draft: { body: '', quest_id: '' },
  viewer: null,
};

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (window.crypto && crypto.randomUUID)
  ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
const now = () => new Date().toISOString();
const pad = n => String(n).padStart(2, '0');
const localYMD = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => localYMD(new Date());
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const money = (n, dec = 2) => {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('en-ZA', { minimumFractionDigits: dec, maximumFractionDigits: dec }).replace(/ /g, ' ');
  return (v < 0 ? '-' : '') + 'R' + s;
};
const compact = n => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k' : String(Math.round(n));
const parseYMD = s => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const fmtDate = s => parseYMD(s).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtShort = s => parseYMD(s).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtTs = ts => new Date(ts).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtDur = s => { s = Math.round(Number(s) || 0); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
const fmtSize = b => b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(b >= 1e8 ? 0 : 1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
const sumTx = (list, kind) => list.reduce((a, t) => a + (t.kind === kind ? Number(t.amount) || 0 : 0), 0);
const ts = s => Date.parse(s) || 0;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 3200);
}

/* ---------- blob storage on this device (IndexedDB) ---------- */
const idb = {
  mem: new Map(),
  dbp: null,
  useMem: false,
  open() {
    if (!this.dbp) {
      this.dbp = new Promise(res => {
        try {
          if (!window.indexedDB) { this.useMem = true; return res(null); }
          const r = indexedDB.open('questlog', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('blobs');
          r.onsuccess = () => res(r.result);
          r.onerror = () => { this.useMem = true; res(null); };
        } catch (e) { this.useMem = true; res(null); }
      });
    }
    return this.dbp;
  },
  async run(mode, fn) {
    const db = await this.open();
    if (!db) return { mem: true };
    return new Promise((res, rej) => {
      const t = db.transaction('blobs', mode);
      const req = fn(t.objectStore('blobs'));
      t.oncomplete = () => res({ v: req ? req.result : undefined });
      t.onerror = t.onabort = () => rej(t.error);
    });
  },
  async get(k) { const r = await this.run('readonly', s => s.get(k)); return r.mem ? this.mem.get(k) : r.v; },
  async set(k, v) { const r = await this.run('readwrite', s => s.put(v, k)); if (r.mem) this.mem.set(k, v); },
  async del(k) { try { const r = await this.run('readwrite', s => s.delete(k)); if (r.mem) this.mem.delete(k); } catch (e) { /* ignore */ } },
  async clear() { try { const r = await this.run('readwrite', s => s.clear()); if (r.mem) this.mem.clear(); } catch (e) { /* ignore */ } },
};

/* ---------- persistence ---------- */
function saveLocal() { try { localStorage.setItem(LS, JSON.stringify(state)); } catch (e) { /* storage full or blocked */ } }
function loadLocal() {
  try {
    const s = JSON.parse(localStorage.getItem(LS) || 'null');
    if (s) state = { quests: s.quests || [], media: s.media || [], entries: s.entries || [], txns: s.txns || [], pendingDeletes: s.pendingDeletes || [] };
  } catch (e) { /* ignore corrupt data */ }
}
const clean = r => { const o = { ...r }; delete o._s; return o; };

function put(key, row) {
  row = { ...row, updated_at: now(), _s: false };
  const arr = state[key];
  const i = arr.findIndex(x => x.id === row.id);
  if (i >= 0) arr[i] = row; else arr.push(row);
  saveLocal();
  syncSoon();
  return row;
}
function remove(key, id) {
  const row = state[key].find(x => x.id === id);
  if (key === 'quests') {
    state.media.filter(m => m.quest_id === id).forEach(m => remove('media', m.id));
    for (const k of ['entries', 'txns']) {
      state[k] = state[k].map(r => r.quest_id === id ? { ...r, quest_id: null, updated_at: now(), _s: false } : r);
    }
  }
  const pd = { t: key, id };
  if (key === 'media' && row) {
    pd.paths = [row.path, row.thumb_path].filter(Boolean);
    idb.del(id + ':main'); idb.del(id + ':thumb'); freeUrls(id);
  }
  state[key] = state[key].filter(x => x.id !== id);
  state.pendingDeletes.push(pd);
  saveLocal();
  syncSoon();
}

/* ---------- sync (Supabase) ---------- */
let syncing = false, again = false, timer = null;

function setSync(s) { syncStatus = s; renderSync(); }
function renderSync() {
  const d = $('#syncdot');
  if (!d) return;
  d.className = 'dot ' + syncStatus;
  d.title = { local: 'Saved on this device only', syncing: 'Syncing...', synced: 'Synced', error: 'Sync problem - tap Settings' }[syncStatus];
}
function syncSoon() {
  if (!sb || !session) return;
  clearTimeout(timer);
  timer = setTimeout(sync, 500);
}

async function fetchAll(table) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select('*').range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

function merge(key, remote) {
  const local = new Map(state[key].map(r => [r.id, r]));
  const pending = new Set(state.pendingDeletes.filter(d => d.t === key).map(d => d.id));
  const remoteIds = new Set();
  for (const r of remote) {
    remoteIds.add(r.id);
    if (pending.has(r.id)) continue;
    const row = { ...r }; delete row.user_id;
    const l = local.get(r.id);
    if (!l) state[key].push({ ...row, _s: true });
    else if (l._s && new Date(row.updated_at) > new Date(l.updated_at)) {
      state[key][state[key].findIndex(x => x.id === r.id)] = { ...row, _s: true };
    }
  }
  // synced here before but gone remotely = deleted on another device
  const gone = state[key].filter(l => l._s && !remoteIds.has(l.id));
  if (gone.length) {
    state[key] = state[key].filter(l => !(l._s && !remoteIds.has(l.id)));
    if (key === 'media') gone.forEach(m => { idb.del(m.id + ':main'); idb.del(m.id + ':thumb'); freeUrls(m.id); });
  }
}

const extFor = m => ({ 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/mp4': 'mp4', 'video/3gpp': '3gp', 'image/png': 'png' }[m] || (String(m).startsWith('video/') ? 'mp4' : 'jpg'));

async function uploadMedia(r) {
  if (r.path) return; // already uploaded earlier
  const main = await idb.get(r.id + ':main');
  if (!main) return; // file missing on this device; sync the details only
  const folder = session.user.id;
  const path = `${folder}/${r.id}.${extFor(r.mime)}`;
  let res = await sb.storage.from(BUCKET).upload(path, main, { upsert: true, contentType: r.mime || undefined });
  if (res.error) throw res.error;
  let thumbPath = '';
  const thumb = await idb.get(r.id + ':thumb');
  if (thumb) {
    thumbPath = `${folder}/${r.id}_t.jpg`;
    res = await sb.storage.from(BUCKET).upload(thumbPath, thumb, { upsert: true, contentType: 'image/jpeg' });
    if (res.error) throw res.error;
  }
  r.path = path; r.thumb_path = thumbPath;
}

async function sync() {
  if (!sb || !session) return;
  if (syncing) { again = true; return; }
  syncing = true;
  setSync('syncing');
  try {
    for (const d of [...state.pendingDeletes]) {
      if (d.t === 'media' && d.paths && d.paths.length) {
        const { error: e1 } = await sb.storage.from(BUCKET).remove(d.paths);
        if (e1) throw e1;
      }
      const { error } = await sb.from(TABLES[d.t]).delete().eq('id', d.id);
      if (error) throw error;
      state.pendingDeletes = state.pendingDeletes.filter(x => !(x.t === d.t && x.id === d.id));
    }
    for (const key of KEYS) {
      const dirty = state[key].filter(r => !r._s);
      if (key === 'media') for (const r of dirty) await uploadMedia(r);
      for (let i = 0; i < dirty.length; i += 200) {
        const chunk = dirty.slice(i, i + 200);
        const { error } = await sb.from(TABLES[key]).upsert(chunk.map(clean));
        if (error) throw error;
        chunk.forEach(r => { r._s = true; });
      }
    }
    for (const key of KEYS) merge(key, await fetchAll(TABLES[key]));
    saveLocal();
    setSync('synced');
    render();
  } catch (e) {
    setSync('error');
    toast('Sync problem: ' + (e.message || e) + ' (saved on this device)');
  } finally {
    syncing = false;
    if (again) { again = false; syncSoon(); }
  }
}

async function initAuth() {
  if (!sb) return;
  try {
    const { data } = await sb.auth.getSession();
    session = data.session;
    sb.auth.onAuthStateChange((_e, s) => {
      session = s;
      if (s) setTimeout(sync, 0); else setSync('local');
    });
    if (session) sync();
  } catch (e) { setSync('error'); }
}

/* ---------- media: urls, hydration ---------- */
const urlCache = new Map();
const inflight = new Map();
function freeUrls(id) {
  for (const w of ['main', 'thumb']) { const k = id + ':' + w; if (urlCache.has(k)) { try { URL.revokeObjectURL(urlCache.get(k)); } catch (e) { /* ignore */ } urlCache.delete(k); } }
}
async function blobFor(id, which) {
  const have = await idb.get(id + ':' + which);
  if (have) return have;
  if (!sb || !session) return null;
  const m = state.media.find(x => x.id === id);
  const path = m && (which === 'thumb' ? m.thumb_path : m.path);
  if (!path) return null;
  const { data, error } = await sb.storage.from(BUCKET).download(path);
  if (error || !data) return null;
  await idb.set(id + ':' + which, data);
  return data;
}
async function urlFor(id, which) {
  const k = id + ':' + which;
  if (urlCache.has(k)) return urlCache.get(k);
  if (inflight.has(k)) return inflight.get(k);
  const p = (async () => {
    try {
      const b = await blobFor(id, which);
      if (!b) return null;
      const u = URL.createObjectURL(b);
      urlCache.set(k, u);
      return u;
    } catch (e) { return null; }
  })();
  inflight.set(k, p);
  const r = await p;
  inflight.delete(k);
  return r;
}
async function videoSrc(id) {
  if (await idb.get(id + ':main')) return urlFor(id, 'main');
  const m = state.media.find(x => x.id === id);
  if (sb && session && m && m.path) {
    try {
      const { data } = await sb.storage.from(BUCKET).createSignedUrl(m.path, 3600);
      if (data && data.signedUrl) return data.signedUrl;
    } catch (e) { /* fall back to downloading it */ }
    return urlFor(id, 'main'); // downloads, caches on this device, plays from there
  }
  return null;
}
async function loadMediaEl(el) {
  if (el.dataset.done) return;
  el.dataset.done = '1';
  const id = el.dataset.mid;
  if (el.tagName === 'VIDEO') {
    urlFor(id, 'thumb').then(u => { if (u) el.poster = u; });
    const u = await videoSrc(id);
    if (u) el.src = u; else toast('This video is not available offline yet');
  } else {
    const u = await urlFor(id, el.dataset.which || 'thumb');
    if (u) { el.src = u; el.classList.add('ready'); }
  }
}
let io = null;
function hydrate() {
  const els = $$('[data-mid]').filter(el => !el.dataset.done);
  if (!els.length) return;
  if (!('IntersectionObserver' in window)) { els.forEach(loadMediaEl); return; }
  if (!io) io = new IntersectionObserver(list => list.forEach(en => { if (en.isIntersecting) { io.unobserve(en.target); loadMediaEl(en.target); } }), { rootMargin: '600px' });
  els.forEach(el => { if (el.dataset.now) loadMediaEl(el); else io.observe(el); });
}

/* ---------- media: capture and processing ---------- */
function once(el, ev, ms) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { cleanup(); rej(new Error('timeout')); }, ms);
    const ok = () => { cleanup(); res(); };
    const bad = () => { cleanup(); rej(new Error('media error')); };
    function cleanup() { clearTimeout(t); el.removeEventListener(ev, ok); el.removeEventListener('error', bad); }
    el.addEventListener(ev, ok);
    el.addEventListener('error', bad);
  });
}
function drawTo(src, w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
const canvasBlob = (c, type, q) => new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('Could not process the image')), type, q));

async function loadBitmap(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* fall through */ }
    try { return await createImageBitmap(file); } catch (e) { /* fall through */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await once(img, 'load', 15000);
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
}

async function processImage(file) {
  const src = await loadBitmap(file);
  const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
  if (!w0 || !h0) throw new Error('Could not read that image');
  const big = Math.min(1, 1600 / Math.max(w0, h0));
  const small = Math.min(1, 480 / Math.max(w0, h0));
  const main = await canvasBlob(drawTo(src, w0 * big, h0 * big), 'image/jpeg', 0.82);
  const thumb = await canvasBlob(drawTo(src, w0 * small, h0 * small), 'image/jpeg', 0.75);
  if (src.close) src.close();
  return { main, thumb, width: Math.round(w0 * big), height: Math.round(h0 * big), mime: 'image/jpeg' };
}

async function processVideo(file) {
  if (file.size > MAX_VIDEO) throw new Error(`That video is ${fmtSize(file.size)}. The limit is 50 MB, so trim it or record at a lower quality.`);
  const base = { main: file, thumb: null, width: 9, height: 16, duration: null, mime: file.type || 'video/mp4' };
  const url = URL.createObjectURL(file);
  try {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    await once(v, 'loadeddata', 10000);
    base.duration = isFinite(v.duration) ? v.duration : null;
    base.width = v.videoWidth || base.width; base.height = v.videoHeight || base.height;
    try { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); await once(v, 'seeked', 4000); } catch (e) { /* use first frame */ }
    const small = Math.min(1, 480 / Math.max(base.width, base.height));
    base.thumb = await canvasBlob(drawTo(v, base.width * small, base.height * small), 'image/jpeg', 0.75);
  } catch (e) { /* keep the video even without a preview picture */ } finally { URL.revokeObjectURL(url); }
  return base;
}

function persistStorage() { try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ignore */ } }

async function addMedia(files, questId) {
  const list = Array.from(files || []);
  if (!list.length || !questId) return;
  persistStorage();
  let n = 0, added = 0;
  for (const file of list) {
    n++;
    try {
      const isVid = String(file.type).startsWith('video/'), isImg = String(file.type).startsWith('image/');
      if (!isVid && !isImg) { toast(`Skipped ${file.name || 'a file'}: not a photo or video`); continue; }
      toast(list.length > 1 ? `Saving ${n} of ${list.length}...` : 'Saving...');
      const p = isVid ? await processVideo(file) : await processImage(file);
      const id = uid();
      await idb.set(id + ':main', p.main);
      if (p.thumb) await idb.set(id + ':thumb', p.thumb);
      put('media', {
        id, quest_id: questId, kind: isVid ? 'video' : 'image', caption: '',
        width: p.width, height: p.height, duration: p.duration || null,
        size: p.main.size + (p.thumb ? p.thumb.size : 0), mime: p.mime,
        taken_at: new Date(file.lastModified || Date.now()).toISOString(),
        path: '', thumb_path: '', created_at: now(),
      });
      added++;
      render();
    } catch (e) { toast(e.message || 'Could not save that file'); }
  }
  if (added) toast(`Added ${added} ${added === 1 ? 'item' : 'items'}`);
}

function pickFiles(mode, questId) {
  const opts = {
    photo: { accept: 'image/*', capture: 'environment' },
    video: { accept: 'video/*', capture: 'environment' },
    gallery: { accept: 'image/*,video/*', multiple: true },
  }[mode];
  const i = document.createElement('input');
  i.type = 'file'; i.accept = opts.accept; i.style.display = 'none';
  if (opts.capture) i.setAttribute('capture', opts.capture);
  if (opts.multiple) i.multiple = true;
  i.addEventListener('change', () => { const f = Array.from(i.files || []); i.remove(); addMedia(f, questId); });
  i.addEventListener('cancel', () => i.remove());
  document.body.appendChild(i);
  i.click();
}

/* ---------- derived data ---------- */
const questById = id => state.quests.find(q => q.id === id);
function questStats(id) {
  let inn = 0, out = 0;
  for (const t of state.txns) if (t.quest_id === id) { if (t.kind === 'in') inn += Number(t.amount) || 0; else out += Number(t.amount) || 0; }
  return { inn, out, net: inn - out };
}
function goalProgress(q) {
  const goal = Number(q.goal);
  if (!(goal > 0)) return null;
  const s = questStats(q.id);
  const val = q.type === 'income' ? s.net : s.out;
  const raw = val / goal * 100;
  return { val, goal, raw, pct: clamp(raw, 0, 100), label: q.type === 'income' ? 'earned' : 'spent', over: q.type === 'personal' && raw > 100 };
}
const questMedia = id => state.media.filter(m => m.quest_id === id).sort((a, b) => ts(b.taken_at) - ts(a.taken_at));
const entryTs = e => {
  const c = ts(e.created_at);
  return String(e.entry_date) === localYMD(new Date(c)) ? c : Date.parse(String(e.entry_date) + 'T12:00:00');
};
function lastActivity(q) {
  let t = ts(q.created_at);
  for (const m of state.media) if (m.quest_id === q.id) t = Math.max(t, ts(m.created_at));
  for (const e of state.entries) if (e.quest_id === q.id) t = Math.max(t, ts(e.created_at));
  for (const x of state.txns) if (x.quest_id === q.id) t = Math.max(t, ts(x.created_at));
  return t;
}
const questOptions = (sel, allowNone = true, noneLabel = 'General (no quest)') =>
  (allowNone ? `<option value="">${esc(noneLabel)}</option>` : '') +
  state.quests.map(q => `<option value="${esc(q.id)}"${q.id === sel ? ' selected' : ''}>${esc(q.name)}</option>`).join('');
const typeBadge = t => `<span class="badge ${esc(t)}">${esc(TYPES[t] || t)}</span>`;
const statusPill = s => `<span class="st st-${esc(s)}">${esc((STATUSES.find(x => x[0] === s) || [s, s])[1])}</span>`;
const questTag = id => { const q = questById(id); return q ? `<span class="qtag">${esc(q.name)}</span>` : '<span class="qtag none">General</span>'; };

function goalBar(q) {
  const g = goalProgress(q);
  if (!g) return '';
  return `<div class="bar ${q.type}${g.over ? ' over' : ''}"><i style="width:${g.pct.toFixed(1)}%"></i></div>`;
}
const hue = name => { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const gradient = name => {
  const h = hue(name), cols = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6'], k = h % 6, a = 118 + h % 44;
  const order = cols.slice(k).concat(cols.slice(0, k));
  return `linear-gradient(${a}deg, ${order.map((c, i) => `var(${c}) ${(i * 100 / 6).toFixed(2)}% ${((i + 1) * 100 / 6).toFixed(2)}%`).join(', ')})`;
};

/* ---------- masonry (Pinterest layout, newest first going down) ---------- */
const mas = {};
function masonry(key, items) { mas[key] = items; return `<div class="masonry" data-mas="${esc(key)}"></div>`; }
const colsFor = w => w < 520 ? 2 : w < 820 ? 3 : w < 1100 ? 4 : 5;
function fillMasonry() {
  $$('[data-mas]').forEach(el => {
    const items = mas[el.dataset.mas] || [];
    const w = el.clientWidth || 360, gap = 12;
    const cols = colsFor(w);
    const cw = (w - gap * (cols - 1)) / cols;
    const heights = new Array(cols).fill(0);
    const bins = Array.from({ length: cols }, () => []);
    for (const it of items) {
      let c = 0;
      for (let i = 1; i < cols; i++) if (heights[i] < heights[c] - 0.5) c = i;
      bins[c].push(it.html);
      heights[c] += it.h(cw) + gap;
    }
    el.dataset.cols = cols;
    el.innerHTML = bins.map(b => `<div class="mcol">${b.join('')}</div>`).join('');
  });
  hydrate();
}
let rz = null;
window.addEventListener('resize', () => {
  clearTimeout(rz);
  rz = setTimeout(() => { if ($$('[data-mas]').some(el => String(colsFor(el.clientWidth || 360)) !== el.dataset.cols)) fillMasonry(); }, 150);
});

const playBadge = m => `<span class="play"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>${m.duration ? `<b>${fmtDur(m.duration)}</b>` : ''}</span>`;
const mediaRatio = m => clamp((Number(m.height) || 3) / (Number(m.width) || 4), 0.5, 1.8);

function questPin(q) {
  const cover = questMedia(q.id)[0];
  const r = cover ? clamp((Number(cover.height) || 3) / (Number(cover.width) || 4), 0.7, 1.45) : 0.75;
  const nImg = state.media.filter(m => m.quest_id === q.id && m.kind === 'image').length;
  const nVid = state.media.filter(m => m.quest_id === q.id && m.kind === 'video').length;
  const nNote = state.entries.filter(e => e.quest_id === q.id).length;
  const bits = [nImg ? `${nImg} photo${nImg === 1 ? '' : 's'}` : '', nVid ? `${nVid} video${nVid === 1 ? '' : 's'}` : '', nNote ? `${nNote} note${nNote === 1 ? '' : 's'}` : ''].filter(Boolean);
  const g = goalProgress(q);
  return {
    h: cw => cw * r + 86 + (g ? 16 : 0) + (bits.length ? 18 : 0),
    html: `<article class="pin" role="button" tabindex="0" data-action="open-quest" data-id="${esc(q.id)}">
      <div class="cover" style="aspect-ratio:1/${r.toFixed(3)};background:${gradient(q.name)}">
        <span class="initial">${esc(String(q.name).trim().charAt(0).toUpperCase())}</span>
        ${cover ? `<img alt="" data-mid="${esc(cover.id)}" data-which="thumb">` : ''}
        ${cover && cover.kind === 'video' ? playBadge(cover) : ''}
      </div>
      <div class="pinbody">
        <div class="pinname">${esc(q.name)}</div>
        <div class="pinmeta">${typeBadge(q.type)}${statusPill(q.status)}</div>
        ${g ? `<div class="pinbar">${goalBar(q)}<span class="muted small">${g.raw.toFixed(0)}% ${g.label}</span></div>` : ''}
        ${bits.length ? `<div class="muted small">${bits.join(' · ')}</div>` : ''}
      </div></article>`,
  };
}

function mediaCard(m, showQuest) {
  const r = mediaRatio(m);
  return {
    h: cw => cw * r + (m.caption ? 44 : 0) + (showQuest ? 28 : 0),
    html: `<article class="mcard" role="button" tabindex="0" data-action="open-media" data-id="${esc(m.id)}">
      <div class="mwrap" style="aspect-ratio:1/${r.toFixed(3)}"><img class="mimg" alt="" data-mid="${esc(m.id)}" data-which="thumb">${m.kind === 'video' ? playBadge(m) : ''}</div>
      ${(m.caption || showQuest) ? `<div class="mfoot2">${m.caption ? `<p class="mcap">${esc(m.caption)}</p>` : ''}${showQuest ? questTag(m.quest_id) : ''}</div>` : ''}
    </article>`,
  };
}

function entryCard(e, showQuest) {
  const body = String(e.body || '');
  const long = body.length > 200 || body.split('\n').length > 5;
  return {
    h: cw => 58 + (showQuest ? 8 : 0) + Math.min(7, Math.ceil(body.length / Math.max(8, cw / 7.6)) + (body.split('\n').length - 1)) * 21 + (long ? 22 : 0),
    html: `<article class="ecard" role="button" tabindex="0" data-action="read-entry" data-id="${esc(e.id)}">
      <div class="edate">${fmtShort(e.entry_date)}${showQuest ? ' ' + questTag(e.quest_id) : ''}</div>
      <p class="etext">${esc(body)}</p>
      ${long ? '<span class="more">Read more</span>' : ''}</article>`,
  };
}

/* ---------- views ---------- */
/* ---------- theme: auto / light (paper) / dark (CRT) ---------- */
const THEME_KEY = 'questlog.theme';
const getTheme = () => { try { const t = localStorage.getItem(THEME_KEY); return t === 'light' || t === 'dark' ? t : 'auto'; } catch (e) { return 'auto'; } };
const isDark = () => { const t = getTheme(); return t === 'dark' || (t === 'auto' && !!window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches); };
function applyTheme() {
  const t = getTheme(), r = document.documentElement;
  if (t === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', t);
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', isDark() ? '#12100d' : '#f0e4c8');
}
function setTheme(t) {
  try { if (t === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, t); } catch (e) { /* ignore */ }
  applyTheme(); render();
}
const themeBtn = () => `<button class="iconbtn" data-action="toggle-theme" aria-label="Switch to ${isDark() ? 'light' : 'dark'} mode" title="${isDark() ? 'Light' : 'Dark'} mode">${isDark()
  ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
  : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg>'}</button>`;

function header(title, actions = '') { return `<header class="vh"><h1>${esc(title)}</h1><div class="actions">${actions}${themeBtn()}</div></header>`; }

const ring = (pct, size = 72, stroke = 8) => {
  const r = size / 2 - stroke, c = 2 * Math.PI * r, p = clamp(pct, 0, 100);
  return `<span class="ringwrap" style="width:${size}px;height:${size}px"><svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
    <circle class="rt" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"/>
    <circle class="rp" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}" stroke-dasharray="${(c * p / 100).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg><b>${Math.round(p)}%</b></span>`;
};

function activityByDay() {
  const m = {};
  const add = d => { m[d] = (m[d] || 0) + 1; };
  state.media.forEach(x => add(localYMD(new Date(ts(x.taken_at)))));
  state.entries.forEach(x => add(String(x.entry_date).slice(0, 10)));
  state.txns.forEach(x => add(String(x.txn_date).slice(0, 10)));
  return m;
}
function streakOf(act) {
  const d = new Date();
  if (!act[localYMD(d)]) d.setDate(d.getDate() - 1); // today not done yet does not break it
  let n = 0;
  while (act[localYMD(d)]) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function heatTile() {
  const act = activityByDay(), today = new Date(), tStr = todayStr();
  let months = '';
  for (let k = 2; k >= 0; k--) {
    const first = new Date(today.getFullYear(), today.getMonth() - k, 1);
    const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const off = (first.getDay() + 6) % 7; // Monday first
    let dots = '<i class="d x"></i>'.repeat(off);
    for (let i = 1; i <= days; i++) {
      const key = `${first.getFullYear()}-${pad(first.getMonth() + 1)}-${pad(i)}`;
      const n = act[key] || 0;
      const cls = key > tStr ? 'f' : n >= 3 ? 'l2' : n ? 'l1' : '';
      dots += `<i class="d ${cls}" title="${fmtShort(key)}${n ? ': ' + n + ' update' + (n === 1 ? '' : 's') : ''}"></i>`;
    }
    months += `<div class="hm"><span>${first.toLocaleDateString('en-ZA', { month: 'short' })}</span><div class="dots">${dots}</div></div>`;
  }
  const st = streakOf(act);
  return `<section class="tile t-heat"><div class="thead"><h2>Activity</h2><span class="muted small">${st ? st + ' day streak' : 'Add something today'}</span></div><div class="hms">${months}</div></section>`;
}

function moneyTop() {
  const inn = sumTx(state.txns, 'in'), out = sumTx(state.txns, 'out'), net = inn - out;
  const mk = todayStr().slice(0, 7);
  const month = state.txns.filter(t => String(t.txn_date).slice(0, 7) === mk);
  const mNet = sumTx(month, 'in') - sumTx(month, 'out');
  const goalQs = state.quests.filter(q => q.type === 'income' && Number(q.goal) > 0);
  const gTotal = goalQs.reduce((a, q) => a + Number(q.goal), 0);
  const earned = goalQs.reduce((a, q) => a + Math.max(0, questStats(q.id).net), 0);
  let pct = 0, title = 'Goals', sub = 'Set a goal on a quest';
  if (gTotal > 0) { pct = earned / gTotal * 100; title = 'Income goals'; sub = `${money(earned, 0)} of ${money(gTotal, 0)}`; }
  else if (inn > 0) { pct = out / inn * 100; title = 'Spent of earned'; sub = `${money(out, 0)} of ${money(inn, 0)}`; }
  const split = inn + out > 0 ? inn / (inn + out) * 100 : 50;
  const rows = state.quests.map(q => ({ q, g: goalProgress(q) })).filter(x => x.g)
    .sort((a, b) => lastActivity(b.q) - lastActivity(a.q));
  const shown = ui.allBars ? rows : rows.slice(0, 4);
  return `<div class="bento">
    <section class="tile t-goal">
      <button class="tarrow" data-action="nav" data-view="funds" aria-label="Open funds">&#8599;</button>
      ${ring(pct, 76, 9)}
      <div class="tbot"><div class="ttitle">${esc(title)}</div><div class="tsub">${esc(sub)}</div></div>
    </section>
    <section class="tile t-net">
      <button class="tarrow" data-action="nav" data-view="funds" aria-label="Open funds">&#8599;</button>
      <div class="tbig ${net < 0 ? 'neg' : ''}">${money(net, 0)}</div>
      <div class="tbot"><div class="ttitle">Net</div><div class="tsub">${mNet < 0 ? '-' : '+'}${money(Math.abs(mNet), 0)} this month</div></div>
    </section>
    <section class="tile t-io">
      <div class="io"><span><i class="dot-in"></i>In</span><b>${money(inn, 0)}</b></div>
      <div class="io"><span><i class="dot-out"></i>Out</span><b>${money(out, 0)}</b></div>
      <div class="splitbar"><i style="width:${split.toFixed(1)}%"></i></div>
    </section>
    ${heatTile()}
    <section class="tile t-bars">
      <div class="thead"><h2>Quest progress</h2>${rows.length > 4 ? `<button class="linkbtn" data-action="toggle-bars">${ui.allBars ? 'Fewer' : `All ${rows.length}`}</button>` : ''}</div>
      ${shown.length ? `<div class="qbars">${shown.map(({ q, g }) => `
        <button class="qbar" data-action="open-quest" data-id="${esc(q.id)}">
          <span class="top"><b>${esc(q.name)}</b><span class="muted small">${g.raw.toFixed(0)}%</span></span>
          ${goalBar(q)}
          <span class="muted small">${money(g.val, 0)} / ${money(g.goal, 0)} ${g.label}</span></button>`).join('')}</div>`
        : '<p class="emptyline">Give a quest a goal and its progress shows here.</p>'}
    </section>
  </div>`;
}

function viewHome() {
  const list = state.quests
    .filter(q => (ui.statusFilter === 'all' || q.status === ui.statusFilter) && (ui.typeFilter === 'all' || q.type === ui.typeFilter))
    .sort((a, b) => lastActivity(b) - lastActivity(a));
  const chips = [['all', 'All'], ...STATUSES].map(([v, l]) => `<button class="chip${ui.statusFilter === v ? ' on' : ''}" data-action="status-filter" data-status="${v}">${l}</button>`).join('');
  const empty = !state.quests.length;
  const doneToday = !!activityByDay()[todayStr()];
  const n = state.quests.length;
  const term = empty ? '' : `<p class="term">&gt; ${n} quest${n === 1 ? '' : 's'} loaded${ui.hideWarn || doneToday ? '' : '<br><span class="warn">&gt; WARNING: nothing logged today. Add something now? <button class="yn" data-action="quick-add">Y</button>/<button class="yn" data-action="dismiss-warn">N</button></span>'}<span class="cur"></span></p>`;
  return `${header('Questlog', '<button class="btn hide-m" data-action="quick-add">+ Add</button><button class="btn primary" data-action="new-quest">+ New quest</button>')}
    ${term}
    ${moneyTop()}
    ${empty ? `<div class="empty-hero"><h2>Start your first quest</h2><p>Each quest gets its own board for photos, videos, notes and money. Its cover is the latest photo or video you add.</p><button class="btn primary" data-action="new-quest">+ New quest</button></div>` : `
    <div class="sechead"><h2>Your quests</h2>
      <select data-filter="typeFilter" aria-label="Type"><option value="all">All types</option><option value="income"${ui.typeFilter === 'income' ? ' selected' : ''}>Income</option><option value="personal"${ui.typeFilter === 'personal' ? ' selected' : ''}>Personal</option></select></div>
    <div class="chips">${chips}</div>
    ${list.length ? masonry('home', list.map(questPin)) : '<p class="emptyline">No quests match these filters.</p>'}`}`;
}

function viewQuest() {
  const q = questById(ui.questId);
  if (!q) { ui.view = 'home'; return viewHome(); }
  const s = questStats(q.id), g = goalProgress(q);
  const media = questMedia(q.id);
  const entries = state.entries.filter(e => e.quest_id === q.id);
  const feed = [
    ...media.map(m => ({ t: ts(m.taken_at), card: mediaCard(m, false) })),
    ...entries.map(e => ({ t: entryTs(e), card: entryCard(e, false) })),
  ].sort((a, b) => b.t - a.t).map(x => x.card);
  const desc = String(q.description || '');
  const longDesc = desc.length > 150 || desc.split('\n').length > 3;
  const txns = state.txns.filter(t => t.quest_id === q.id).sort(byDateDesc('txn_date'));
  const shownTx = ui.showTxns ? txns.slice(0, 8) : [];
  return `<button class="back" data-action="back-home">&lsaquo; All quests</button>
    <section class="card qhead">
      <div class="qhead-top">
        <div><h1>${esc(q.name)}</h1><div class="pinmeta">${typeBadge(q.type)}${statusPill(q.status)}</div></div>
        <button class="btn" data-action="edit-quest" data-id="${esc(q.id)}">Edit</button>
      </div>
      ${desc ? `<p class="desc${longDesc && !ui.descOpen ? ' clamp' : ''}">${esc(desc)}</p>${longDesc ? `<button class="linkbtn" data-action="toggle-desc">${ui.descOpen ? 'Show less' : 'Read more'}</button>` : ''}` : ''}
      <div class="qmoney2">
        ${g ? `<div class="mtop"><b>${money(g.val, 0)}</b><span class="muted"> of ${money(g.goal, 0)} ${q.type === 'personal' ? 'budget spent' : 'goal earned'}</span><span class="pct">${g.raw.toFixed(0)}%</span></div>
        <div class="bar big ${q.type}${g.over ? ' over' : ''}"><i style="width:${g.pct.toFixed(1)}%"></i></div>` : ''}
        <div class="mstats"><span><i class="pos">In</i> ${money(s.inn, 0)}</span><span><i class="neg">Out</i> ${money(s.out, 0)}</span><span><i>Net</i> <b class="${s.net < 0 ? 'neg' : ''}">${money(s.net, 0)}</b></span></div>
        <div class="row">
          <button class="btn sm" data-action="quest-money" data-id="${esc(q.id)}">+ Money</button>
          ${txns.length ? `<button class="btn sm ghost" data-action="toggle-txns">${ui.showTxns ? 'Hide' : 'Show'} money log (${txns.length})</button>` : ''}
        </div>
        ${shownTx.length ? `<div class="txlist">${shownTx.map(t => `<div class="txrow"><span class="muted small">${fmtShort(t.txn_date)}</span><span class="what">${esc(t.note) || '<span class="muted">No note</span>'}</span><b class="${t.kind === 'in' ? 'pos' : 'neg'}">${t.kind === 'in' ? '+' : '-'}${money(t.amount)}</b><button class="btn sm ghost" data-action="edit-txn" data-id="${esc(t.id)}">Edit</button></div>`).join('')}
          ${txns.length > 8 ? `<button class="linkbtn" data-action="quest-funds" data-id="${esc(q.id)}">See all ${txns.length} in Funds</button>` : ''}</div>` : ''}
      </div>
      <div class="addrow">
        <button class="btn primary" data-action="pick" data-mode="photo" data-qid="${esc(q.id)}">Take photo</button>
        <button class="btn primary" data-action="pick" data-mode="video" data-qid="${esc(q.id)}">Record video</button>
        <button class="btn" data-action="pick" data-mode="gallery" data-qid="${esc(q.id)}">From gallery</button>
        <button class="btn" data-action="quest-note" data-id="${esc(q.id)}">Write note</button>
      </div>
    </section>
    ${feed.length ? masonry('quest-' + q.id, feed) : '<p class="emptyline" style="margin-top:18px">Nothing here yet. Add a photo, a video or a note and it shows up on this board, newest first.</p>'}`;
}

const byDateDesc = f => (a, b) => (String(b[f]).localeCompare(String(a[f]))) || String(b.created_at).localeCompare(String(a.created_at));

function diaryFeed() {
  const q = ui.diaryQuery.trim().toLowerCase();
  const list = state.entries
    .filter(e => !ui.diaryQuest || e.quest_id === ui.diaryQuest)
    .filter(e => !q || String(e.body).toLowerCase().includes(q))
    .sort((a, b) => entryTs(b) - entryTs(a));
  if (!list.length) return '<p class="emptyline">No entries found. Write your first one above.</p>';
  return masonry('diary', list.map(e => entryCard(e, true)));
}

function viewDiary() {
  return `${header('Diary')}
    <form class="card composer" data-form="draft">
      <textarea name="body" data-draft placeholder="What happened today? Wins, problems, ideas, what you learned...">${esc(ui.draft.body)}</textarea>
      <div class="row">
        <select name="quest_id" data-draftquest class="grow">${questOptions(ui.draft.quest_id, true, 'General (no quest)')}</select>
        <input type="date" name="entry_date" value="${todayStr()}" required>
        <button class="btn primary" type="submit">Save entry</button>
      </div>
    </form>
    <div class="toolbar">
      <select data-filter="diaryQuest"><option value="">All quests</option>${questOptions(ui.diaryQuest, false)}</select>
      <input type="text" data-search="diary" placeholder="Search entries..." value="${esc(ui.diaryQuery)}" style="flex:1;min-width:140px">
    </div>
    <div id="diary-list">${diaryFeed()}</div>`;
}

function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function chartHtml() {
  const d = new Date();
  const data = [];
  for (let i = 5; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    data.push({ k: `${x.getFullYear()}-${pad(x.getMonth() + 1)}`, label: x.toLocaleDateString('en-ZA', { month: 'short' }), in: 0, out: 0 });
  }
  for (const t of state.txns) {
    const m = data.find(x => x.k === String(t.txn_date).slice(0, 7));
    if (m) m[t.kind] += Number(t.amount) || 0;
  }
  if (!data.some(m => m.in || m.out)) return '<p class="emptyline">Log some money in or out and the monthly chart appears here.</p>';
  const max = niceMax(Math.max(1, ...data.flatMap(m => [m.in, m.out])));
  const W = 360, H = 200, L = 38, R = 6, T = 10, B = 26;
  const pw = W - L - R, ph = H - T - B, gw = pw / data.length, bw = Math.min(16, gw / 2 - 4);
  const y = v => T + ph - (v / max) * ph;
  let g = '';
  for (const f of [0, .5, 1]) {
    const yy = y(max * f);
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text x="${L - 6}" y="${yy + 3}" text-anchor="end">${compact(max * f)}</text>`;
  }
  data.forEach((m, i) => {
    const cx = L + gw * i + gw / 2;
    const hi = (m.in / max) * ph, ho = (m.out / max) * ph;
    g += `<rect class="bin" x="${cx - bw - 1}" y="${T + ph - hi}" width="${bw}" height="${hi}" rx="3"><title>${esc(m.label)} in: ${money(m.in)}</title></rect>`;
    g += `<rect class="bout" x="${cx + 1}" y="${T + ph - ho}" width="${bw}" height="${ho}" rx="3"><title>${esc(m.label)} out: ${money(m.out)}</title></rect>`;
    g += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${esc(m.label)}</text>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Money in and out per month">${g}</svg>
    <div class="legend"><span><i style="background:var(--in)"></i>Money in</span><span><i style="background:var(--out)"></i>Money out</span></div>`;
}

function viewFunds() {
  const inn = sumTx(state.txns, 'in'), out = sumTx(state.txns, 'out');
  const rows = state.quests.map(q => ({ q, s: questStats(q.id) })).filter(x => x.s.inn || x.s.out || x.q.goal);
  const general = state.txns.filter(t => !t.quest_id || !questById(t.quest_id));
  const gIn = sumTx(general, 'in'), gOut = sumTx(general, 'out');

  const list = state.txns
    .filter(t => !ui.fundsQuest || (ui.fundsQuest === '_general' ? !questById(t.quest_id) : t.quest_id === ui.fundsQuest))
    .filter(t => !ui.fundsKind || t.kind === ui.fundsKind)
    .sort(byDateDesc('txn_date'));
  const shown = list.slice(0, ui.fundsLimit);

  return `${header('Funds', '<button class="btn" data-action="open-import">Import CSV</button><button class="btn primary" data-action="new-txn">+ Add money</button>')}
    <section class="kpis">
      <div class="kpi"><div class="lbl">Money in</div><div class="val pos">${money(inn)}</div></div>
      <div class="kpi"><div class="lbl">Money out</div><div class="val neg">${money(out)}</div></div>
      <div class="kpi"><div class="lbl">Net</div><div class="val ${inn - out < 0 ? 'neg' : ''}">${money(inn - out)}</div></div>
      <div class="kpi"><div class="lbl">Transactions</div><div class="val">${state.txns.length}</div></div>
    </section>
    <section class="card" style="margin-top:16px"><h2>Money in vs out <span class="muted small">last 6 months</span></h2>${chartHtml()}</section>
    <section class="card" style="margin-top:16px"><h2>By quest</h2>
      ${(rows.length || general.length) ? `<div class="tablewrap"><table>
        <thead><tr><th>Quest</th><th class="num">In</th><th class="num">Out</th><th class="num">Net</th><th style="min-width:130px">Goal</th></tr></thead>
        <tbody>
          ${rows.map(({ q, s }) => { const g = goalProgress(q); return `<tr>
            <td><button class="qname" data-action="open-quest" data-id="${esc(q.id)}">${esc(q.name)}</button> ${typeBadge(q.type)}</td>
            <td class="num pos">${money(s.inn)}</td><td class="num neg">${money(s.out)}</td>
            <td class="num ${s.net < 0 ? 'neg' : ''}">${money(s.net)}</td>
            <td>${g ? `${goalBar(q)}<div class="muted small">${g.raw.toFixed(0)}% ${g.label}</div>` : '<span class="muted small">-</span>'}</td></tr>`; }).join('')}
          ${general.length ? `<tr><td><span class="muted">General (no quest)</span></td><td class="num pos">${money(gIn)}</td><td class="num neg">${money(gOut)}</td><td class="num ${gIn - gOut < 0 ? 'neg' : ''}">${money(gIn - gOut)}</td><td></td></tr>` : ''}
        </tbody></table></div>` : '<p class="emptyline">Add a transaction to see money per quest.</p>'}
    </section>
    <div class="toolbar">
      <select data-filter="fundsQuest"><option value="">All quests</option><option value="_general"${ui.fundsQuest === '_general' ? ' selected' : ''}>General (no quest)</option>${questOptions(ui.fundsQuest, false)}</select>
      <select data-filter="fundsKind"><option value="">In and out</option><option value="in"${ui.fundsKind === 'in' ? ' selected' : ''}>Money in</option><option value="out"${ui.fundsKind === 'out' ? ' selected' : ''}>Money out</option></select>
    </div>
    <section class="card">
      ${shown.length ? shown.map(t => `
        <div class="txn">
          <span class="date muted small">${fmtShort(t.txn_date)}</span>
          <div class="what"><div>${esc(t.note) || '<span class="muted">No note</span>'}</div>${questTag(t.quest_id)}</div>
          <span class="amt ${t.kind === 'in' ? 'pos' : 'neg'}">${t.kind === 'in' ? '+' : '-'}${money(t.amount)}</span>
          <span class="acts"><button class="btn sm ghost" data-action="edit-txn" data-id="${esc(t.id)}">Edit</button><button class="btn sm ghost danger" data-action="del-txn" data-id="${esc(t.id)}">Delete</button></span>
        </div>`).join('') : '<p class="emptyline">No transactions yet.</p>'}
      ${list.length > shown.length ? `<div class="row"><button class="btn" data-action="more-txns">Show more (${list.length - shown.length} left)</button></div>` : ''}
    </section>`;
}

const views = { home: viewHome, quest: viewQuest, diary: viewDiary, funds: viewFunds };

function render() {
  const navView = ui.view === 'quest' ? 'home' : ui.view;
  $$('.navbtn[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === navView));
  $('#main').innerHTML = (views[ui.view] || viewHome)();
  fillMasonry();
  renderSync();
}

/* ---------- modal ---------- */
function openModal(html, wide = false, cls = '') {
  const m = $('#modal');
  m.className = (wide ? 'wide ' : '') + cls;
  m.innerHTML = `<div class="mbody">${html}</div>`;
  if (!m.open) m.showModal();
}
function closeModal() {
  const m = $('#modal');
  if (m.open) m.close();
  m.innerHTML = '';
  ui.viewer = null;
}

function questModal(id) {
  const q = id ? questById(id) : null;
  openModal(`<h2>${q ? 'Edit quest' : 'New quest'}</h2>
    <form data-form="quest">
      <input type="hidden" name="id" value="${esc(q ? q.id : '')}">
      <label class="f"><span>Name</span><input type="text" name="name" required maxlength="80" value="${esc(q ? q.name : '')}" placeholder="e.g. Website for a barber shop" autofocus></label>
      <div class="twocol">
        <label class="f"><span>Type</span><select name="type">
          <option value="income"${q && q.type === 'income' ? ' selected' : ''}>Income (makes money)</option>
          <option value="personal"${q && q.type === 'personal' ? ' selected' : ''}>Personal (costs money)</option></select></label>
        <label class="f"><span>Status</span><select name="status">${STATUSES.map(([v, l]) => `<option value="${v}"${(q ? q.status : 'idea') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <label class="f"><span>Goal in rand (income target, or budget for personal)</span><input type="number" name="goal" min="0" step="0.01" inputmode="decimal" value="${q && q.goal ? esc(q.goal) : ''}" placeholder="Optional"></label>
      <label class="f"><span>Description</span><textarea name="description" rows="4" placeholder="What is this quest about?">${esc(q ? q.description : '')}</textarea></label>
      <div class="mfoot">
        ${q ? '<button type="button" class="btn danger left" data-action="del-quest" data-id="' + esc(q.id) + '">Delete</button>' : ''}
        <button type="button" class="btn" data-action="close-modal">Cancel</button>
        <button type="submit" class="btn primary">Save</button>
      </div>
    </form>`);
}

function txnModal(id, questId = '') {
  const t = id ? state.txns.find(x => x.id === id) : null;
  const kind = t ? t.kind : 'in';
  openModal(`<h2>${t ? 'Edit transaction' : 'Add money'}</h2>
    <form data-form="txn">
      <input type="hidden" name="id" value="${esc(t ? t.id : '')}">
      <div class="seg">
        <label><input type="radio" name="kind" value="in"${kind === 'in' ? ' checked' : ''}>Money in</label>
        <label><input type="radio" name="kind" value="out"${kind === 'out' ? ' checked' : ''}>Money out</label>
      </div>
      <div class="twocol">
        <label class="f"><span>Amount (R)</span><input type="number" name="amount" min="0.01" step="0.01" inputmode="decimal" required value="${t ? esc(t.amount) : ''}" autofocus></label>
        <label class="f"><span>Date</span><input type="date" name="txn_date" required value="${esc(t ? t.txn_date : todayStr())}"></label>
      </div>
      <label class="f"><span>Quest</span><select name="quest_id">${questOptions(t ? t.quest_id : questId)}</select></label>
      <label class="f"><span>Note</span><input type="text" name="note" maxlength="200" value="${esc(t ? t.note : '')}" placeholder="e.g. Client deposit, domain, materials"></label>
      <div class="mfoot">${t ? `<button type="button" class="btn danger left" data-action="del-txn" data-id="${esc(t.id)}">Delete</button>` : ''}<button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </form>`);
}

function entryModal(id, questId = '') {
  const e = id ? state.entries.find(x => x.id === id) : null;
  openModal(`<h2>${e ? 'Edit entry' : 'New diary entry'}</h2>
    <form data-form="entry">
      <input type="hidden" name="id" value="${esc(e ? e.id : '')}">
      <div class="twocol">
        <label class="f"><span>Quest</span><select name="quest_id">${questOptions(e ? e.quest_id : questId)}</select></label>
        <label class="f"><span>Date</span><input type="date" name="entry_date" required value="${esc(e ? e.entry_date : todayStr())}"></label>
      </div>
      <label class="f"><span>Entry</span><textarea name="body" rows="8" required autofocus>${esc(e ? e.body : '')}</textarea></label>
      <div class="mfoot"><button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </form>`);
}

function readEntryModal(id) {
  const e = state.entries.find(x => x.id === id);
  if (!e) return;
  openModal(`<div class="edate" style="margin-bottom:10px">${fmtDate(e.entry_date)} ${questTag(e.quest_id)}</div>
    <div class="reader">${esc(e.body)}</div>
    <div class="mfoot"><button class="btn danger left" data-action="del-entry" data-id="${esc(e.id)}">Delete</button><button class="btn" data-action="edit-entry" data-id="${esc(e.id)}">Edit</button><button class="btn primary" data-action="close-modal">Close</button></div>`);
}

function quickAddModal() {
  if (!state.quests.length) { questModal(); return; }
  const current = ui.view === 'quest' ? ui.questId : '';
  openModal(`<h2>Quick add</h2>
    <label class="f"><span>Which quest?</span><select data-qaquest>${questOptions(current || state.quests.slice().sort((a, b) => lastActivity(b) - lastActivity(a))[0].id, false)}</select></label>
    <div class="qagrid">
      <button class="btn primary" data-action="pick" data-mode="photo">Take photo</button>
      <button class="btn primary" data-action="pick" data-mode="video">Record video</button>
      <button class="btn" data-action="pick" data-mode="gallery">From gallery</button>
      <button class="btn" data-action="quest-note">Write note</button>
      <button class="btn" data-action="quest-money">Add money</button>
    </div>
    <div class="mfoot"><button class="btn" data-action="close-modal">Cancel</button></div>`);
}

function viewerList(m) { return questMedia(m.quest_id); }
function viewerHtml() {
  const m = state.media.find(x => x.id === ui.viewer.id);
  if (!m) return '<p>This item is gone.</p>';
  const list = viewerList(m);
  const i = list.findIndex(x => x.id === m.id);
  return `<div class="viewer">
    <div class="vstage">
      ${m.kind === 'video'
        ? `<video controls playsinline preload="metadata" data-mid="${esc(m.id)}" data-now="1"></video>`
        : `<img alt="" data-mid="${esc(m.id)}" data-which="main" data-now="1">`}
      <button class="vnav prev" data-action="viewer-nav" data-dir="-1" aria-label="Newer"${i <= 0 ? ' disabled' : ''}>&lsaquo;</button>
      <button class="vnav next" data-action="viewer-nav" data-dir="1" aria-label="Older"${i >= list.length - 1 ? ' disabled' : ''}>&rsaquo;</button>
    </div>
    <div class="vmeta">
      <input type="text" data-caption="${esc(m.id)}" maxlength="300" placeholder="Add a caption" value="${esc(m.caption)}">
      <div class="muted small" style="margin-top:6px">${fmtTs(ts(m.taken_at))} · ${questTag(m.quest_id)} · ${i + 1} of ${list.length}${m.size ? ' · ' + fmtSize(m.size) : ''}</div>
      <div class="mfoot"><button class="btn danger left" data-action="del-media" data-id="${esc(m.id)}">Delete</button><button class="btn primary" data-action="close-modal">Close</button></div>
    </div></div>`;
}
function openViewer(id) {
  ui.viewer = { id };
  openModal(viewerHtml(), true, 'vm');
  hydrate();
}

function usageInfo() {
  const bytes = state.media.reduce((a, m) => a + (Number(m.size) || 0), 0);
  return { n: state.media.length, bytes };
}

function settingsModal() {
  let account;
  if (!sb) {
    account = `<div class="note">Sync is not set up, so everything (including photos and videos) is saved on this device only. To sync your phone and PC for free, add your Supabase URL and key to <b>config.js</b> (steps are in the README).</div>`;
  } else if (session) {
    account = `<p>Signed in as <b>${esc(session.user.email)}</b>. Status: <b>${esc({ local: 'idle', syncing: 'syncing...', synced: 'synced', error: 'problem (will retry)' }[syncStatus])}</b>.</p>
      <div class="row"><button class="btn" data-action="sync-now">Sync now</button><button class="btn" data-action="sign-out">Sign out</button></div>`;
  } else {
    account = `<p class="muted">Not signed in. Your data is saved on this device. Sign in to sync it between your phone and PC.</p>
      <div class="row"><button class="btn primary" data-action="open-auth">Sign in or create account</button></div>`;
  }
  const u = usageInfo();
  openModal(`<h2>Settings</h2>
    <div class="sect" style="border:0;padding:0;margin:0"><h3>Appearance</h3>
      <p class="muted small">Paper is the light look, CRT is dark. Auto follows your device.</p>
      <div class="chips" style="margin:10px 0 0">${[['auto', 'Auto'], ['light', 'Paper'], ['dark', 'CRT']].map(([v, l]) => `<button class="chip${getTheme() === v ? ' on' : ''}" data-action="set-theme" data-t="${v}">${l}</button>`).join('')}</div></div>
    <div class="sect"><h3>Sync</h3>${account}</div>
    <div class="sect"><h3>Photos and videos</h3>
      <p class="muted small">${u.n} item${u.n === 1 ? '' : 's'}, about ${fmtSize(u.bytes)}. The free cloud plan holds about 1 GB, and each video can be up to 50 MB. Photos are shrunk automatically to save space.</p>
      <div class="bar" style="margin-top:8px"><i style="width:${clamp(u.bytes / 1e9 * 100, 0, 100).toFixed(1)}%"></i></div></div>
    <div class="sect"><h3>Backup</h3>
      <p class="muted small">Download your quests, notes and money as a file, or restore from one. Photos and videos are not inside the file; they are kept on this device and in your synced cloud storage.</p>
      <div class="row"><button class="btn" data-action="export-json">Download backup</button><button class="btn" data-action="import-json-pick">Restore backup</button>
      <input type="file" accept="application/json,.json" data-file="json" hidden></div></div>
    <div class="sect"><h3>This device</h3>
      <p class="muted small">Removes the copy stored in this browser, including photos and videos${sb && session ? '. Anything already synced stays in the cloud and comes back on the next sync' : '. This cannot be undone'}.</p>
      <div class="row"><button class="btn danger" data-action="clear-local">Clear data on this device</button></div></div>
    <div class="mfoot"><button class="btn primary" data-action="close-modal">Done</button></div>`);
}

function authModal(msg = '', isErr = false) {
  openModal(`<h2>Sign in to sync</h2>
    ${msg ? `<div class="note${isErr ? ' err' : ''}">${esc(msg)}</div>` : ''}
    <form data-form="auth">
      <label class="f"><span>Email</span><input type="email" name="email" required autocomplete="email" autofocus></label>
      <label class="f"><span>Password (at least 6 characters)</span><input type="password" name="password" required minlength="6" autocomplete="current-password"></label>
      <div class="mfoot">
        <button type="button" class="btn" data-action="close-modal">Cancel</button>
        <button type="submit" class="btn" name="mode" value="up">Create account</button>
        <button type="submit" class="btn primary" name="mode" value="in">Sign in</button>
      </div>
    </form>`);
}

/* ---------- CSV import ---------- */
const imp = { raw: [], headers: [], body: [], hasHeader: true, map: { date: -1, desc: -1, amount: -1, debit: -1, credit: -1 }, items: [], bad: 0 };

function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const counts = [[',', (first.match(/,/g) || []).length], [';', (first.match(/;/g) || []).length], ['\t', (first.match(/\t/g) || []).length]].sort((a, b) => b[1] - a[1]);
  const delim = counts[0][1] > 0 ? counts[0][0] : ',';
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; rows.push(row); row = []; }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== '')).map(r => r.map(c => c.trim()));
}
function ymd(y, m, d) { if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null; return `${y}-${pad(m)}-${pad(d)}`; }
function parseDate(s) {
  s = String(s || '').trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/))) return ymd(+m[3], +m[2], +m[1]); // dd/mm/yyyy
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return ymd(+m[1], +m[2], +m[3]);
  if (/[a-z]/i.test(s)) { const d = new Date(s); if (!isNaN(d)) return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
  return null;
}
function parseAmount(s) {
  s = String(s ?? '').trim();
  if (!s) return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/(^[-−]|[-−]$)/.test(s)) neg = true;
  if (/\bDR\b/i.test(s)) neg = true;
  s = s.replace(/[^\d.,]/g, '');
  if (!s) return NaN;
  const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
  if (lc >= 0 && ld >= 0) s = lc > ld ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (lc >= 0) s = (/,\d{1,2}$/.test(s) && s.indexOf(',') === lc) ? s.replace(',', '.') : s.replace(/,/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? NaN : (neg ? -n : n);
}
const keyOf = (date, kind, amount, note) => `${date}|${kind}|${Number(amount).toFixed(2)}|${String(note || '').trim().toLowerCase()}`;

function autoMap() {
  const H = imp.headers.map(h => String(h).toLowerCase());
  const find = (re, skip = []) => H.findIndex((h, i) => re.test(h) && !skip.includes(i));
  const m = { date: find(/date/), desc: -1, amount: -1, debit: find(/debit|money out|paid out|withdraw/), credit: find(/credit|money in|paid in|deposit/) };
  m.amount = find(/amount|value|^amt/, [m.debit, m.credit]);
  m.desc = find(/desc|detail|narrat|reference|memo|payee|particulars|note/);
  const cols = imp.headers.length;
  const rows = imp.body.slice(0, 50);
  if (m.date < 0) {
    let best = 0;
    for (let c = 0; c < cols; c++) { const n = rows.filter(r => parseDate(r[c])).length; if (n > best) { best = n; m.date = c; } }
  }
  if (m.amount < 0 && m.debit < 0 && m.credit < 0) {
    let best = 0;
    for (let c = 0; c < cols; c++) {
      if (c === m.date) continue;
      const n = rows.filter(r => !isNaN(parseAmount(r[c])) && /\d/.test(r[c])).length;
      if (n >= best && n > 0) { best = n; m.amount = c; }
    }
  }
  if (m.desc < 0) {
    let best = -1;
    for (let c = 0; c < cols; c++) {
      if ([m.date, m.amount, m.debit, m.credit].includes(c)) continue;
      const len = rows.reduce((a, r) => a + String(r[c] || '').length, 0);
      if (len > best) { best = len; m.desc = c; }
    }
  }
  imp.map = m;
}

function buildItems() {
  const { body, map } = imp;
  const seen = new Set(state.txns.map(t => keyOf(t.txn_date, t.kind, t.amount, t.note)));
  const items = [];
  let bad = 0;
  for (const r of body) {
    const date = map.date >= 0 ? parseDate(r[map.date]) : null;
    let amt = NaN;
    if (map.debit >= 0 || map.credit >= 0) {
      const d = map.debit >= 0 ? parseAmount(r[map.debit]) : NaN;
      const c = map.credit >= 0 ? parseAmount(r[map.credit]) : NaN;
      if (!isNaN(c) && c !== 0) amt = Math.abs(c);
      else if (!isNaN(d) && d !== 0) amt = -Math.abs(d);
    } else if (map.amount >= 0) amt = parseAmount(r[map.amount]);
    if (!date || isNaN(amt) || amt === 0) { bad++; continue; }
    const note = ((map.desc >= 0 ? r[map.desc] : '') || '').slice(0, 200);
    const it = { date, note, kind: amt > 0 ? 'in' : 'out', amount: Math.round(Math.abs(amt) * 100) / 100, quest_id: '', include: true };
    it.dup = seen.has(keyOf(it.date, it.kind, it.amount, it.note));
    if (it.dup) it.include = false;
    items.push(it);
  }
  imp.items = items;
  imp.bad = bad;
}

function importSummary() {
  const n = imp.items.filter(i => i.include).length;
  const dups = imp.items.filter(i => i.dup).length;
  return `<b>${n}</b> row${n === 1 ? '' : 's'} will be imported` + (dups ? `, ${dups} look like duplicates (unticked)` : '') + (imp.bad ? `, ${imp.bad} unreadable row${imp.bad === 1 ? '' : 's'} skipped` : '') + '.';
}

function importHtml() {
  if (!imp.raw.length) {
    return `<h2>Import bank statement (CSV)</h2>
      <div class="note">Export a statement as CSV from your banking app or website, then pick the file here. It is read on your device only. Positive amounts become money in, negative become money out.</div>
      <input type="file" accept=".csv,.txt,text/csv" data-file="csv">
      <div class="mfoot"><button class="btn" data-action="close-modal">Cancel</button></div>`;
  }
  const colOpts = sel => `<option value="-1">- none -</option>` + imp.headers.map((h, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${esc(h || 'Column ' + (i + 1))}</option>`).join('');
  const shown = imp.items.slice(0, 300);
  return `<h2>Import bank statement (CSV)</h2>
    <p class="muted small">Check the columns were matched correctly. Use either one Amount column, or separate Debit and Credit columns.</p>
    <div class="twocol" style="margin-top:10px">
      <label class="f"><span>Date column</span><select data-map="date">${colOpts(imp.map.date)}</select></label>
      <label class="f"><span>Description column</span><select data-map="desc">${colOpts(imp.map.desc)}</select></label>
      <label class="f"><span>Amount column</span><select data-map="amount">${colOpts(imp.map.amount)}</select></label>
      <label class="f"><span>Assign every row to</span><select data-assignall>${'<option value="">General (no quest)</option>' + questOptions('', false)}</select></label>
      <label class="f"><span>Debit column (money out)</span><select data-map="debit">${colOpts(imp.map.debit)}</select></label>
      <label class="f"><span>Credit column (money in)</span><select data-map="credit">${colOpts(imp.map.credit)}</select></label>
    </div>
    <div class="preview"><table>
      <thead><tr><th></th><th>Date</th><th>Description</th><th class="num">Amount</th><th>Quest</th></tr></thead>
      <tbody>${shown.map((it, i) => `<tr class="${it.dup ? 'dup' : ''}">
        <td><input type="checkbox" data-rinc="${i}"${it.include ? ' checked' : ''} aria-label="Include row"></td>
        <td>${fmtShort(it.date)}</td><td>${esc(it.note) || '<span class="muted">-</span>'}${it.dup ? ' <span class="muted small">(duplicate?)</span>' : ''}</td>
        <td class="num ${it.kind === 'in' ? 'pos' : 'neg'}">${it.kind === 'in' ? '+' : '-'}${money(it.amount)}</td>
        <td><select data-rq="${i}"><option value="">General</option>${questOptions(it.quest_id, false)}</select></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No readable rows. Try changing the column choices above.</td></tr>'}</tbody></table></div>
    ${imp.items.length > shown.length ? `<p class="muted small">Showing the first ${shown.length} rows; all ticked rows are imported.</p>` : ''}
    <p id="imp-sum" class="small" style="margin-top:10px">${importSummary()}</p>
    <div class="mfoot"><button class="btn left" data-action="import-reset">Choose another file</button><button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" data-action="import-go">Import</button></div>`;
}

function openImport() { imp.raw = []; imp.items = []; openModal(importHtml(), true); }
function refreshImport() { openModal(importHtml(), true); }

function loadCSVText(text) {
  const raw = parseCSV(text);
  if (raw.length < 1) { toast('That file looks empty'); return; }
  imp.raw = raw;
  imp.hasHeader = !raw[0].some(c => parseDate(c));
  imp.headers = imp.hasHeader ? raw[0] : raw[0].map((_, i) => 'Column ' + (i + 1));
  imp.body = imp.hasHeader ? raw.slice(1) : raw;
  autoMap();
  buildItems();
  refreshImport();
}

/* ---------- backup (details only; media lives in storage) ---------- */
const BACKUP_KEYS = ['quests', 'entries', 'txns'];
function exportJSON() {
  const data = { app: 'questlog', version: 2, exported_at: now(), quests: state.quests.map(clean), entries: state.entries.map(clean), txns: state.txns.map(clean) };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `questlog-backup-${todayStr()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function importJSON(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { toast('That is not a valid backup file'); return; }
  if (!data || data.app !== 'questlog') { toast('That does not look like a Questlog backup'); return; }
  let added = 0;
  for (const k of BACKUP_KEYS) {
    for (const r of (data[k] || [])) {
      if (!r || !r.id) continue;
      const cur = state[k].find(x => x.id === r.id);
      if (!cur) { state[k].push({ ...clean(r), _s: false }); added++; }
      else if (new Date(r.updated_at || 0) > new Date(cur.updated_at || 0)) { state[k][state[k].indexOf(cur)] = { ...clean(r), _s: false }; added++; }
    }
  }
  saveLocal(); syncSoon(); render();
  toast(`Restored ${added} item${added === 1 ? '' : 's'}`);
}

/* ---------- form handlers ---------- */
const num = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
const formHandlers = {
  quest(f) {
    const old = f.id ? questById(f.id) : null;
    const goal = num(f.goal);
    const row = put('quests', {
      ...(old || { id: uid(), created_at: now() }),
      name: String(f.name).trim(),
      type: f.type === 'personal' ? 'personal' : 'income',
      status: STATUSES.some(s => s[0] === f.status) ? f.status : 'idea',
      goal: goal && goal > 0 ? goal : null,
      description: String(f.description || '').trim(),
    });
    closeModal(); render(); toast('Quest saved');
    return row;
  },
  txn(f) {
    const amount = num(f.amount);
    if (!(amount > 0)) { toast('Enter an amount above zero'); return; }
    const old = f.id ? state.txns.find(t => t.id === f.id) : null;
    put('txns', {
      ...(old || { id: uid(), created_at: now() }),
      quest_id: f.quest_id || null,
      kind: f.kind === 'out' ? 'out' : 'in',
      amount: Math.round(amount * 100) / 100,
      note: String(f.note || '').trim(),
      txn_date: f.txn_date || todayStr(),
    });
    closeModal(); render(); toast('Saved');
  },
  entry(f) {
    const old = f.id ? state.entries.find(e => e.id === f.id) : null;
    put('entries', {
      ...(old || { id: uid(), created_at: now() }),
      quest_id: f.quest_id || null,
      entry_date: f.entry_date || todayStr(),
      body: String(f.body || '').trim(),
    });
    closeModal(); render(); toast('Entry saved');
  },
  draft(f) {
    const body = String(f.body || '').trim();
    if (!body) { toast('Write something first'); return; }
    put('entries', { id: uid(), created_at: now(), quest_id: f.quest_id || null, entry_date: f.entry_date || todayStr(), body });
    ui.draft.body = '';
    render(); toast('Entry saved');
  },
  async auth(f, form, submitter) {
    const mode = submitter && submitter.value === 'up' ? 'up' : 'in';
    try {
      if (mode === 'up') {
        const { data, error } = await sb.auth.signUp({ email: f.email, password: f.password });
        if (error) throw error;
        if (!data.session) { authModal('Account created. Check your email for a confirmation link, then sign in here.'); return; }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email: f.email, password: f.password });
        if (error) throw error;
      }
      closeModal(); toast('Signed in');
    } catch (e) { authModal(e.message || 'Could not sign in', true); }
  },
};

/* ---------- navigation ---------- */
function openQuest(id) {
  ui.view = 'quest'; ui.questId = id; ui.descOpen = false; ui.showTxns = false;
  try { history.pushState({ ql: 'quest' }, ''); } catch (e) { /* ignore */ }
  render(); window.scrollTo(0, 0);
}
function goHome() {
  if (history.state && history.state.ql === 'quest') { history.back(); return; }
  ui.view = 'home'; ui.questId = null; render(); window.scrollTo(0, 0);
}
window.addEventListener('popstate', () => { if (ui.view === 'quest') { ui.view = 'home'; ui.questId = null; render(); } });

const qaQuest = el => (el && el.dataset.qid) || ($('#modal [data-qaquest]') || {}).value || (ui.view === 'quest' ? ui.questId : '');

/* ---------- actions ---------- */
const actions = {
  nav(el) {
    if (history.state && history.state.ql) { try { history.replaceState(null, ''); } catch (e) { /* ignore */ } }
    ui.view = el.dataset.view; ui.questId = null; render(); window.scrollTo(0, 0);
  },
  'open-quest'(el) { closeModalIfOpen(); openQuest(el.dataset.id); },
  'back-home'() { goHome(); },
  'new-quest'() { questModal(); },
  'edit-quest'(el) { questModal(el.dataset.id); },
  'del-quest'(el) {
    const q = questById(el.dataset.id);
    const n = state.media.filter(m => m.quest_id === q.id).length;
    if (q && confirm(`Delete "${q.name}"?${n ? ` Its ${n} photo${n === 1 ? '' : 's'}/video${n === 1 ? '' : 's'} will be deleted too.` : ''} Diary notes and money are kept but become unassigned.`)) {
      remove('quests', q.id); closeModal();
      ui.view = 'home'; ui.questId = null; render(); toast('Quest deleted');
    }
  },
  'toggle-theme'() { setTheme(isDark() ? 'light' : 'dark'); },
  'set-theme'(el) { setTheme(el.dataset.t); settingsModal(); },
  'dismiss-warn'() { ui.hideWarn = true; render(); },
  'toggle-desc'() { ui.descOpen = !ui.descOpen; render(); },
  'toggle-txns'() { ui.showTxns = !ui.showTxns; render(); },
  'toggle-bars'() { ui.allBars = !ui.allBars; render(); },
  'status-filter'(el) { ui.statusFilter = el.dataset.status; render(); },
  'quick-add'() { quickAddModal(); },
  pick(el) {
    const qid = qaQuest(el);
    if (!qid) { toast('Pick a quest first'); return; }
    pickFiles(el.dataset.mode, qid);
    closeModalIfOpen();
  },
  'quest-note'(el) { const id = el.dataset.id || qaQuest(el); closeModalIfOpen(); entryModal('', id); },
  'quest-money'(el) { const id = el.dataset.id || qaQuest(el); closeModalIfOpen(); txnModal('', id); },
  'quest-funds'(el) { ui.fundsQuest = el.dataset.id; ui.view = 'funds'; render(); window.scrollTo(0, 0); },
  'open-media'(el) { openViewer(el.dataset.id); },
  'viewer-nav'(el) {
    const m = state.media.find(x => x.id === ui.viewer.id); if (!m) return;
    const list = viewerList(m), i = list.findIndex(x => x.id === m.id) + Number(el.dataset.dir);
    if (i < 0 || i >= list.length) return;
    openViewer(list[i].id);
  },
  'del-media'(el) {
    if (!confirm('Delete this photo/video?')) return;
    const m = state.media.find(x => x.id === el.dataset.id);
    const list = m ? viewerList(m) : [];
    const i = list.findIndex(x => x.id === el.dataset.id);
    remove('media', el.dataset.id);
    render();
    const next = list[i + 1] || list[i - 1];
    if (next) openViewer(next.id); else closeModal();
    toast('Deleted');
  },
  'read-entry'(el) { readEntryModal(el.dataset.id); },
  'edit-entry'(el) { entryModal(el.dataset.id); },
  'del-entry'(el) { if (confirm('Delete this diary entry?')) { remove('entries', el.dataset.id); closeModal(); render(); } },
  'new-entry'() { entryModal(); },
  'new-txn'() { txnModal(); },
  'edit-txn'(el) { txnModal(el.dataset.id); },
  'del-txn'(el) { if (confirm('Delete this transaction?')) { remove('txns', el.dataset.id); closeModal(); render(); } },
  'more-txns'() { ui.fundsLimit += 200; render(); },
  'open-import'() { openImport(); },
  'import-reset'() { openImport(); },
  'import-go'() {
    const rows = imp.items.filter(i => i.include);
    if (!rows.length) { toast('Nothing ticked to import'); return; }
    for (const it of rows) {
      state.txns.push({ id: uid(), created_at: now(), updated_at: now(), _s: false, quest_id: it.quest_id || null, kind: it.kind, amount: it.amount, note: it.note, txn_date: it.date });
    }
    saveLocal(); syncSoon(); closeModal(); render();
    toast(`Imported ${rows.length} transaction${rows.length === 1 ? '' : 's'}`);
  },
  'open-settings'() { settingsModal(); },
  'open-auth'() { authModal(); },
  'close-modal'() { closeModal(); },
  'sign-out'() {
    if (!confirm('Sign out? Your data stays on this device and in the cloud.')) return;
    sb.auth.signOut().then(() => { closeModal(); toast('Signed out'); });
  },
  'sync-now'() { sync(); },
  'export-json'() { exportJSON(); },
  'import-json-pick'() { const i = $('#modal [data-file="json"]'); if (i) i.click(); },
  'clear-local'() {
    if (!confirm('Clear all data stored on this device, including photos and videos?')) return;
    for (const m of state.media) freeUrls(m.id);
    state = { quests: [], media: [], entries: [], txns: [], pendingDeletes: [] };
    idb.clear();
    saveLocal(); closeModal(); ui.view = 'home'; render();
    if (sb && session) syncSoon();
  },
};
function closeModalIfOpen() { const m = $('#modal'); if (m.open) closeModal(); }

document.addEventListener('click', e => {
  const m = $('#modal');
  if (e.target === m) { closeModal(); return; }
  const el = e.target.closest('[data-action]');
  if (el && actions[el.dataset.action]) actions[el.dataset.action](el, e);
});
document.addEventListener('keydown', e => {
  const el = e.target.closest && e.target.closest('[role="button"][data-action]');
  if (el && (e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); actions[el.dataset.action](el, e); return; }
  if (ui.viewer && $('#modal').open && !/input|textarea|select/i.test(e.target.tagName)) {
    if (e.key === 'ArrowLeft') { const b = $('#modal [data-action="viewer-nav"][data-dir="-1"]'); if (b && !b.disabled) actions['viewer-nav'](b); }
    if (e.key === 'ArrowRight') { const b = $('#modal [data-action="viewer-nav"][data-dir="1"]'); if (b && !b.disabled) actions['viewer-nav'](b); }
  }
});

document.addEventListener('submit', e => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const h = formHandlers[form.dataset.form];
  if (h) h(Object.fromEntries(new FormData(form)), form, e.submitter);
});

document.addEventListener('input', e => {
  const t = e.target;
  if (t.matches('[data-draft]')) ui.draft.body = t.value;
  else if (t.matches('[data-search="diary"]')) { ui.diaryQuery = t.value; const l = $('#diary-list'); if (l) { l.innerHTML = diaryFeed(); fillMasonry(); } }
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.matches('[data-draftquest]')) ui.draft.quest_id = t.value;
  else if (t.dataset.caption !== undefined) {
    const m = state.media.find(x => x.id === t.dataset.caption);
    if (m) { put('media', { ...m, caption: t.value.trim() }); render(); }
  }
  else if (t.dataset.filter) { ui[t.dataset.filter] = t.value; if (t.dataset.filter === 'fundsQuest' || t.dataset.filter === 'fundsKind') ui.fundsLimit = 200; render(); }
  else if (t.dataset.map !== undefined) { imp.map[t.dataset.map] = Number(t.value); buildItems(); refreshImport(); }
  else if (t.hasAttribute('data-assignall')) { imp.items.forEach(i => { i.quest_id = t.value; }); refreshImport(); const s = $('#modal [data-assignall]'); if (s) s.value = t.value; }
  else if (t.dataset.rinc !== undefined) { imp.items[+t.dataset.rinc].include = t.checked; const s = $('#imp-sum'); if (s) s.innerHTML = importSummary(); }
  else if (t.dataset.rq !== undefined) { imp.items[+t.dataset.rq].quest_id = t.value; }
  else if (t.dataset.file === 'csv' && t.files[0]) { t.files[0].text().then(loadCSVText); }
  else if (t.dataset.file === 'json' && t.files[0]) { t.files[0].text().then(importJSON); }
});

window.addEventListener('online', () => syncSoon());
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncSoon(); });

/* ---------- boot ---------- */
applyTheme();
if (window.matchMedia) { try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (getTheme() === 'auto') { applyTheme(); render(); } }); } catch (e) { /* old browser */ } }
loadLocal();
render();
initAuth();
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
window.Questlog = { get state() { return state; }, ui, sync, setTheme, getTheme, addMedia, idb, parseCSV, parseDate, parseAmount, fillMasonry };
})();
