#!/usr/bin/env python3
"""Pone carátula a las fichas del catálogo (catalog/titles.json) que no la tienen.

- Pelis y series: cartel de IMDb (por su código de IMDb, o buscando por título y año).
- Series sin cartel en IMDb: TVmaze.
- Juegos: portada de Metacritic.
No toca las carátulas que ya tienes. Lo que no encuentra se vuelve a intentar a los 30 días.
"""
import json, pathlib, re, sys, time, unicodedata, urllib.parse, urllib.request, urllib.error

R = pathlib.Path(__file__).resolve().parent.parent
TITLES = R / 'catalog' / 'titles.json'
MISS = R / 'catalog' / 'covers-miss.json'
SLUGS = R / 'catalog' / 'metacritic-slugs.json'
META_JS = R / 'src' / 'meta.js'
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'


def log(*a):
    print(*a, flush=True)


def get(url, timeout=25):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except Exception:
        return None


def fold(s):
    s = unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+', ' ', s).strip()


def slugify(t):
    t = unicodedata.normalize('NFKD', t).encode('ascii', 'ignore').decode().lower().replace("'", '').replace('’', '').replace('&', 'and')
    return re.sub(r'[^a-z0-9]+', '-', t).strip('-')


def big(url):
    return re.sub(r'\._V1_.*?(\.\w+)$', r'._V1_QL75_UX380_\1', url)


def imdb_by_id(tt):
    b = get(f'https://v3.sg.media-imdb.com/suggestion/x/{tt}.json')
    if not b:
        return None
    for d in json.loads(b).get('d', []):
        if d.get('id') == tt and (d.get('i') or {}).get('imageUrl'):
            return big(d['i']['imageUrl'])
    return None


def imdb_by_title(title, year, kind):
    q = fold(title)
    if not q:
        return None
    b = get('https://v3.sg.media-imdb.com/suggestion/x/' + urllib.parse.quote(q) + '.json')
    if not b:
        return None
    want = ('feature', 'movie', 'tvMovie') if kind == 'movie' else ('TV series', 'TV mini-series', 'tvSeries', 'tvMiniSeries')
    for d in json.loads(b).get('d', []):
        if not str(d.get('id', '')).startswith('tt') or not (d.get('i') or {}).get('imageUrl'):
            continue
        if d.get('qid') and d['qid'] not in want and d.get('q') not in want:
            continue
        if year and d.get('y') and abs(int(d['y']) - int(year)) > 1:
            continue
        return big(d['i']['imageUrl'])
    return None


def tvmaze(title):
    b = get('https://api.tvmaze.com/singlesearch/shows?q=' + urllib.parse.quote(title))
    if not b:
        return None
    img = json.loads(b).get('image') or {}
    return img.get('original') or img.get('medium')


def metacritic(slug):
    b = get(f'https://www.metacritic.com/game/{slug}/', timeout=30)
    if not b:
        return None
    m = (re.search(rb'<meta[^>]+property="og:image"[^>]+content="([^"]+)"', b)
         or re.search(rb'<meta[^>]+content="([^"]+)"[^>]+property="og:image"', b)
         or re.search(rb'"image"\s*:\s*"(https:[^"]+)"', b))
    return m.group(1).decode().replace('\\u002F', '/') if m else None


def main():
    titles = json.loads(TITLES.read_text(encoding='utf-8'))
    miss = json.loads(MISS.read_text()) if MISS.exists() else {}
    slugs = json.loads(SLUGS.read_text()) if SLUGS.exists() else {}
    s = META_JS.read_text(encoding='utf-8')
    meta = json.loads(s[s.index('=') + 1:].strip().rstrip(';'))
    now = time.time()
    found = tried = 0
    for k, t in titles.items():
        if t.get('imgUrl') or now - miss.get(k, 0) < 30 * 86400:
            continue
        ty = t.get('type')
        m = (meta.get('movies', {}).get(k) or meta.get('series', {}).get(k) or meta.get('games', {}).get(k) or {})
        tt = t.get('imdbId') or m.get('imdb')
        year = t.get('year') or m.get('year')
        url = None
        tried += 1
        if ty in ('movie', 'series'):
            if tt:
                url = imdb_by_id(tt)
            if not url:
                url = imdb_by_title(t.get('title', ''), year, ty)
            if not url and ty == 'series':
                url = tvmaze(t.get('title', ''))
            time.sleep(0.3)
        elif ty == 'game':
            name = re.sub(r'\s*\((PS\d|PS Vita|PC)\)$', '', t.get('title', ''))
            for slug in dict.fromkeys([slugs.get(k), slugify(name), slugify(re.sub(r'\s+(Remastered|Classic Edition|Remake)$', '', name, flags=re.I))]):
                if slug:
                    url = metacritic(slug)
                    time.sleep(1)
                    if url:
                        break
        if url:
            t['img'] = 'ext'
            t['imgUrl'] = url
            miss.pop(k, None)
            found += 1
        else:
            miss[k] = int(now)
    TITLES.write_text(json.dumps(titles, ensure_ascii=False, indent=0, sort_keys=True), encoding='utf-8')
    MISS.write_text(json.dumps(miss, indent=0, sort_keys=True))
    log(f'Carátulas del catálogo: {found} puestas de {tried} que faltaban')


if __name__ == '__main__':
    sys.exit(main())
