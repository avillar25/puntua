// Puntúa · capa de datos de la web y la APK.
// Guarda todo en este dispositivo y, si conectas un token de GitHub, lo sincroniza con un Gist secreto
// (igual que Clash Alerter). Ofrece a la app la misma interfaz que tenía dentro de Claude:
// use('db' | 'user' | 'assets' | 'downloads').
(function () {
  'use strict';
  const ME = 'me';
  const STORE = 'puntua-data', CFG = 'puntua-sync';
  const SYNC_FILE = 'puntua.json', SYNC_DESC = 'Puntúa · sincronización (no borrar)';
  const IN_APP = location.hostname === 'localhost' || location.protocol === 'capacitor:';
  const IMG_BASE = IN_APP ? 'https://avillar25.github.io/puntua/' : '';
  window.PUNTUA_REMOTE = IMG_BASE;   // en la APK, los datos que cambian cada semana se leen de la web

  /* ---------- Almacén local ----------
     docs.lists / docs.review: tus listas y tus notas. Cada entrada de segundo nivel lleva su hora de
     cambio en _mt["sección/id"], para juntar sin perder nada si cambias cosas en el móvil y en el PC.
     docs["titles/<id>"]: fichas que has creado o editado (con _mt); {deleted:true} oculta una del catálogo. */
  let docs = {};
  try { docs = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { docs = {}; }
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
          persist(); notify(); syncSoon();
        },
        async delete() {
          if (key.startsWith('titles/')) docs[key] = { deleted: true, _mt: Date.now() };
          else delete docs[key];
          persist(); notify(); syncSoon();
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

  /* ---------- Sincronización con un Gist secreto de GitHub ---------- */
  const SYNC = { cfg: null, busy: false, again: false, last: 0, err: null, timer: null, checked: false };
  try { SYNC.cfg = JSON.parse(localStorage.getItem(CFG) || 'null'); } catch (e) { SYNC.cfg = null; }
  const cfgSave = () => { try { SYNC.cfg ? localStorage.setItem(CFG, JSON.stringify(SYNC.cfg)) : localStorage.removeItem(CFG); } catch (e) {} };
  const syncOn = () => !!(SYNC.cfg && SYNC.cfg.token);

  async function gh(path, opt = {}) {
    const r = await fetch('https://api.github.com' + path, { ...opt, cache: 'no-store', headers: {
      Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + SYNC.cfg.token, 'X-GitHub-Api-Version': '2022-11-28',
      ...(opt.body ? { 'Content-Type': 'application/json' } : {}) } });
    if (r.status === 401) throw new Error('El token no es válido o ha caducado');
    if (r.status === 403 || r.status === 404) throw new Error('El token no tiene permiso de Gists');
    if (!r.ok) throw new Error('GitHub respondió ' + r.status);
    return r.status === 204 ? null : r.json();
  }
  async function findGist(recheck) {
    if (SYNC.cfg.gist && !recheck) return SYNC.cfg.gist;
    let found = [];
    for (let page = 1; page <= 5; page++) {
      const list = await gh(`/gists?per_page=100&page=${page}`);
      found = found.concat((list || []).filter(x => x.files && x.files[SYNC_FILE]));
      if (!list || list.length < 100) break;
    }
    if (found.length) {   // si hubiera varias copias, todos los dispositivos usan la más antigua
      found.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      if (SYNC.cfg.gist !== found[0].id) { SYNC.cfg.gist = found[0].id; cfgSave(); }
      return found[0].id;
    }
    const g = await gh('/gists', { method: 'POST', body: JSON.stringify({ description: SYNC_DESC, public: false,
      files: { [SYNC_FILE]: { content: JSON.stringify({ v: 1, docs: {} }) } } }) });
    SYNC.cfg.gist = g.id; cfgSave(); return g.id;
  }
  function mergeAll(local, remote) {
    const out = {};
    for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      const a = local[k], b = remote[k];
      if (k === 'lists' || k === 'review') out[k] = (a && b) ? mergeNested(a, b) : (a || b);
      else out[k] = a === undefined ? b : b === undefined ? a : (((b && b._mt) || 0) > ((a && a._mt) || 0) ? b : a);
    }
    return out;
  }
  async function syncNow(manual) {
    if (!syncOn()) return;
    if (SYNC.busy) { SYNC.again = true; return; }
    SYNC.busy = true; renderPanel();
    try {
      const id = await findGist(manual || !SYNC.checked); SYNC.checked = true;
      // Si el Gist no ha cambiado desde la última vez, GitHub responde 304 sin mandar nada (ahorra datos)
      let remote;
      const r = await fetch('https://api.github.com/gists/' + id, { cache: 'no-store', headers: {
        Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + SYNC.cfg.token, 'X-GitHub-Api-Version': '2022-11-28',
        ...(SYNC.etag && SYNC.lastRemote && SYNC.etagId === id ? { 'If-None-Match': SYNC.etag } : {}) } });
      if (r.status === 304) remote = SYNC.lastRemote;
      else {
        if (r.status === 401) throw new Error('El token no es válido o ha caducado');
        if (r.status === 403 || r.status === 404) throw new Error('El token no tiene permiso de Gists');
        if (!r.ok) throw new Error('GitHub respondió ' + r.status);
        const g = await r.json();
        const f = g.files && g.files[SYNC_FILE];
        let content = f && f.content;
        if (f && f.truncated && f.raw_url) content = await (await fetch(f.raw_url + (f.raw_url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' })).text();
        remote = content ? (JSON.parse(content).docs || {}) : {};
        SYNC.etag = r.headers.get('ETag'); SYNC.etagId = id;
      }
      const merged = mergeAll(docs, remote);
      if (!same(merged, docs)) { docs = merged; persist(); notify(); }
      if (!same(merged, remote)) { await gh('/gists/' + id, { method: 'PATCH', body: JSON.stringify({ files: { [SYNC_FILE]: { content: JSON.stringify({ v: 1, t: Date.now(), docs: merged }) } } }) }); SYNC.etag = null; }
      SYNC.lastRemote = merged;
      weeklyBackup(merged).catch(e => console.warn('[Puntúa] copia semanal', e.message || e));
      SYNC.last = Date.now(); SYNC.err = null;
      if (manual) say('Sincronizado');
    } catch (e) { SYNC.err = String(e.message || e); if (manual) say('No se pudo sincronizar: ' + SYNC.err); }
    SYNC.busy = false;
    if (SYNC.again) { SYNC.again = false; syncNow(); } else renderPanel();
  }

  // Copia semanal fechada en un Gist aparte («Puntúa · copias»), para no cargar la sincronización diaria.
  // Se guardan las 8 últimas.
  const BACK_MARK = 'puntua-copias.md';
  async function weeklyBackup(merged) {
    const today = new Date().toISOString().slice(0, 10);
    if (SYNC.cfg.lastBack && Date.parse(today) - Date.parse(SYNC.cfg.lastBack) < 7 * 864e5) return;
    let bid = SYNC.cfg.backGist;
    if (!bid) {
      const list = await gh('/gists?per_page=100');
      const f = (list || []).filter(x => x.files && x.files[BACK_MARK]).sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)))[0];
      bid = f && f.id;
    }
    let names = [];
    if (bid) { const g = await gh('/gists/' + bid); names = Object.keys(g.files || {}); }
    const backs = names.filter(n => /^puntua-copia-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
    const last = backs.length ? backs[backs.length - 1].slice(13, 23) : '';
    if (last && Date.parse(today) - Date.parse(last) < 7 * 864e5) { SYNC.cfg.backGist = bid; SYNC.cfg.lastBack = last; cfgSave(); return; }
    const name = 'puntua-copia-' + today + '.json', content = JSON.stringify({ v: 1, t: Date.now(), docs: merged });
    if (!bid) {
      const g = await gh('/gists', { method: 'POST', body: JSON.stringify({ description: 'Puntúa · copias semanales (no borrar)', public: false,
        files: { [BACK_MARK]: { content: 'Copias semanales de Puntúa. Para recuperar una, descárgala y cárgala en Mi lista → «Cargar copia de Puntúa».' }, [name]: { content } } }) });
      bid = g.id;
    } else {
      const files = { [name]: { content } };
      backs.push(name);
      for (const old of backs.slice(0, Math.max(0, backs.length - 8))) files[old] = null;
      await gh('/gists/' + bid, { method: 'PATCH', body: JSON.stringify({ files }) });
    }
    SYNC.cfg.backGist = bid; SYNC.cfg.lastBack = today; cfgSave();
  }
  function syncSoon() { if (!syncOn()) return; clearTimeout(SYNC.timer); SYNC.timer = setTimeout(() => { SYNC.timer = null; syncNow(); }, 1000); badge(); }
  // Como en Clash Alerter: cada cambio se sube al momento (1 s después del último), lo pendiente se sube
  // ya al salir de la app o cambiar de pestaña, y al volver se baja lo último del otro dispositivo.
  // Con la app abierta, además, se mira cada minuto si hay cambios del otro lado.
  const flush = () => { if (SYNC.timer) { clearTimeout(SYNC.timer); SYNC.timer = null; syncNow(); } };
  document.addEventListener('visibilitychange', () => {
    if (!syncOn()) return;
    if (document.visibilityState === 'hidden') flush(); else syncNow();
  });
  window.addEventListener('pagehide', () => { if (syncOn()) flush(); });
  window.addEventListener('focus', () => { if (syncOn() && Date.now() - SYNC.last > 15000) syncNow(); });
  setInterval(() => { if (syncOn() && document.visibilityState === 'visible' && !SYNC.timer) syncNow(); }, 60000);

  /* ---------- Ventana de sincronización y de copia ---------- */
  const say = t => { if (typeof window.toast === 'function') window.toast(t); else console.log(t); };
  const escH = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ago = t => { if (!t) return ''; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'ahora mismo' : m < 60 ? `hace ${m} min` : new Date(t).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
  const CSS = `
#pwSync{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px}
#pwSync .box{background:#1a1816;color:#f3efe8;border:1px solid #3a3631;border-radius:16px;max-width:440px;width:100%;padding:20px;display:flex;flex-direction:column;gap:12px;font:15px/1.45 system-ui,sans-serif;max-height:90vh;overflow:auto}
#pwSync *{text-transform:none;letter-spacing:normal;font-family:system-ui,sans-serif}
#pwSync h2{margin:0;font-size:20px}
#pwSync p,#pwSync li{margin:0;color:#c9c2b7;font-size:14px}
#pwSync ol{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:4px}
#pwSync a{color:#f5b301}
#pwSync input{font:inherit;font-size:16px;padding:11px 13px;border-radius:10px;border:1px solid #3a3631;background:#0d0c0b;color:#f3efe8;width:100%;box-sizing:border-box}
#pwSync .btns{display:flex;gap:8px;flex-wrap:wrap}
#pwSync button{font:inherit;font-weight:600;padding:10px 14px;border-radius:10px;border:1px solid #3a3631;background:transparent;color:#f3efe8;cursor:pointer}
#pwSync .pri{background:#f5b301;color:#1a1400;border:0}
#pwSync .ok{color:#9be29b}#pwSync .bad{color:#ff8a7a}#pwSync .mut{color:#8d867c;font-size:13px}`;
  function panelHTML() {
    const on = syncOn();
    return `<div class="box"><h2>Sincronizar con GitHub</h2>
      ${on ? `<p class="ok">${SYNC.busy ? 'Sincronizando…' : 'Conectado' + (SYNC.last ? ' · última vez ' + escH(ago(SYNC.last)) : '')}</p>
        ${SYNC.err ? `<p class="bad">${escH(SYNC.err)}</p>` : ''}
        ${SYNC.cfg.gist ? `<p class="mut">Copia en GitHub: ${escH(String(SYNC.cfg.gist).slice(0, 7))}. Tiene que salir lo mismo en el móvil y en el PC. Cada semana se guarda además una copia fechada (las 8 últimas)${SYNC.cfg.backGist ? `: las ves en <a href="https://gist.github.com/${escH(SYNC.cfg.backGist)}" target="_blank" rel="noopener">tu Gist de copias</a>` : ''}.</p>` : ''}
        <div class="btns"><button class="pri" data-pw="now">Sincronizar ahora</button><button data-pw="off">Desconectar</button><button data-pw="close">Cerrar</button></div>`
      : `<p>Tus datos se guardan en este dispositivo. Para tener lo mismo en el móvil y en el PC, conecta un token de GitHub: se guardan en un Gist secreto de tu cuenta que solo ves tú.</p>
        <p>Crea un token solo para Puntúa:</p>
        <ol><li>Entra en <a href="https://github.com/settings/tokens/new?scopes=gist&description=Punt%C3%BAa" target="_blank" rel="noopener">github.com/settings/tokens/new</a> (token <i>classic</i>).</li>
        <li>Marca solo el permiso <b>gist</b> y en caducidad elige <b>No expiration</b>.</li>
        <li>Pulsa <b>Generate token</b>, cópialo y pégalo aquí.</li></ol>
        <input type="password" id="pwTok" placeholder="ghp_…" autocomplete="off">
        <div class="btns"><button class="pri" data-pw="on">Conectar</button><button data-pw="close">Cerrar</button></div>
        <p class="mut">El token se guarda solo en este dispositivo. Si ya tienes datos en el otro, se juntan sin perder nada.</p>`}
    </div>`;
  }
  function renderPanel() { const d = document.getElementById('pwSync'); if (d) d.innerHTML = panelHTML(); badge(); }
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
    const on = syncOn(), st = !on ? 'off' : SYNC.busy || SYNC.timer ? 'busy' : SYNC.err ? 'err' : 'ok';
    const ic = {
      ok: '<path d="M20 6 9 17l-5-5"/>',
      busy: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
      err: '<path d="M12 8v5"/><path d="M12 16.5v.5"/><circle cx="12" cy="12" r="9"/>',
      off: '<path d="M17.5 19H8a5 5 0 1 1 1.6-9.7A6 6 0 0 1 21 12.5"/><path d="m3 3 18 18"/>',
    }[st];
    b.className = st;
    b.title = { ok: 'Sincronizado' + (SYNC.last ? ' · ' + ago(SYNC.last) : ''), busy: 'Sincronizando…', err: 'Error al sincronizar: ' + (SYNC.err || ''), off: 'Sin sincronizar (solo en este dispositivo)' }[st];
    b.setAttribute('aria-label', b.title);
    b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${ic}</svg>`;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', badge); else setTimeout(badge, 0);
  setInterval(badge, 30000);

  function openPanel() {
    if (!document.getElementById('pwCss')) { const st = document.createElement('style'); st.id = 'pwCss'; st.textContent = CSS; document.head.appendChild(st); }
    let d = document.getElementById('pwSync');
    if (!d) {
      d = document.createElement('div'); d.id = 'pwSync'; document.body.appendChild(d);
      d.addEventListener('click', async ev => {
        if (ev.target === d) { d.remove(); return; }
        const b = ev.target.closest('[data-pw]'); if (!b) return;
        const a = b.dataset.pw;
        if (a === 'close') d.remove();
        if (a === 'now') syncNow(true);
        if (a === 'off') { if (confirm('¿Desconectar? Tus datos se quedan en este dispositivo y en GitHub.')) { SYNC.cfg = null; SYNC.err = null; cfgSave(); renderPanel(); } }
        if (a === 'on') {
          const t = (d.querySelector('#pwTok').value || '').trim();
          if (!t) return;
          SYNC.cfg = { token: t }; SYNC.checked = false; cfgSave(); renderPanel();
          await syncNow(true);
          if (SYNC.err) { SYNC.cfg = null; cfgSave(); renderPanel(); const p = d.querySelector('.box'); if (p) p.insertAdjacentHTML('beforeend', `<p class="bad">${escH(SYNC.err)}</p>`); }
        }
      });
    }
    renderPanel();
  }

  // Cargar una copia de Puntúa (la de «Copia de seguridad (JSON)» o el data.json de la copia completa)
  function restore() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        if (!j.lists) throw new Error('Este archivo no es una copia de Puntúa');
        const hasData = docs.lists && Object.keys((strip(docs.lists).status) || {}).length;
        if (hasData && !confirm('Esto sustituirá tus listas, notas y progreso de este dispositivo por los de la copia. ¿Seguir?')) return;
        const mine = j.reviews && j.me && j.reviews[j.me] ? j.reviews[j.me] : (j.reviews && !j.me ? j.reviews : {});
        putNested('lists', j.lists);
        putNested('review', { items: (mine && mine.items) || mine || {}, eps: (mine && mine.eps) || {} });
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
    get syncOn() { return syncOn(); },
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
  window.PuntuaWebReady = Promise.resolve(platform);

  // Primera vez sin datos: ofrecer cargar la copia
  setTimeout(() => {
    if (docs.lists || syncOn()) { if (syncOn()) syncNow(); return; }
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:80px;z-index:9000;max-width:520px;margin:0 auto;background:#1f1c19;color:#f3efe8;border:1px solid #f5b301;border-radius:14px;padding:14px;font:15px system-ui;display:flex;flex-direction:column;gap:10px;box-shadow:0 10px 30px rgba(0,0,0,.5)';
    bar.innerHTML = `<b>¿Primera vez aquí?</b><span>Carga tu copia de Puntúa (el archivo <i>.json</i>) o, si ya la usas en otro dispositivo, conecta la sincronización con GitHub.</span>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button data-b="r" style="flex:1;background:#f5b301;color:#1a1400;font-weight:600;border:0;border-radius:10px;padding:10px;font:inherit">Cargar copia</button>
      <button data-b="s" style="flex:1;background:none;border:1px solid #3a3631;color:inherit;border-radius:10px;padding:10px;font:inherit">Sincronizar</button>
      <button data-b="x" style="background:none;border:0;color:#8d867c;padding:10px;font:inherit">Ahora no</button></div>`;
    document.body.appendChild(bar);
    bar.addEventListener('click', e => { const b = e.target.closest('[data-b]'); if (!b) return; bar.remove();
      if (b.dataset.b === 'r') restore(); if (b.dataset.b === 's') openPanel(); });
  }, 1200);
})();
