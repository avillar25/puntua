#!/usr/bin/env python3
"""Actualiza cada semana los datos externos del catálogo (src/meta.js) y genera catalog/imdb-ratings.json.

- Notas y votos de IMDb (datos públicos de IMDb: datasets.imdbws.com) para pelis y series.
- Duración de las pelis que no la tengan (IMDb).
- Series: si siguen en emisión, temporadas y capítulos, y próximos capítulos (TVmaze).
- Juegos: nota de Metacritic si la web responde (si no, se deja la que había).
- catalog/imdb-ratings.json: nota de IMDb de todo título con 1.000 votos o más, para rellenar fichas nuevas.

Lo ejecuta .github/workflows/update-catalog.yml. Si una fuente falla, se deja lo que había.
"""
import csv, gzip, io, json, pathlib, re, sys, time, unicodedata, urllib.request, urllib.error
from datetime import date, timedelta

R = pathlib.Path(__file__).resolve().parent.parent
META_JS = R / 'src' / 'meta.js'
TITLES = R / 'catalog' / 'titles.json'
RATINGS_OUT = R / 'catalog' / 'imdb-ratings.json'
TVIDS = R / 'catalog' / 'tvmaze-ids.json'
MCSLUGS = R / 'catalog' / 'metacritic-slugs.json'
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Puntua-catalog-updater'
csv.field_size_limit(10**7)


def log(*a):
    print(*a, flush=True)


