#!/usr/bin/env python3
"""Genera www/ (la web y lo que va dentro de la APK) a partir de src/ y catalog/."""
import json, pathlib, shutil
R = pathlib.Path(__file__).resolve().parent.parent
src, www = R / 'src', R / 'www'
if www.exists(): shutil.rmtree(www)
www.mkdir()

html = (src / 'app.html').read_text(encoding='utf-8')
head = ('<link rel="manifest" href="manifest.webmanifest">\n'
        '<meta name="theme-color" content="#0d0c0b">\n'
        '<link rel="icon" href="icon-192.png">\n<link rel="apple-touch-icon" href="icon-192.png">\n')
html = html.replace('<title>Puntúa</title>', '<title>Puntúa</title>\n' + head, 1)
boot = ('<script>window.PuntuaFBReady=new Promise(r=>window.__fbResolve=r);</script>\n'
        '<script src="firebase-config.js"></script>\n'
        '<script type="module" src="firebase-backend.js"></script>\n'
        '<script src="meta.js"></script>')
assert '<script src="meta.js"></script>' in html
html = html.replace('<script src="meta.js"></script>', boot, 1)
html = html.replace('</body>', "<script>if('serviceWorker' in navigator&&location.protocol==='https:'&&location.hostname!=='localhost')navigator.serviceWorker.register('sw.js')</script>\n</body>", 1)
(www / 'index.html').write_text(html, encoding='utf-8')

for f in ['meta.js', 'firebase-backend.js', 'firebase-config.js', 'manifest.webmanifest', 'sw.js', 'icon-192.png', 'icon-512.png']:
    shutil.copy(src / f, www / f)

# Catálogo: fichas base + importaciones preparadas
titles = json.loads((R / 'catalog' / 'titles.json').read_text(encoding='utf-8'))
imports = json.loads((R / 'catalog' / 'imports.json').read_text(encoding='utf-8'))
(www / 'catalog.json').write_text(json.dumps({'titles': titles, 'imports': imports}, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')

ver = (R / 'VERSION').read_text().strip()
sw = (www / 'sw.js').read_text().replace('__VERSION__', ver)
(www / 'sw.js').write_text(sw)
print(f'www/ listo · v{ver} · {len(titles)} fichas · {len(imports)} importaciones')
