// Puntúa · capa de datos de la web y la APK.
// Guarda todo en este dispositivo y, si conectas un token de GitHub, lo sincroniza con un Gist secreto
// (igual que Clash Alerter). Ofrece a la app la misma interfaz que tenía dentro de Claude:
// use('db' | 'user' | 'assets' | 'downloads').
(function () {
  'use strict';
  const ME = 'me';
  const LEGACY = 'puntua-data';                 // datos guardados antes de tener cuenta (se suben al entrar)
  let STORE = LEGACY;
  const IN_APP = location.hostname === 'localhost' || location.protocol === 'capacitor:';
  const IMG_BASE = IN_APP ? 'https://avillar25.github.io/puntua/' : '';
  window.PUNTUA_REMOTE = IMG_BASE;   // en la APK, los datos que cambian cada semana se leen de la web

  /* ---------- Almacén local ----------
     docs.lists / docs.review: tus listas y tus notas. Cada entrada de segundo nivel lleva su hora de
     cambio en _mt["sección/id"], para juntar sin perder nada si cambias cosas en el móvil y en el PC.
     docs["titles/<id>"]: fichas que has creado o editado (con _mt); {deleted:true} oculta una del catálogo. */
  let docs = {};   // se cargan al entrar en la cuenta (cada cuenta tiene los suyos en este navegador)
  let saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE, JSON.stringify(docs)); }
      catch (e) { console.error('[Puntúa] no se pudo guardar en el dispositivo', e); }
    }, 150);
  }
  const strip = o => { if (!o || typeof o !== 'object') return o; const { _mt, ...r } = o; return r; };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Guarda un documento de dos niveles apuntando qué entradas han cambiado
  function putNested(key, body) {
    const now = Date.now(), old = docs[key] || {}, mt = { ...(old._mt || {}) };
    const oldB = strip(old), secs = new Set([...Object.keys(oldB), ...Object.keys(body || {})]);
    for (const s of secs) {
      const a = oldB[s], b = (body || {})[s];
      const isMap = v => v && typeof v === 'object' && !Array.isArray(v);
      if (isMap(a) || isMap(b)) {
        const ids = new Set([...Object.keys(isMap(a) ? a : {}), ...Object.keys(isMap(b) ? b : {})]);
        for (const id of ids) if (!same((a || {})[id], (b || {})[id])) mt[s + '/' + id] = now;
      } else if (!same(a, b)) mt[s] = now;
    }
    docs[key] = { ...(body || {}), _mt: mt };
  }
  // Junta dos versiones de un documento de dos niveles: en cada entrada gana la cambiada más tarde
  function mergeNested(a, b) {
    a = a || {}; b = b || {};
    const ma = a._mt || {}, mb = b._mt || {}, A = strip(a), B = strip(b), out = {}, mt = {};
    const isMap = v => v && typeof v === 'object' && !Array.isArray(v);
    for (const s of new Set([...Object.keys(A), ...Object.keys(B)])) {
      if (isMap(A[s]) || isMap(B[s])) {
        const sa = isMap(A[s]) ? A[s] : {}, sb = isMap(B[s]) ? B[s] : {}, o = {};
        for (const id of new Set([...Object.keys(sa), ...Object.keys(sb), ...Object.keys(ma).concat(Object.keys(mb)).filter(k => k.startsWith(s + '/')).map(k => k.slice(s.length + 1))])) {
          const k = s + '/' + id, ta = ma[k] || 0, tb = mb[k] || 0;
          const v = tb > ta ? sb[id] : (ta > tb ? sa[id] : (id in sa ? sa[id] : sb[id]));
          if (v !== undefined) o[id] = v;
          if (ta || tb) mt[k] = Math.max(ta, tb);
        }
        out[s] = o;
      } else {
        const ta = ma[s] || 0, tb = mb[s] || 0;
        out[s] = tb > ta ? B[s] : (s in A ? A[s] : B[s]);
        if (ta || tb) mt[s] = Math.max(ta, tb);
      }
    }
    out._mt = mt;
    return out;
  }

  /* ---------- Avisos a la app cuando cambian los datos ---------- */
  const subs = new Set();
  const notify = () => subs.forEach(f => { try { f(); } catch (e) { console.error(e); } });

  /* ---------- Catálogo base (del repositorio) ---------- */
  let catalogP = null, tvKick = false;
  function catalog() {
    // En la APK se intenta primero el catálogo publicado en la web (siempre al día) y si no hay conexión, el que lleva dentro
    if (!catalogP && IN_APP) catalogP = fetch(IMG_BASE + 'catalog.json', { cache: 'no-cache' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(() => fetch('catalog.json').then(r => r.json())).catch(() => ({ titles: {}, imports: [] }));
    if (!catalogP) catalogP = fetch('catalog.json', { cache: 'no-cache' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(e => { console.error('[Puntúa] no se pudo cargar catalog.json', e); catalogP = null; return { titles: {}, imports: [] }; });
    return catalogP;
  }
  const fixImg = t => (t && t.img && t.imgUrl && !/^(data:|https?:)/.test(t.imgUrl)) ? { ...t, imgUrl: IMG_BASE + t.imgUrl } : t;
  const snap = entries => ({ docs: entries.map(([id, v]) => ({ id, data: () => v })), metadata: { fromCache: false } });

  function keyOf(path) {
    const s = path.split('/');
    if (s[0] === 'data') return 'lists';
    if (s[0] === 'reviews') return 'review';
    return path; // titles/<id>
  }

  const dbApi = {
    doc(path) {
      const key = keyOf(path);
      return {
        async set(body) {
          if (key === 'lists' || key === 'review') putNested(key, body);
          else docs[key] = { ...body, _mt: Date.now() };
          persist(); notify(); syncSoon(key);
        },
        async delete() {
          if (key.startsWith('titles/')) docs[key] = { deleted: true, _mt: Date.now() };
          else delete docs[key];
          persist(); notify(); syncSoon(key);
        },
        onSnapshot(cb) {
          const f = () => { const v = docs[key]; cb({ exists: !!v, data: () => strip(v), metadata: { fromCache: false } }); };
          subs.add(f); setTimeout(f, 0);
          return () => subs.delete(f);
        },
      };
    },
    collection(path) {
      return {
        onSnapshot(cb) {
          let f;
          if (path === 'imports') f = () => catalog().then(c => cb(snap((c.imports || []).map(i => [i.id, i]))));
          else if (path === 'titles') f = () => catalog().then(c => {
            tvApplyCached();
            const m = { ...(c.titles || {}) };
            for (const [k, v] of Object.entries(docs)) if (k.startsWith('titles/')) {
              const id = k.slice(7); if (v && v.deleted) delete m[id]; else m[id] = strip(v);
            }
            cb(snap(Object.entries(m).map(([id, v]) => [id, fixImg(v)])));
            if (!tvKick) { tvKick = true; setTimeout(() => tvRefresh(m), 3000); }
            if (IN_APP) scheduleNotifsSoon(m);
          });
          else if (path === 'reviews') f = () => cb(snap(docs.review ? [[ME, strip(docs.review)]] : []));
          else f = () => cb(snap([]));
          subs.add(f); setTimeout(f, 0);
          return () => subs.delete(f);
        },
      };
    },
  };


  /* ---------- Series al día desde TVmaze ----------
     Al abrir la app (como mucho cada 12 h por serie) se consultan las series que sigues: próximos
     capítulos, temporadas y si sigue en emisión. TVmaze permite hasta 20 consultas cada 10 s. */
  const TVC = 'puntua-tvmaze';
  let tvCache = {}; try { tvCache = JSON.parse(localStorage.getItem(TVC) || '{}') || {}; } catch (e) { tvCache = {}; }
  const tvSave = () => { try { localStorage.setItem(TVC, JSON.stringify(tvCache)); } catch (e) {} };
  const dayStr = d => d.toISOString().slice(0, 10);
  function tvApply(id, c) {
    const M = window.PUNTUA_META || (window.PUNTUA_META = {});
    const S = M.series || (M.series = {});
    const o = S[id] || (S[id] = {});
    if (c.air) o.air = c.air;
    if (c.seasonEps && Object.keys(c.seasonEps).length) {
      o.seasonEps = c.seasonEps; o.seasons = Math.max(...Object.keys(c.seasonEps).map(Number)); o.epTotal = Object.values(c.seasonEps).reduce((a, b) => a + b, 0);
    }
    if (c.upEps) { if (c.upEps.length) o.upEps = c.upEps; else delete o.upEps; delete o.nextEp; }
    if (c.epRuntime && !o.epRuntime) o.epRuntime = c.epRuntime;
  }
  // Aplica lo que ya había guardado, para que se vea al momento sin esperar a TVmaze
  let tvApplied = false;
  function tvApplyCached() { if (tvApplied) return; tvApplied = true; for (const [id, c] of Object.entries(tvCache)) if (c && c.t && !c.miss) tvApply(id, c); }
  async function tvGet(url) {
    for (let i = 0; i < 3; i++) {
      const r = await fetch('https://api.tvmaze.com' + url);
      if (r.status === 429) { await new Promise(z => setTimeout(z, 4000)); continue; }
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('TVmaze ' + r.status);
      return r.json();
    }
    return null;
  }
  let tvRunning = false;
  async function tvRefresh(titles) {
    if (tvRunning || !navigator.onLine) return; tvRunning = true;
    try {
      const L = strip(docs.lists) || {}, st = L.status || {}, prog = L.prog || {};
      const M = (window.PUNTUA_META || {}).series || {};
      const want = Object.entries(titles).filter(([id, t]) => t && t.type === 'series' && st[id] !== 'abandonado' && (st[id] || prog[id]));
      const now = Date.now(), lo = dayStr(new Date(now - 45 * 864e5)), hi = dayStr(new Date(now + 120 * 864e5));
      let changed = 0;
      for (const [id, t] of want) {
        const c = tvCache[id] || {};
        if (c.t && now - c.t < 12 * 3600e3) continue;
        const imdb = t.imdb || t.imdbId || (M[id] || {}).imdb;
        try {
          let tvid = c.id;
          if (!tvid) {
            const sh = imdb ? await tvGet('/lookup/shows?imdb=' + encodeURIComponent(imdb)) : null;
            if (!sh) { tvCache[id] = { ...c, t: now, miss: 1 }; continue; }
            tvid = sh.id;
          }
          const sh = await tvGet('/shows/' + tvid + '?embed[]=episodes');
          if (!sh) { tvCache[id] = { ...c, t: now, miss: 1 }; continue; }
          const eps = ((sh._embedded || {}).episodes || []).filter(e => e.number && e.season);
          const seasonEps = {};
          for (const e of eps) seasonEps[e.season] = Math.max(seasonEps[e.season] || 0, e.number);
          const upEps = eps.filter(e => e.airdate && e.airdate >= lo && e.airdate <= hi).map(e => `${e.season}x${e.number}@${e.airdate}`);
          const rts = eps.map(e => e.runtime).filter(Boolean);
          const n = { id: tvid, t: now, air: sh.status, seasonEps, upEps, epRuntime: rts.length ? Math.round(rts.reduce((a, b) => a + b, 0) / rts.length) : null };
          tvCache[id] = n; tvApply(id, n); changed++;
          if (changed % 5 === 0) { tvSave(); notify(); }
        } catch (e) { console.warn('[Puntúa] TVmaze', id, e.message || e); }
        await new Promise(z => setTimeout(z, 700));
      }
      tvSave(); if (changed) notify();
    } finally { tvRunning = false; }
  }


  /* ---------- Avisos de capítulos nuevos en el móvil (solo en la APK) ----------
     Todas las series que sigues avisan por defecto el día que sale un capítulo (a las 10:00).
     En la ficha de cada serie se puede desactivar (lists.noNotif). Se reprograma al abrir la app. */
  function notifPlugin() {
    const C = window.Capacitor; if (!C || !C.isNativePlatform || !C.isNativePlatform()) return null;
    return (C.Plugins && C.Plugins.LocalNotifications) || (C.registerPlugin ? C.registerPlugin('LocalNotifications') : null);
  }
  const hash = str => { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0; return Math.abs(h) % 2000000000 + 1000; };
  let notifTimer = null, lastTitles = null;
  function scheduleNotifsSoon(titles) { if (titles) lastTitles = titles; clearTimeout(notifTimer); notifTimer = setTimeout(scheduleNotifs, 4000); }
  async function scheduleNotifs() {
    const LN = notifPlugin(); if (!LN || !lastTitles) return;
    try {
      let perm = await LN.checkPermissions();
      if (perm.display === 'prompt' || perm.display === 'prompt-with-rationale') perm = await LN.requestPermissions();
      if (perm.display !== 'granted') return;
      const L = strip(docs.lists) || {}, st = L.status || {}, prog = L.prog || {}, off = L.noNotif || {};
      const M = (window.PUNTUA_META || {}).series || {};
      const now = Date.now(), until = now + 30 * 864e5, list = [];
      for (const [id, t] of Object.entries(lastTitles)) {
        if (!t || t.type !== 'series' || off[id] || st[id] === 'abandonado' || !(st[id] || prog[id])) continue;
        const ups = (M[id] || {}).upEps || t.upEps || [];
        const p = prog[id];
        const byDay = {};
        for (const x of ups) {
          const [se, d] = x.split('@'); const [a, b] = se.split('x').map(Number);
          if (p && (a < p.s || (a === p.s && b <= p.e))) continue;          // ya visto
          const at = new Date(d + 'T10:00:00'); if (isNaN(at) || at.getTime() < now + 60000 || at.getTime() > until) continue;
          (byDay[d] = byDay[d] || []).push({ a, b, at });
        }
        for (const [d, eps] of Object.entries(byDay)) {           // varios el mismo día: un solo aviso
          eps.sort((x, y) => x.a - y.a || x.b - y.b);
          const code = e => `${e.a}x${String(e.b).padStart(2, '0')}`;
          list.push({ id: hash(id + '@' + d), title: t.title, at: eps[0].at,
            body: eps.length > 1 ? `Hoy salen ${eps.length} capítulos nuevos (${code(eps[0])}–${code(eps[eps.length - 1])})` : `Hoy sale el capítulo ${code(eps[0])}` });
        }
      }
      const pend = await LN.getPending();
      if (pend && pend.notifications && pend.notifications.length) await LN.cancel({ notifications: pend.notifications.map(n => ({ id: n.id })) });
      list.sort((a, b) => a.at - b.at);
      const batch = list.slice(0, 60).map(n => ({ id: n.id, title: n.title, body: n.body, schedule: { at: n.at, allowWhileIdle: true }, smallIcon: 'ic_stat_puntua' }));
      if (batch.length) await LN.schedule({ notifications: batch });
    } catch (e) { console.warn('[Puntúa] avisos', e); }
  }


  // Nombres y fechas de los capítulos (TVmaze), para la lista de capítulos de la ficha
  const epNames = {}, epLoading = new Set();
  function episodes(t) {
    if (!t || !t.id) return null;
    if (epNames[t.id]) return epNames[t.id];
    try { const c = JSON.parse(localStorage.getItem('puntua-ep-' + t.id) || 'null'); if (c && Date.now() - c.t < 7 * 864e5) return (epNames[t.id] = c.m); } catch (e) {}
    if (epLoading.has(t.id) || !navigator.onLine) return null;
    epLoading.add(t.id);
    (async () => {
      try {
        let tvid = (tvCache[t.id] || {}).id;
        const imdb = t.imdb || t.imdbId || (((window.PUNTUA_META || {}).series || {})[t.id] || {}).imdb;
        if (!tvid && imdb) { const sh = await tvGet('/lookup/shows?imdb=' + encodeURIComponent(imdb)); tvid = sh && sh.id; }
        if (!tvid) { const sh = await tvGet('/singlesearch/shows?q=' + encodeURIComponent(t.title)); tvid = sh && sh.id; }
        if (!tvid) return;
        const eps = await tvGet('/shows/' + tvid + '/episodes') || [];
        const m = {};
        for (const e of eps) if (e.season && e.number) m[`${e.season}x${String(e.number).padStart(2, '0')}`] = { n: e.name || '', d: e.airdate || '' };
        epNames[t.id] = m;
        try { localStorage.setItem('puntua-ep-' + t.id, JSON.stringify({ t: Date.now(), m })); } catch (e) {}
        if (typeof window.renderModal === 'function') window.renderModal();
      } catch (e) { console.warn('[Puntúa] capítulos', e); }
    })();
    return null;
  }

  const userApi = { id: async () => ME, isOwner: () => true, can: async () => true, profiles: async ids => Object.fromEntries(ids.map(i => [i, { name: 'Yo' }])) };

  // Portadas subidas desde la app: se reducen y se guardan dentro de la ficha
  const assetsApi = {
    async upload(blob) {
      const url = await new Promise((res, rej) => {
        const img = new Image(), u = URL.createObjectURL(blob);
        img.onload = () => {
          const w = Math.min(500, img.naturalWidth), h = Math.round(img.naturalHeight * w / img.naturalWidth);
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h); URL.revokeObjectURL(u);
          res(c.toDataURL('image/jpeg', 0.8));
        };
        img.onerror = rej; img.src = u;
      });
      return { id: 'up-' + Date.now().toString(36), url };
    },
  };

  const downloadsApi = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return { status: 'saved' };
    },
  };

  /* ---------- Cuenta y sincronización con Firebase ----------
     La app trabaja siempre con los datos de este navegador (abre al momento y funciona sin conexión).
     Firebase solo sincroniza: cada documento (listas, notas, cada ficha editada) se guarda en
     users/<tu cuenta>/docs y, si cambia en otro dispositivo, se junta entrada a entrada. */
  const FBV = '11.10.0';
  const SYNC = { on: false, busy: false, err: null, last: 0, email: '', uid: '' };
  let fb = null, auth = null, fs = null;
  const remote = {};                 // última versión conocida en Firebase de cada documento
  const dirty = new Set();
  let pushTimer = null, firstSnap = false;
  const say = t => { if (typeof window.toast === 'function') window.toast(t); else console.log(t); };
  const escH = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ago = t => { if (!t) return ''; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'ahora mismo' : m < 60 ? `hace ${m} min` : new Date(t).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
  const docId = k => k.replace(/\//g, '__');
  const keyFromId = id => id.replace(/__/g, '/');
  const syncOn = () => SYNC.on;

  function mergeOne(k, a, b) {
    if (a === undefined) return b; if (b === undefined) return a;
    if (k === 'lists' || k === 'review') return mergeNested(a, b);
    return ((b && b._mt) || 0) > ((a && a._mt) || 0) ? b : a;
  }

  function syncSoon(key) {
    if (key) dirty.add(key);
    if (!SYNC.on) return;
    clearTimeout(pushTimer); pushTimer = setTimeout(push, 800); badge();
  }
  async function push() {
    pushTimer = null;
    if (!SYNC.on || !dirty.size) { badge(); return; }
    const keys = [...dirty]; dirty.clear();
    SYNC.busy = true; badge();
    try {
      for (const k of keys) {
        const v = docs[k];
        const ref = fb.doc(fs, 'users', SYNC.uid, 'docs', docId(k));
        if (v === undefined) { await fb.deleteDoc(ref); delete remote[k]; continue; }
        const j = JSON.stringify(v);
        if (j.length > 900000) { console.warn('[Puntúa] documento demasiado grande para sincronizar:', k); continue; }
        await fb.setDoc(ref, { j, t: Date.now() });
        remote[k] = JSON.parse(j);
      }
      SYNC.err = null; SYNC.last = Date.now();
    } catch (e) {
      keys.forEach(k => dirty.add(k));
      SYNC.err = (e && e.code === 'permission-denied') ? 'Sin permiso en Firebase (revisa las reglas de Firestore)' : String((e && e.message) || e);
      setTimeout(() => syncSoon(), 20000);
    }
    SYNC.busy = false; badge(); renderPanel();
  }
  function onRemote(snap) {
    let changed = false;
    for (const ch of snap.docChanges()) {
      const k = keyFromId(ch.doc.id);
      if (ch.type === 'removed') continue;
      let v; try { v = JSON.parse(ch.doc.data().j); } catch (e) { continue; }
      remote[k] = v;
      const m = mergeOne(k, docs[k], v);
      if (!same(m, docs[k])) { docs[k] = m; changed = true; }
      if (!same(m, v)) dirty.add(k);
    }
    if (!firstSnap && !snap.metadata.fromCache) {
      firstSnap = true;
      for (const k of Object.keys(docs)) if (!(k in remote)) dirty.add(k);   // lo que solo estaba en este navegador, se sube
      weeklyBackup().catch(e => console.warn('[Puntúa] copia semanal', e));
      firstRunOffer();
    }
    if (!snap.metadata.hasPendingWrites) { SYNC.last = Date.now(); SYNC.err = null; }
    if (changed) { persist(); notify(); }
    if (dirty.size) syncSoon(); else { badge(); renderPanel(); }
  }

  // Copia semanal fechada en tu cuenta (se guardan las 8 últimas). Se puede descargar desde el panel.
  async function weeklyBackup() {
    const col = fb.collection(fs, 'users', SYNC.uid, 'backups');
    const list = (await fb.getDocs(col)).docs.map(d => d.id).sort();
    const today = new Date().toISOString().slice(0, 10);
    const last = list[list.length - 1];
    if (last && Date.parse(today) - Date.parse(last) < 7 * 864e5) return;
    let j = JSON.stringify({ v: 1, t: Date.now(), docs });
    if (j.length > 900000) j = JSON.stringify({ v: 1, t: Date.now(), docs: { lists: docs.lists, review: docs.review } });
    if (j.length > 900000) return;
    await fb.setDoc(fb.doc(col, today), { j, t: Date.now() });
    list.push(today);
    for (const old of list.slice(0, Math.max(0, list.length - 8))) await fb.deleteDoc(fb.doc(col, old));
  }
  async function listBackups() {
    const snap = await fb.getDocs(fb.collection(fs, 'users', SYNC.uid, 'backups'));
    return snap.docs.map(d => ({ id: d.id, j: d.data().j })).sort((a, b) => b.id.localeCompare(a.id));
  }

  /* ---------- Panel de la cuenta ---------- */
  const CSS = `
#pwSync{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px}
#pwSync .box{background:#1a1816;color:#f3efe8;border:1px solid #3a3631;border-radius:16px;max-width:440px;width:100%;padding:20px;display:flex;flex-direction:column;gap:12px;font:15px/1.45 system-ui,sans-serif;max-height:90vh;overflow:auto}
#pwSync *{text-transform:none;letter-spacing:normal;font-family:system-ui,sans-serif}
#pwSync h2{margin:0;font-size:20px}
#pwSync p,#pwSync li{margin:0;color:#c9c2b7;font-size:14px}
#pwSync a{color:#f5b301}
#pwSync .btns{display:flex;gap:8px;flex-wrap:wrap}
#pwSync button,#pwSync .pri{font:inherit;font-weight:600;padding:10px 14px;border-radius:10px;border:1px solid #3a3631;background:transparent;color:#f3efe8;cursor:pointer;text-decoration:none}
#pwSync .pri{background:#f5b301;color:#1a1400;border:0}
#pwSync .bk{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:14px}
#pwSync .bk button{padding:6px 10px;font-size:13px}
#pwSync .ok{color:#9be29b}#pwSync .bad{color:#ff8a7a}#pwSync .mut{color:#8d867c;font-size:13px}`;
  let backups = null;
  function panelHTML() {
    return `<div class="box"><h2>Tu cuenta</h2>
      <p>Has entrado como <b style="color:#f3efe8">${escH(SYNC.email)}</b>. Lo que hagas aquí se guarda en tu cuenta y lo ves igual en cualquier PC o móvil donde entres.</p>
      <p class="${SYNC.err ? 'bad' : 'ok'}">${SYNC.err ? 'Error al sincronizar: ' + escH(SYNC.err) : SYNC.busy || pushTimer ? 'Sincronizando…' : 'Sincronizado' + (SYNC.last ? ' · ' + escH(ago(SYNC.last)) : '')}</p>
      <p class="mut">Copias semanales automáticas (las 8 últimas). Para recuperar una, descárgala y cárgala con «Cargar copia de Puntúa».</p>
      ${backups == null ? '<p class="mut">Cargando copias…</p>' : backups.length ? backups.map((b, i) => `<div class="bk"><span>${escH(new Date(b.id + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }))}</span><button data-pw="dl" data-i="${i}">Descargar</button></div>`).join('') : '<p class="mut">Aún no hay copias: la primera se hace hoy.</p>'}
      <div class="btns"><button class="pri" data-pw="close">Cerrar</button><button data-pw="now">Sincronizar ahora</button><button data-pw="out">Cerrar sesión</button></div>
    </div>`;
  }
  function renderPanel() { const d = document.getElementById('pwSync'); if (d && d.dataset.kind === 'acct') d.innerHTML = panelHTML(); }
  function openPanel() {
    if (!document.getElementById('pwCss')) { const st = document.createElement('style'); st.id = 'pwCss'; st.textContent = CSS; document.head.appendChild(st); }
    let d = document.getElementById('pwSync');
    if (!d) {
      d = document.createElement('div'); d.id = 'pwSync'; d.dataset.kind = 'acct'; document.body.appendChild(d);
      d.addEventListener('click', async ev => {
        if (ev.target === d) { d.remove(); return; }
        const b = ev.target.closest('[data-pw]'); if (!b) return;
        const a = b.dataset.pw;
        if (a === 'close') d.remove();
        if (a === 'now') { Object.keys(docs).forEach(k => dirty.add(k)); syncSoon(); say('Sincronizando…'); }
        if (a === 'out') { if (confirm('¿Cerrar sesión en este navegador? Tus datos siguen en tu cuenta.')) { await fb.signOut(auth); location.reload(); } }
        if (a === 'dl') { const bk = backups[+b.dataset.i]; await downloadsApi.save({ filename: `puntua-copia-${bk.id}.json`, data: bk.j }); }
      });
    }
    renderPanel();
    listBackups().then(l => { backups = l; renderPanel(); }).catch(() => { backups = []; renderPanel(); });
  }
  /* ---------- Indicador pequeño en la cabecera ---------- */
  function badge() {
    let b = document.getElementById('pwBadge');
    if (!b) {
      const add = document.getElementById('addBtn'); if (!add) return;
      if (!document.getElementById('pwBadgeCss')) {
        const st = document.createElement('style'); st.id = 'pwBadgeCss';
        st.textContent = `#pwBadge{width:30px;height:30px;flex:0 0 30px;border-radius:50%;border:1px solid #3a3631;background:transparent;display:grid;place-items:center;cursor:pointer;padding:0;color:#8d867c}
#pwBadge svg{width:16px;height:16px}#pwBadge.ok{color:#7fd17f}#pwBadge.busy{color:#f5b301}#pwBadge.busy svg{animation:pwspin 1s linear infinite}#pwBadge.err{color:#ff7a6a;border-color:#ff7a6a}
@keyframes pwspin{to{transform:rotate(360deg)}}`;
        document.head.appendChild(st);
      }
      b = document.createElement('button'); b.id = 'pwBadge'; b.type = 'button';
      b.addEventListener('click', openPanel);
      add.parentNode.insertBefore(b, add);
    }
    const on = syncOn(), st = !on ? 'off' : SYNC.busy || pushTimer ? 'busy' : SYNC.err ? 'err' : 'ok';
    const ic = {
      ok: '<path d="M20 6 9 17l-5-5"/>',
      busy: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
      err: '<path d="M12 8v5"/><path d="M12 16.5v.5"/><circle cx="12" cy="12" r="9"/>',
      off: '<path d="M17.5 19H8a5 5 0 1 1 1.6-9.7A6 6 0 0 1 21 12.5"/><path d="m3 3 18 18"/>',
    }[st];
    b.className = st;
    b.title = { ok: 'Sincronizado' + (SYNC.last ? ' · ' + ago(SYNC.last) : ''), busy: 'Sincronizando…', err: 'Error al sincronizar: ' + (SYNC.err || ''), off: 'Sin conexión con tu cuenta todavía' }[st];
    b.setAttribute('aria-label', b.title);
    b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${ic}</svg>`;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', badge); else setTimeout(badge, 0);
  setInterval(badge, 30000);

  // Cargar una copia de Puntúa («Copia de seguridad (JSON)», data.json de la copia completa o una copia semanal)
  function restore() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        const hasData = docs.lists && Object.keys((strip(docs.lists).status) || {}).length;
        if (j.docs) {   // copia semanal
          if (hasData && !confirm('Esto sustituirá tus datos por los de la copia. ¿Seguir?')) return;
          for (const [k, v] of Object.entries(j.docs)) { if (k === 'lists' || k === 'review') putNested(k, strip(v)); else docs[k] = { ...v, _mt: Date.now() }; dirty.add(k); }
        } else {
          if (!j.lists) throw new Error('Este archivo no es una copia de Puntúa');
          if (hasData && !confirm('Esto sustituirá tus listas, notas y progreso por los de la copia. ¿Seguir?')) return;
          const mine = j.reviews && j.me && j.reviews[j.me] ? j.reviews[j.me] : (j.reviews && !j.me ? j.reviews : {});
          putNested('lists', j.lists);
          putNested('review', { items: (mine && mine.items) || mine || {}, eps: (mine && mine.eps) || {} });
          dirty.add('lists'); dirty.add('review');
        }
        persist(); notify(); syncSoon();
        say('Copia cargada');
      } catch (e) { alert('No se pudo cargar: ' + (e.message || e)); }
    };
    inp.click();
  }

  /* ---------- Versión: novedades tras actualizar y aviso de versión nueva en la APK ---------- */
  const VER = window.PUNTUA_VERSION || '', LOG = window.PUNTUA_CHANGELOG || [];
  const vcmp = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
  function changesHTML(from, to, list) {
    return (list || LOG).filter(c => vcmp(c.v, from) > 0 && vcmp(c.v, to) <= 0).map(c =>
      `<p><b>v${escH(c.v)}</b></p><ul style="margin:0 0 6px;padding-left:20px">${c.items.map(i => `<li>${escH(i)}</li>`).join('')}</ul>`).join('');
  }
  function infoBox(html) {
    if (!document.getElementById('pwCss')) { const st = document.createElement('style'); st.id = 'pwCss'; st.textContent = CSS; document.head.appendChild(st); }
    const d = document.createElement('div'); d.id = 'pwSync'; d.innerHTML = `<div class="box">${html}</div>`; document.body.appendChild(d);
    d.addEventListener('click', e => { if (e.target === d || e.target.closest('[data-pw=close]')) d.remove(); });
  }
  function showAbout() {
    infoBox(`<h2>Puntúa v${escH(VER)}</h2><p class="mut">Historial de cambios</p>${changesHTML('0', VER)}<div class="btns"><button class="pri" data-pw="close">Cerrar</button></div>`);
  }
  setTimeout(() => {
    let seen = ''; try { seen = localStorage.getItem('puntua-ver') || ''; localStorage.setItem('puntua-ver', VER); } catch (e) {}
    if (seen && VER && vcmp(VER, seen) > 0) {
      const ch = changesHTML(seen, VER);
      if (ch) infoBox(`<h2>Novedades de Puntúa v${escH(VER)}</h2>${ch}<div class="btns"><button class="pri" data-pw="close">¡Vale!</button></div>`);
    }
    if (IN_APP) fetch('https://api.github.com/repos/avillar25/puntua/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
      .then(r => r.ok ? r.json() : null).then(rel => {
        if (!rel || !rel.tag_name) return;
        const nv = rel.tag_name.replace(/^v/, ''); if (vcmp(nv, VER) <= 0) return;
        let skip = ''; try { skip = localStorage.getItem('puntua-skip') || ''; } catch (e) {}
        if (skip === nv) return;
        const apk = (rel.assets || []).find(a => /\.apk$/.test(a.name));
        const body = escH(rel.body || '').replace(/\n/g, '<br>');
        infoBox(`<h2>Hay una versión nueva: v${escH(nv)}</h2><p class="mut">Tienes la v${escH(VER)}.</p><div style="font-size:14px;color:#c9c2b7">${body}</div>
          <div class="btns">${apk ? `<a class="pri" style="padding:10px 14px;border-radius:10px;text-decoration:none;font-weight:600" href="${escH(apk.browser_download_url)}" target="_blank" rel="noopener">Descargar</a>` : ''}
          <button data-pw="close" id="pwSkip">Ahora no</button></div>`);
        const sk = document.getElementById('pwSkip'); if (sk) sk.addEventListener('click', () => { try { localStorage.setItem('puntua-skip', nv); } catch (e) {} });
      }).catch(() => {});
  }, 2500);


  const platform = {
    use: async name => ({ db: dbApi, user: userApi, assets: assetsApi, downloads: downloadsApi })[name] || null,
    sync: openPanel,
    about: showAbout,
    version: VER,
    restore,
    episodes,
    get syncOn() { return syncOn(); },
    get email() { return SYNC.email; },
  };
  // En la APK, también los datos externos (notas, duraciones, capítulos) se toman de la web si son más nuevos
  if (IN_APP) fetch(IMG_BASE + 'meta.js', { cache: 'no-cache' }).then(r => r.ok ? r.text() : null).then(txt => {
    if (!txt) return;
    const box = {}; new Function('window', txt)(box);
    const cur = window.PUNTUA_META, nw = box.PUNTUA_META; if (!cur || !nw) return;
    for (const sec of ['movies', 'series', 'sagas', 'games']) if (nw[sec]) { cur[sec] = cur[sec] || {}; for (const [k, v] of Object.entries(nw[sec])) cur[sec][k] = { ...(cur[sec][k] || {}), ...v }; }
    tvApplied = false; tvApplyCached(); notify();
  }).catch(() => {});
  window.PuntuaWeb = platform;
  let resolveReady; window.PuntuaWebReady = new Promise(r => { resolveReady = r; });

  // Primera vez sin datos (ni aquí ni en tu cuenta): ofrecer cargar una copia
  function firstRunOffer() {
    if (docs.lists) return;
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:80px;z-index:9000;max-width:520px;margin:0 auto;background:#1f1c19;color:#f3efe8;border:1px solid #f5b301;border-radius:14px;padding:14px;font:15px system-ui;display:flex;flex-direction:column;gap:10px;box-shadow:0 10px 30px rgba(0,0,0,.5)';
    bar.innerHTML = `<b>Tu cuenta está vacía</b><span>Si tienes una copia de Puntúa (el archivo <i>.json</i>), cárgala para recuperar tus listas, notas y progreso.</span>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button data-b="r" style="flex:1;background:#f5b301;color:#1a1400;font-weight:600;border:0;border-radius:10px;padding:10px;font:inherit">Cargar copia</button>
      <button data-b="x" style="background:none;border:1px solid #3a3631;color:inherit;border-radius:10px;padding:10px 14px;font:inherit">Ahora no</button></div>`;
    document.body.appendChild(bar);
    bar.addEventListener('click', e => { const b = e.target.closest('[data-b]'); if (!b) return; bar.remove(); if (b.dataset.b === 'r') restore(); });
  }

  /* ---------- Pantallas de acceso: entrar, crear cuenta y verificar el correo ---------- */
  const LCSS = `
#fbLogin{position:fixed;inset:0;z-index:9999;background:#0d0c0b;color:#f3efe8;display:flex;align-items:center;justify-content:center;padding:20px;font-family:system-ui,sans-serif;overflow:auto}
#fbLogin .box{width:100%;max-width:360px;display:flex;flex-direction:column;gap:12px}
#fbLogin *{text-transform:none;letter-spacing:normal;font-family:system-ui,sans-serif}
#fbLogin h1{font-size:34px;margin:0;letter-spacing:-.02em}
#fbLogin h2{font-size:24px;margin:0;font-weight:700}
#fbLogin p{margin:0;color:#b9b2a7;font-size:14px;line-height:1.45}
#fbLogin label{display:flex;flex-direction:column;gap:6px;font-size:13px;color:#b9b2a7}
#fbLogin input{font:inherit;font-size:16px;padding:12px 14px;border-radius:10px;border:1px solid #3a3631;background:#1a1816;color:#f3efe8;width:100%;box-sizing:border-box}
#fbLogin input:focus{outline:2px solid #f5b301;border-color:transparent}
#fbLogin .pw{position:relative}
#fbLogin .pw input{padding-right:64px}
#fbLogin .eye{position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:0;color:#b9b2a7;font:13px system-ui;padding:8px;cursor:pointer}
#fbLogin .hint{font-size:12px;color:#8d867c}
#fbLogin .btn{font:inherit;font-size:16px;font-weight:600;padding:12px 14px;border-radius:10px;border:0;cursor:pointer}
#fbLogin .pri{background:#f5b301;color:#1a1400}
#fbLogin .pri:disabled{opacity:.6}
#fbLogin .sec{background:transparent;color:#f3efe8;border:1px solid #3a3631}
#fbLogin .lnk{background:none;border:0;color:#f5b301;font:14px system-ui;padding:4px;cursor:pointer}
#fbLogin .fbrow{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
#fbLogin .msg{min-height:20px;font-size:14px;color:#ff8a7a}
#fbLogin .msg.ok{color:#9be29b}`;
  const ERR = {
    'auth/invalid-credential': 'Correo o contraseña incorrectos', 'auth/wrong-password': 'Correo o contraseña incorrectos',
    'auth/user-not-found': 'Correo o contraseña incorrectos', 'auth/email-already-in-use': 'Ya existe una cuenta con ese correo',
    'auth/weak-password': 'La contraseña es demasiado débil', 'auth/invalid-email': 'El correo no es válido',
    'auth/missing-password': 'Escribe la contraseña', 'auth/network-request-failed': 'Sin conexión a internet',
    'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos.', 'auth/admin-restricted-operation': 'No se pueden crear cuentas nuevas',
  };
  const nice = e => ERR[e && e.code] || (e && e.message) || String(e);
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const pwField = (id, ac) => `<div class="pw"><input type="password" id="${id}" autocomplete="${ac}"><button type="button" class="eye" data-eye="${id}">Mostrar</button></div>`;
  function overlay() {
    let d = document.getElementById('fbLogin');
    if (!d) {
      if (!document.getElementById('fbCss')) { const st = document.createElement('style'); st.id = 'fbCss'; st.textContent = LCSS; document.head.appendChild(st); }
      d = document.createElement('div'); d.id = 'fbLogin'; document.body.appendChild(d);
      d.addEventListener('click', ev => {
        const b = ev.target.closest('[data-eye]'); if (!b) return;
        const i = d.querySelector('#' + b.dataset.eye); const show = i.type === 'password';
        i.type = show ? 'text' : 'password'; b.textContent = show ? 'Ocultar' : 'Mostrar';
      });
    }
    return d;
  }
  function screen(html, bind) {
    const d = overlay(); d.innerHTML = `<form class="box" novalidate>${html}<div class="msg" id="fbMsg"></div></form>`;
    const $ = id => d.querySelector('#' + id);
    const msg = (t, ok) => { const m = $('fbMsg'); m.textContent = t || ''; m.className = 'msg' + (ok ? ' ok' : ''); };
    const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); } finally { btn.disabled = false; } };
    bind($, msg, busy, d.querySelector('form'));
    const first = d.querySelector('input'); if (first) setTimeout(() => first.focus(), 50);
  }
  function showLoading(t) { screen(`<h1>Puntúa</h1><p>${escH(t)}</p>`, () => {}); }
  function showLogin(prefill = '') {
    screen(`<h1>Puntúa</h1><p>Entra con tu cuenta para ver tus pelis, series y juegos en cualquier PC o móvil.</p>
      <label>Correo<input type="email" id="fbEmail" autocomplete="email" inputmode="email"></label>
      <label>Contraseña${pwField('fbPass', 'current-password')}</label>
      <button class="btn pri" type="submit" id="fbGo">Entrar</button>
      <div class="fbrow"><button class="lnk" type="button" id="fbReset">He olvidado la contraseña</button>
      <button class="lnk" type="button" id="fbToNew">Crear cuenta</button></div>`,
    ($, msg, busy, form) => {
      $('fbEmail').value = prefill;
      form.onsubmit = ev => { ev.preventDefault(); msg('');
        const em = $('fbEmail').value.trim(), pw = $('fbPass').value;
        if (!EMAIL_RE.test(em)) return msg('Escribe un correo válido');
        if (!pw) return msg('Escribe la contraseña');
        busy($('fbGo'), async () => { try { await fb.signInWithEmailAndPassword(auth, em, pw); } catch (e) { msg(nice(e)); } });
      };
      $('fbToNew').onclick = () => showSignup($('fbEmail').value.trim());
      $('fbReset').onclick = () => { const em = $('fbEmail').value.trim();
        if (!EMAIL_RE.test(em)) return msg('Escribe arriba tu correo y vuelve a pulsar');
        busy($('fbReset'), async () => { try { await fb.sendPasswordResetEmail(auth, em); msg('Si hay una cuenta con ese correo, te llegará un enlace para cambiar la contraseña.', true); } catch (e) { msg(nice(e)); } });
      };
    });
  }
  function showSignup(prefill = '') {
    screen(`<h2>Crear cuenta</h2><p>Tus listas y notas quedarán guardadas en tu cuenta y podrás verlas en cualquier PC o móvil.</p>
      <label>Correo<input type="email" id="fbEmail" autocomplete="email" inputmode="email"></label>
      <label>Contraseña${pwField('fbPass', 'new-password')}<span class="hint">Mínimo 8 caracteres, con letras y números.</span></label>
      <label>Repite la contraseña${pwField('fbPass2', 'new-password')}</label>
      <button class="btn pri" type="submit" id="fbGo">Crear cuenta</button>
      <button class="lnk" type="button" id="fbToLogin">Ya tengo cuenta, quiero entrar</button>`,
    ($, msg, busy, form) => {
      $('fbEmail').value = prefill;
      form.onsubmit = ev => { ev.preventDefault(); msg('');
        const em = $('fbEmail').value.trim(), pw = $('fbPass').value, pw2 = $('fbPass2').value;
        if (!EMAIL_RE.test(em)) return msg('Escribe un correo válido');
        if (pw.length < 8 || !/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) return msg('La contraseña necesita al menos 8 caracteres, con letras y números');
        if (pw !== pw2) return msg('Las contraseñas no coinciden');
        busy($('fbGo'), async () => {
          try { const c = await fb.createUserWithEmailAndPassword(auth, em, pw); await fb.sendEmailVerification(c.user); }
          catch (e) { msg(nice(e)); }
        });
      };
      $('fbToLogin').onclick = () => showLogin($('fbEmail').value.trim());
    });
  }
  function showVerify(u) {
    screen(`<h2>Verifica tu correo</h2>
      <p>Te he enviado un correo a <b style="color:#f3efe8">${escH(u.email || '')}</b> con un enlace para confirmar la cuenta. Ábrelo y vuelve aquí. Si no lo ves, mira en el correo no deseado.</p>
      <button class="btn pri" type="submit" id="fbGo">Ya lo he verificado</button>
      <button class="btn sec" type="button" id="fbAgain">Reenviar el correo</button>
      <button class="lnk" type="button" id="fbOut">Usar otra cuenta</button>`,
    ($, msg, busy, form) => {
      form.onsubmit = ev => { ev.preventDefault(); msg('');
        busy($('fbGo'), async () => { try { await u.reload(); if (auth.currentUser.emailVerified) enter(auth.currentUser); else msg('Todavía no consta como verificado. Abre el enlace del correo y vuelve a probar.'); } catch (e) { msg(nice(e)); } });
      };
      $('fbAgain').onclick = () => busy($('fbAgain'), async () => { try { await fb.sendEmailVerification(u); msg('Correo reenviado', true); } catch (e) { msg(nice(e)); } });
      $('fbOut').onclick = () => fb.signOut(auth);
    });
  }

  /* ---------- Arranque ---------- */
  let started = false;
  function enter(u) {
    if (started) return;
    started = true;
    SYNC.uid = u.uid; SYNC.email = u.email || ''; SYNC.on = !u.offline;
    try { localStorage.setItem('puntua-last', JSON.stringify({ uid: u.uid, email: u.email || '' })); } catch (e) {}
    // Datos de esta cuenta en este navegador (+ lo que hubiera de antes de tener cuenta, que se sube)
    STORE = 'puntua-data-' + u.uid;
    try { docs = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { docs = {}; }
    try {
      const old = JSON.parse(localStorage.getItem(LEGACY) || 'null');
      if (old) { for (const [k, v] of Object.entries(old)) docs[k] = mergeOne(k, docs[k], v); localStorage.removeItem(LEGACY); localStorage.removeItem('puntua-sync'); persist(); }
    } catch (e) {}
    const l = document.getElementById('fbLogin'); if (l) l.remove();
    resolveReady(platform);
    badge();
    if (u.offline) { SYNC.err = 'Sin conexión: los cambios se guardan en este navegador y se subirán cuando vuelvas a abrir la app con internet'; badge(); return; }
    fb.onSnapshot(fb.collection(fs, 'users', u.uid, 'docs'), { includeMetadataChanges: true }, onRemote, e => {
      SYNC.err = (e && e.code === 'permission-denied') ? 'Sin permiso en Firebase (revisa las reglas de Firestore)' : String((e && e.message) || e); badge();
    });
    const flush = () => { if (pushTimer) { clearTimeout(pushTimer); push(); } };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    window.addEventListener('pagehide', flush);
  }
  (async () => {
    showLoading('Cargando…');
    try {
      const [app, au, st] = await Promise.all([
        import(`https://www.gstatic.com/firebasejs/${FBV}/firebase-app.js`),
        import(`https://www.gstatic.com/firebasejs/${FBV}/firebase-auth.js`),
        import(`https://www.gstatic.com/firebasejs/${FBV}/firebase-firestore.js`),
      ]);
      fb = { ...au, ...st };
      const fapp = app.initializeApp(window.FIREBASE_CONFIG);
      auth = au.getAuth(fapp); auth.languageCode = 'es';
      fs = st.initializeFirestore(fapp, {});   // sin caché propia: los datos ya se guardan en el navegador
      await au.setPersistence(auth, au.browserLocalPersistence).catch(() => {});
      au.onAuthStateChanged(auth, u => {
        if (!u) { if (started) location.reload(); else showLogin(); return; }
        if (!u.emailVerified) { showVerify(u); return; }
        enter(u);
      });
    } catch (e) {
      // Sin internet: si ya habías entrado en este navegador, se abre con tus datos guardados aquí
      let last = null; try { last = JSON.parse(localStorage.getItem('puntua-last') || 'null'); } catch (e2) {}
      if (last && last.uid) { enter({ uid: last.uid, email: last.email, offline: true }); return; }
      screen(`<h1>Puntúa</h1><p>No se puede conectar ahora mismo. Comprueba la conexión a internet y vuelve a intentarlo.</p><button class="btn pri" type="button" id="fbRetry">Reintentar</button>`,
        $ => { $('fbRetry').onclick = () => location.reload(); });
    }
  })();
})();
