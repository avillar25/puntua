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
  let catalogP = null;
  function catalog() {
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
            const m = { ...(c.titles || {}) };
            for (const [k, v] of Object.entries(docs)) if (k.startsWith('titles/')) {
              const id = k.slice(7); if (v && v.deleted) delete m[id]; else m[id] = strip(v);
            }
            cb(snap(Object.entries(m).map(([id, v]) => [id, fixImg(v)])));
          });
          else if (path === 'reviews') f = () => cb(snap(docs.review ? [[ME, strip(docs.review)]] : []));
          else f = () => cb(snap([]));
          subs.add(f); setTimeout(f, 0);
          return () => subs.delete(f);
        },
      };
    },
  };

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
      const g = await gh('/gists/' + id);
      const f = g.files && g.files[SYNC_FILE];
      let content = f && f.content;
      if (f && f.truncated && f.raw_url) content = await (await fetch(f.raw_url + (f.raw_url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' })).text();
      const remote = content ? (JSON.parse(content).docs || {}) : {};
      const merged = mergeAll(docs, remote);
      if (!same(merged, docs)) { docs = merged; persist(); notify(); }
      if (!same(merged, remote)) await gh('/gists/' + id, { method: 'PATCH', body: JSON.stringify({ files: { [SYNC_FILE]: { content: JSON.stringify({ v: 1, t: Date.now(), docs: merged }) } } }) });
      SYNC.last = Date.now(); SYNC.err = null;
      if (manual) say('Sincronizado');
    } catch (e) { SYNC.err = String(e.message || e); if (manual) say('No se pudo sincronizar: ' + SYNC.err); }
    SYNC.busy = false;
    if (SYNC.again) { SYNC.again = false; syncNow(); } else renderPanel();
  }
  function syncSoon() { if (!syncOn()) return; clearTimeout(SYNC.timer); SYNC.timer = setTimeout(() => { SYNC.timer = null; syncNow(); }, 2500); }
  document.addEventListener('visibilitychange', () => {
    if (!syncOn()) return;
    if (document.visibilityState === 'hidden') { if (SYNC.timer) { clearTimeout(SYNC.timer); SYNC.timer = null; syncNow(); } }
    else syncNow();
  });

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
        ${SYNC.cfg.gist ? `<p class="mut">Copia en GitHub: ${escH(String(SYNC.cfg.gist).slice(0, 7))}. Tiene que salir lo mismo en el móvil y en el PC.</p>` : ''}
        <div class="btns"><button class="pri" data-pw="now">Sincronizar ahora</button><button data-pw="off">Desconectar</button><button data-pw="close">Cerrar</button></div>`
      : `<p>Tus datos se guardan en este dispositivo. Para tener lo mismo en el móvil y en el PC, conecta un token de GitHub: se guardan en un Gist secreto de tu cuenta que solo ves tú.</p>
        <p><b>Puedes usar el mismo token que en Clash Alerter.</b> Si no, créalo así:</p>
        <ol><li>Entra en <a href="https://github.com/settings/tokens/new?scopes=gist&description=Pun%C3%BAa" target="_blank" rel="noopener">github.com/settings/tokens/new</a> (token <i>classic</i>).</li>
        <li>Marca solo el permiso <b>gist</b> y en caducidad elige <b>No expiration</b>.</li>
        <li>Pulsa <b>Generate token</b>, cópialo y pégalo aquí.</li></ol>
        <input type="password" id="pwTok" placeholder="ghp_…" autocomplete="off">
        <div class="btns"><button class="pri" data-pw="on">Conectar</button><button data-pw="close">Cerrar</button></div>
        <p class="mut">El token se guarda solo en este dispositivo. Si ya tienes datos en el otro, se juntan sin perder nada.</p>`}
    </div>`;
  }
  function renderPanel() { const d = document.getElementById('pwSync'); if (d) d.innerHTML = panelHTML(); }
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

  const platform = {
    use: async name => ({ db: dbApi, user: userApi, assets: assetsApi, downloads: downloadsApi })[name] || null,
    sync: openPanel,
    restore,
    get syncOn() { return syncOn(); },
  };
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