def get(url, timeout=60, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code == 429 and i < tries - 1:
                time.sleep(10)
                continue
            if i == tries - 1:
                raise
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(3)
    return None


def load_meta():
    s = META_JS.read_text(encoding='utf-8').strip()
    s = s[s.index('=') + 1:].rstrip(';').strip()
    return json.loads(s)


def save_meta(m):
    META_JS.write_text('window.PUNTUA_META=' + json.dumps(m, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')


def imdb_ids(meta, titles):
    ids = {}
    for sec in ('movies', 'series'):
        for k, v in meta.get(sec, {}).items():
            if v.get('imdb'):
                ids[v['imdb']] = (sec, k)
    for k, v in titles.items():
        if v.get('imdbId') and v['imdbId'] not in ids:
            ids[v['imdbId']] = ('movies' if v.get('type') == 'movie' else 'series', k)
    return ids


def step_imdb(meta, titles):
    log('IMDb: descargando notas…')
    raw = get('https://datasets.imdbws.com/title.ratings.tsv.gz', timeout=300)
    want = imdb_ids(meta, titles)
    allr, n_upd = {}, 0
    with gzip.open(io.BytesIO(raw), 'rt', encoding='utf-8') as f:
        next(f)
        for line in f:
            tt, avg, votes = line.rstrip('\n').split('\t')
            votes = int(votes)
            if votes >= 1000:
                allr[tt] = float(avg)
            if tt in want:
                sec, k = want[tt]
                o = meta.setdefault(sec, {}).setdefault(k, {})
                if o.get('extRating') != float(avg):
                    n_upd += 1
                o['extRating'] = float(avg)
                o['extSrc'] = 'IMDb'
    RATINGS_OUT.write_text(json.dumps(allr, separators=(',', ':')), encoding='utf-8')
    log(f'IMDb: {n_upd} notas cambiadas; {len(allr)} títulos con 1.000+ votos en imdb-ratings.json')

    # Duración de las pelis que no la tienen (title.basics es grande: se lee en streaming)
    need = {v['imdb']: k for k, v in meta.get('movies', {}).items() if v.get('imdb') and not v.get('runtime')}
    if not need:
        return
    log(f'IMDb: buscando duración de {len(need)} pelis…')
    req = urllib.request.Request('https://datasets.imdbws.com/title.basics.tsv.gz', headers={'User-Agent': UA})
    found = 0
    with urllib.request.urlopen(req, timeout=600) as r, gzip.open(r, 'rt', encoding='utf-8') as f:
        next(f)
        for line in f:
            tt = line[:line.index('\t')]
            if tt in need:
                p = line.rstrip('\n').split('\t')
                if p[7].isdigit():
                    meta['movies'][need[tt]]['runtime'] = int(p[7])
                    found += 1
    log(f'IMDb: {found} duraciones añadidas')


def step_tvmaze(meta):
    ids = json.loads(TVIDS.read_text()) if TVIDS.exists() else {}
    series = meta.get('series', {})
    lo, hi = (date.today() - timedelta(days=45)).isoformat(), (date.today() + timedelta(days=120)).isoformat()
    done = 0
    for k, o in series.items():
        if o.get('air') == 'Ended' and o.get('seasonEps') and k in ids:
            continue   # terminadas y ya completas: no hace falta mirarlas cada semana
        try:
            tvid = ids.get(k)
            if not tvid and o.get('imdb'):
                b = get('https://api.tvmaze.com/lookup/shows?imdb=' + o['imdb'])
                if b:
                    tvid = json.loads(b)['id']
                    ids[k] = tvid
                time.sleep(0.6)
            if not tvid:
                continue
            b = get(f'https://api.tvmaze.com/shows/{tvid}?embed[]=episodes')
            time.sleep(0.6)
            if not b:
                continue
            sh = json.loads(b)
            eps = [e for e in sh.get('_embedded', {}).get('episodes', []) if e.get('season') and e.get('number')]
            se = {}
            for e in eps:
                se[str(e['season'])] = max(se.get(str(e['season']), 0), e['number'])
            if sh.get('status'):
                o['air'] = sh['status']
            old_total = sum(int(x) for x in (o.get('seasonEps') or {}).values())
            if se and sum(se.values()) >= old_total:
                o['seasonEps'] = se
                o['seasons'] = max(int(x) for x in se)
                o['epTotal'] = sum(se.values())
            up = [f"{e['season']}x{e['number']}@{e['airdate']}" for e in eps if e.get('airdate') and lo <= e['airdate'] <= hi]
            if up:
                o['upEps'] = up
            else:
                o.pop('upEps', None)
            o.pop('nextEp', None)
            done += 1
        except Exception as e:
            log('TVmaze', k, e)
    TVIDS.write_text(json.dumps(ids, indent=0, sort_keys=True))
    log(f'TVmaze: {done} series actualizadas')


def slugify(t):
    t = unicodedata.normalize('NFKD', t).encode('ascii', 'ignore').decode().lower()
    t = t.replace("'", '').replace('’', '').replace('&', 'and')
    return re.sub(r'[^a-z0-9]+', '-', t).strip('-')


def step_metacritic(meta, titles):
    slugs = json.loads(MCSLUGS.read_text()) if MCSLUGS.exists() else {}
    games = meta.get('games', {})
    ok = fail = 0
    for k, o in games.items():
        t = titles.get(k, {})
        slug = slugs.get(k) or slugify(t.get('title', ''))
        if not slug:
            continue
        try:
            b = get(f'https://www.metacritic.com/game/{slug}/', timeout=30, tries=1)
        except Exception:
            b = None
        time.sleep(1.5)
        if not b:
            fail += 1
            if fail >= 8 and ok == 0:
                log('Metacritic no responde desde GitHub: se dejan las notas que había')
                return
            continue
        m = re.search(rb'"aggregateRating"\s*:\s*\{[^}]*?"ratingValue"\s*:\s*"?(\d+)', b)
        if m:
            sc = int(m.group(1))
            o['metascore'] = sc
            o['extRating'] = round(sc / 10, 1)
            o['extSrc'] = 'Metacritic'
            slugs[k] = slug
            ok += 1
    MCSLUGS.write_text(json.dumps(slugs, indent=0, sort_keys=True))
    log(f'Metacritic: {ok} notas leídas, {fail} sin respuesta')


def main():
    meta = load_meta()
    titles = json.loads(TITLES.read_text(encoding='utf-8'))
    for name, fn in (('IMDb', lambda: step_imdb(meta, titles)), ('TVmaze', lambda: step_tvmaze(meta)), ('Metacritic', lambda: step_metacritic(meta, titles))):
        try:
            fn()
        except Exception as e:
            log(f'{name}: fallo ({e}); se deja lo que había')
    save_meta(meta)
    log('Listo')


if __name__ == '__main__':
    sys.exit(main())
