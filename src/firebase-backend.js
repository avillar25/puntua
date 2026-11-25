// Puntúa · capa de datos para la web y la APK (Firebase Auth + Firestore).
// Ofrece a la app la misma interfaz que tenía dentro de Claude: use('db'|'user'|'assets'|'downloads').
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, signOut, setPersistence, browserLocalPersistence } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, collection,
  onSnapshot, setDoc, getDoc } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

const app = initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(app);
const fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

// En la APK (Capacitor) las imágenes no van dentro: se cargan de la web publicada
const IN_APP = location.hostname === 'localhost' || location.protocol === 'capacitor:';
const SITE = 'https://avillar25.github.io/puntua/';
const IMG_BASE = IN_APP ? SITE : '';

let uid = null, email = '';

/* ---------- Catálogo base (del repositorio) + cambios del usuario (Firestore) ---------- */
let catalogP = null;
function catalog() {
  if (!catalogP) catalogP = fetch('catalog.json', { cache: 'no-cache' }).then(r => r.json()).catch(() => ({ titles: {}, imports: [] }));
  return catalogP;
}
function fixImg(t) {
  if (t && t.img && t.imgUrl && !/^data:|^https?:/.test(t.imgUrl)) return { ...t, imgUrl: IMG_BASE + t.imgUrl };
  return t;
}
function fakeSnap(entries, fromCache) {
  return { docs: entries.map(([id, v]) => ({ id, data: () => v })), metadata: { fromCache: !!fromCache } };
}
function fakeDoc(d) {
  return { exists: d.exists(), data: () => d.data(), metadata: d.metadata };
}

// Rutas de la app → rutas de Firestore
function mapPath(p) {
  const s = p.split('/');
  if (s[0] === 'titles') return ['users', uid, 'titles', ...s.slice(1)];
  if (s[0] === 'data' && s[1] === 'users') return ['users', s[2], 'data', s[3] || 'lists'];
  return s; // reviews, reviews/{uid}
}

const dbApi = {
  doc(path) {
    const ref = doc(fs, ...mapPath(path));
    const isTitle = path.startsWith('titles/');
    return {
      set: body => setDoc(ref, body),
      // Borrar una ficha del catálogo base: se guarda una marca para ocultarla
      delete: () => isTitle ? setDoc(ref, { deleted: true }) : setDoc(ref, {}),
      onSnapshot: (cb, err) => onSnapshot(ref, { includeMetadataChanges: true }, d => cb(fakeDoc(d)), err),
    };
  },
  collection(path) {
    return {
      onSnapshot(cb, err) {
        if (path === 'imports') {
          catalog().then(c => cb(fakeSnap((c.imports || []).map(i => [i.id, i]), false)));
          return () => {};
        }
        if (path === 'titles') {
          let over = null, base = null, fromCache = true;
          const emit = () => {
            if (!base || !over) return;
            const m = { ...base };
            for (const [id, v] of Object.entries(over)) { if (v && v.deleted) delete m[id]; else m[id] = v; }
            cb(fakeSnap(Object.entries(m).map(([id, v]) => [id, fixImg(v)]), fromCache));
          };
          catalog().then(c => { base = c.titles || {}; emit(); });
          return onSnapshot(collection(fs, 'users', uid, 'titles'), { includeMetadataChanges: true }, snap => {
            over = {}; snap.docs.forEach(d => { over[d.id] = d.data(); }); fromCache = snap.metadata.fromCache; emit();
          }, e => { over = {}; emit(); err && err(e); });
        }
        return onSnapshot(collection(fs, ...mapPath(path)), { includeMetadataChanges: true },
          snap => cb({ docs: snap.docs.map(d => ({ id: d.id, data: () => d.data() })), metadata: snap.metadata }), err);
      },
    };
  },
};

const userApi = {
  id: async () => uid,
  isOwner: () => true,
  can: async () => true,
  profiles: async ids => Object.fromEntries(ids.map(i => [i, { name: i === uid ? email : '' }])),
};

// Imágenes subidas desde la app: se reducen y se guardan dentro de la ficha (Firestore)
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
    return { id: 'fs-' + Date.now().toString(36), url };
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

const platform = {
  use: async name => ({ db: dbApi, user: userApi, assets: assetsApi, downloads: downloadsApi })[name] || null,
  signOut: () => signOut(auth).then(() => location.reload()),
  get email() { return email; },
};
window.PuntuaFB = platform;

