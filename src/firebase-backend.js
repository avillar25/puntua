// Puntúa · capa de datos para la web y la APK (Firebase Auth + Firestore).
// Ofrece a la app la misma interfaz que tenía dentro de Claude: use('db'|'user'|'assets'|'downloads').
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, sendEmailVerification, signOut, setPersistence, browserLocalPersistence } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, collection,
  onSnapshot, setDoc, getDoc } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

const app = initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(app);
auth.languageCode = 'es';
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
  restore: () => offerRestore(true),
};
window.PuntuaFB = platform;

/* ---------- Pantallas de acceso: entrar, crear cuenta y verificar el correo ---------- */
const CSS = `
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
const pwField = (id, ph, ac) => `<div class="pw"><input type="password" id="${id}" placeholder="${ph}" autocomplete="${ac}"><button type="button" class="eye" data-eye="${id}">Mostrar</button></div>`;

function overlay() {
  let d = document.getElementById('fbLogin');
  if (!d) {
    if (!document.getElementById('fbCss')) { const st = document.createElement('style'); st.id = 'fbCss'; st.textContent = CSS; document.head.appendChild(st); }
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

function showLogin(prefill = '') {
  screen(`<h1>Puntúa</h1><p>Entra para ver tus pelis, series y juegos en cualquier dispositivo.</p>
    <label>Correo<input type="email" id="fbEmail" autocomplete="email" inputmode="email" value=""></label>
    <label>Contraseña${pwField('fbPass', '', 'current-password')}</label>
    <button class="btn pri" type="submit" id="fbGo">Entrar</button>
    <div class="fbrow"><button class="lnk" type="button" id="fbReset">He olvidado la contraseña</button>
    <button class="lnk" type="button" id="fbToNew">Crear cuenta</button></div>`,
  ($, msg, busy, form) => {
    $('fbEmail').value = prefill;
    form.onsubmit = ev => { ev.preventDefault(); msg('');
      const em = $('fbEmail').value.trim(), pw = $('fbPass').value;
      if (!EMAIL_RE.test(em)) return msg('Escribe un correo válido');
      if (!pw) return msg('Escribe la contraseña');
      busy($('fbGo'), async () => { try { await signInWithEmailAndPassword(auth, em, pw); } catch (e) { msg(nice(e)); } });
    };
    $('fbToNew').onclick = () => showSignup($('fbEmail').value.trim());
    $('fbReset').onclick = () => { const em = $('fbEmail').value.trim();
      if (!EMAIL_RE.test(em)) return msg('Escribe arriba tu correo y vuelve a pulsar');
      busy($('fbReset'), async () => { try { await sendPasswordResetEmail(auth, em); msg('Si hay una cuenta con ese correo, te llegará un enlace para cambiar la contraseña.', true); } catch (e) { msg(nice(e)); } });
    };
  });
}

function showSignup(prefill = '') {
  screen(`<h2>Crear cuenta</h2><p>Tus listas y notas quedarán guardadas en tu cuenta y podrás verlas en el móvil y en el PC.</p>
    <label>Correo<input type="email" id="fbEmail" autocomplete="email" inputmode="email"></label>
    <label>Contraseña${pwField('fbPass', '', 'new-password')}<span class="hint">Mínimo 8 caracteres, con letras y números.</span></label>
    <label>Repite la contraseña${pwField('fbPass2', '', 'new-password')}</label>
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
        try { const c = await createUserWithEmailAndPassword(auth, em, pw); await sendEmailVerification(c.user); }
        catch (e) { msg(nice(e)); }
      });
    };
    $('fbToLogin').onclick = () => showLogin($('fbEmail').value.trim());
  });
}

function showVerify(u) {
  screen(`<h2>Verifica tu correo</h2>
    <p>Te he enviado un correo a <b style="color:#f3efe8">${(u.email || '').replace(/[<>&"]/g, '')}</b> con un enlace para confirmar la cuenta. Ábrelo y vuelve aquí. Si no lo ves, mira en la carpeta de correo no deseado.</p>
    <button class="btn pri" type="submit" id="fbGo">Ya lo he verificado</button>
    <button class="btn sec" type="button" id="fbAgain">Reenviar el correo</button>
    <button class="lnk" type="button" id="fbOut">Usar otra cuenta</button>`,
  ($, msg, busy, form) => {
    form.onsubmit = ev => { ev.preventDefault(); msg('');
      busy($('fbGo'), async () => { try { await u.reload(); if (auth.currentUser.emailVerified) enter(auth.currentUser); else msg('Todavía no consta como verificado. Abre el enlace del correo y vuelve a probar.'); } catch (e) { msg(nice(e)); } });
    };
    $('fbAgain').onclick = () => busy($('fbAgain'), async () => { try { await sendEmailVerification(u); msg('Correo reenviado', true); } catch (e) { msg(nice(e)); } });
    $('fbOut').onclick = () => signOut(auth);
  });
}

/* ---------- Primera vez: cargar la copia de Puntúa (JSON o data.json de la copia completa) ---------- */
async function offerRestore(force) {
  const ref = doc(fs, 'users', uid, 'data', 'lists');
  let snap; try { snap = await getDoc(ref); } catch { return; }
  if (snap.exists() && !force) return;
  if (force && snap.exists() && !confirm('Esto sustituirá tus listas, notas y progreso actuales por los de la copia. ¿Seguir?')) return;
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
function enter(u) {
  if (started) return;
  started = true; uid = u.uid; email = u.email || '';
  const l = document.getElementById('fbLogin'); if (l) l.remove();
  window.__fbResolve(platform);
  setTimeout(offerRestore, 1500);
}
onAuthStateChanged(auth, u => {
  if (!u) { if (started) location.reload(); else showLogin(); return; }
  if (!u.emailVerified) { showVerify(u); return; }
  enter(u);
});