/* ---------- Pantalla de acceso ---------- */
const CSS = `
#fbLogin{position:fixed;inset:0;z-index:9999;background:#0d0c0b;color:#f3efe8;display:flex;align-items:center;justify-content:center;padding:20px;font-family:system-ui,sans-serif}
#fbLogin .box{width:100%;max-width:360px;display:flex;flex-direction:column;gap:12px}
#fbLogin h1{font-size:34px;margin:0 0 4px;letter-spacing:-.02em}
#fbLogin p{margin:0;color:#b9b2a7;font-size:14px;line-height:1.4}
#fbLogin input{font:inherit;font-size:16px;padding:12px 14px;border-radius:10px;border:1px solid #3a3631;background:#1a1816;color:inherit}
#fbLogin button{font:inherit;font-size:16px;font-weight:600;padding:12px 14px;border-radius:10px;border:0;cursor:pointer}
#fbLogin .pri{background:#f5b301;color:#1a1400}
#fbLogin .sec{background:transparent;color:#f3efe8;border:1px solid #3a3631}
#fbLogin .lnk{background:none;color:#b9b2a7;font-weight:400;font-size:14px;padding:4px}
#fbLogin .msg{min-height:20px;font-size:14px;color:#ff8a7a}
#fbLogin .msg.ok{color:#9be29b}`;
function showLogin() {
  if (document.getElementById('fbLogin')) return;
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const d = document.createElement('div'); d.id = 'fbLogin';
  d.innerHTML = `<form class="box"><h1>Puntúa</h1><p>Entra con tu cuenta para ver tus listas en cualquier dispositivo.</p>
    <input type="email" id="fbEmail" placeholder="Correo" autocomplete="email" required>
    <input type="password" id="fbPass" placeholder="Contraseña (mín. 6)" autocomplete="current-password" required minlength="6">
    <div class="msg" id="fbMsg"></div>
    <button class="pri" type="submit">Entrar</button>
    <button class="sec" type="button" id="fbNew">Crear cuenta</button>
    <button class="lnk" type="button" id="fbReset">He olvidado la contraseña</button></form>`;
  document.body.appendChild(d);
  const $ = id => d.querySelector('#' + id), msg = (t, ok) => { $('fbMsg').textContent = t; $('fbMsg').className = 'msg' + (ok ? ' ok' : ''); };
  const nice = e => ({ 'auth/invalid-credential': 'Correo o contraseña incorrectos', 'auth/email-already-in-use': 'Ya existe una cuenta con ese correo',
    'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres', 'auth/invalid-email': 'Correo no válido',
    'auth/network-request-failed': 'Sin conexión', 'auth/too-many-requests': 'Demasiados intentos, espera un poco',
    'auth/admin-restricted-operation': 'No se pueden crear cuentas nuevas' })[e.code] || (e.message || String(e));
  d.querySelector('form').onsubmit = async ev => { ev.preventDefault(); msg('');
    try { await signInWithEmailAndPassword(auth, $('fbEmail').value.trim(), $('fbPass').value); } catch (e) { msg(nice(e)); } };
  $('fbNew').onclick = async () => { msg('');
    try { await createUserWithEmailAndPassword(auth, $('fbEmail').value.trim(), $('fbPass').value); } catch (e) { msg(nice(e)); } };
  $('fbReset').onclick = async () => { const em = $('fbEmail').value.trim(); if (!em) return msg('Escribe tu correo arriba');
    try { await sendPasswordResetEmail(auth, em); msg('Te he enviado un correo para cambiarla', true); } catch (e) { msg(nice(e)); } };
}

/* ---------- Primera vez: cargar la copia de Puntúa (JSON o data.json de la copia completa) ---------- */
async function offerRestore() {
  const ref = doc(fs, 'users', uid, 'data', 'lists');
  let snap; try { snap = await getDoc(ref); } catch { return; }
  if (snap.exists()) return;
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:80px;z-index:9000;background:#1f1c19;color:#f3efe8;border:1px solid #f5b301;border-radius:14px;padding:14px;font:15px system-ui;display:flex;flex-direction:column;gap:10px;box-shadow:0 10px 30px rgba(0,0,0,.5)';
  bar.innerHTML = `<b>¿Primera vez aquí?</b><span>Carga tu copia de Puntúa (el archivo <i>.json</i>) para recuperar tus listas, notas y progreso.</span>
    <div style="display:flex;gap:8px"><label style="flex:1;text-align:center;background:#f5b301;color:#1a1400;font-weight:600;border-radius:10px;padding:10px;cursor:pointer">Elegir archivo<input type="file" accept=".json,application/json" hidden></label>
    <button style="background:none;border:1px solid #3a3631;color:inherit;border-radius:10px;padding:10px 14px;font:inherit">Ahora no</button></div>`;
  document.body.appendChild(bar);
  bar.querySelector('button').onclick = () => bar.remove();
  bar.querySelector('input').onchange = async ev => {
    const f = ev.target.files[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (!j.lists) throw new Error('Este archivo no es una copia de Puntúa');
      const mine = j.reviews && j.me && j.reviews[j.me] ? j.reviews[j.me] : (j.reviews && !j.me ? j.reviews : {});
      await setDoc(doc(fs, 'reviews', uid), { items: mine || {}, eps: {} });
      await setDoc(ref, j.lists);
      bar.innerHTML = '<b>Copia cargada ✔</b>'; setTimeout(() => bar.remove(), 2500);
    } catch (e) { alert('No se pudo cargar: ' + (e.message || e)); }
  };
}

/* ---------- Arranque ---------- */
setPersistence(auth, browserLocalPersistence).catch(() => {});
let started = false;
onAuthStateChanged(auth, u => {
  if (!u) { showLogin(); return; }
  if (started) return;
  started = true; uid = u.uid; email = u.email || '';
  const l = document.getElementById('fbLogin'); if (l) l.remove();
  window.__fbResolve(platform);
  setTimeout(offerRestore, 1500);
});
