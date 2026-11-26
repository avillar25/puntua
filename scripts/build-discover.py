#!/usr/bin/env python3
"""Genera catalog/discover.json: el catálogo de la pestaña Descubrir.

- Pelis y series más votadas de IMDb (datos públicos de datasets.imdbws.com), con título en español de
  España cuando existe, año, duración, géneros y nota.
- Juegos con nota de Metacritic según Wikidata (los mejor valorados y más conocidos).
- Carteles: de la ficha de IMDb (pelis y series), TVmaze (series) y Metacritic (juegos). Se guardan en
  catalog/posters.json para no volver a buscarlos cada semana.

Lo ejecuta .github/workflows/update-catalog.yml. Si una fuente falla, se mantiene lo que había.
"""
import csv, gzip, io, json, pathlib, re, sys, time, urllib.parse, urllib.request, urllib.error

R = pathlib.Path(__file__).resolve().parent.parent
OUT = R / 'catalog' / 'discover.json'
POSTERS = R / 'catalog' / 'posters.json'
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'
N_MOVIES, N_SERIES, N_GAMES = 1500, 600, 400
MIN_VOTES_MOVIE, MIN_VOTES_SERIES = 40000, 15000
POSTER_BUDGET_S = 25 * 60   # como mucho 25 minutos buscando carteles nuevos en cada pasada

GEN = {'Action': 'Acción', 'Adventure': 'Aventura', 'Animation': 'Animación', 'Biography': 'Biografía', 'Comedy': 'Comedia',
       'Crime': 'Crimen', 'Documentary': 'Documental', 'Drama': 'Drama', 'Family': 'Familiar', 'Fantasy': 'Fantasía',
       'Film-Noir': 'Crimen', 'History': 'Historia', 'Horror': 'Terror', 'Music': 'Música', 'Musical': 'Musical',
       'Mystery': 'Misterio', 'Romance': 'Romance', 'Sci-Fi': 'Ciencia ficción', 'Sport': 'Deporte', 'Thriller': 'Suspense',
       'War': 'Bélica', 'Western': 'Western', 'Reality-TV': 'Reality', 'Game-Show': 'Concurso', 'Talk-Show': 'Entrevistas', 'News': 'Noticias'}
WD_GEN = [(r'terror|horror', 'Terror'), (r'disparos|shooter', 'Shooter'), (r'mundo abierto', 'Mundo abierto'),
          (r'rol de acci|action rpg', 'RPG de acción'), (r'rol|rpg', 'RPG'), (r'acci[oó]n-aventura', 'Acción-aventura'),
          (r'aventura', 'Aventura'), (r'acci[oó]n', 'Acción'), (r'plataformas', 'Plataformas'), (r'estrategia', 'Estrategia'),
          (r'lucha', 'Lucha'), (r'carreras|conducci', 'Conducción'), (r'simulaci', 'Simulación'), (r'deport', 'Deporte'),
          (r'supervivencia', 'Supervivencia'), (r'sigilo', 'Sigilo'), (r'puzle|rompecabezas', 'Puzle'), (r'metroidvania', 'Metroidvania'),
          (r'roguelike|roguelite', 'Roguelike'), (r'sandbox', 'Sandbox'), (r'musical|ritmo', 'Música')]


def log(*a):
    print(*a, flush=True)


def get(url, timeout=60, tries=2, headers=None):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8', **(headers or {})})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (404, 403, 410):
                return None
            if i == tries - 1:
                return None
            time.sleep(5)
        except Exception:
            if i == tries - 1:
                return None
            time.sleep(3)
    return None


def stream_tsv(name):
    req = urllib.request.Request('https://datasets.imdbws.com/' + name, headers={'User-Agent': UA})
    r = urllib.request.urlopen(req, timeout=900)
    f = gzip.open(r, 'rt', encoding='utf-8')
    next(f)
    return f


def build_imdb():
    log('IMDb: notas…')
    ratings = {}
    for line in stream_tsv('title.ratings.tsv.gz'):
        tt, avg, votes = line.rstrip('\n').split('\t')
        v = int(votes)
        if v >= MIN_VOTES_SERIES:
            ratings[tt] = (float(avg), v)
    log(f'IMDb: {len(ratings)} títulos con votos suficientes; leyendo fichas…')
    basics = {}
    for line in stream_tsv('title.basics.tsv.gz'):
        tt = line[:line.index('\t')]
        if tt not in ratings:
            continue
        p = line.rstrip('\n').split('\t')
        ty = p[1]
        if ty not in ('movie', 'tvSeries', 'tvMiniSeries') or p[4] == '1':
            continue
        if ty == 'movie' and ratings[tt][1] < MIN_VOTES_MOVIE:
            continue
        basics[tt] = {'type': 'movie' if ty == 'movie' else 'series', 'orig': p[3], 'title': p[2],
                      'year': int(p[5]) if p[5].isdigit() else None, 'end': int(p[6]) if p[6].isdigit() else None,
                      'runtime': int(p[7]) if p[7].isdigit() else None,
                      'genres': [GEN[g] for g in p[8].split(',') if g in GEN][:3]}
    # Las mejores: mezcla de votos (lo más visto) y nota
    def pick(kind, n):
        c = [tt for tt, b in basics.items() if b['type'] == kind]
        c.sort(key=lambda tt: -ratings[tt][1])
        return c[:n]
    chosen = set(pick('movie', N_MOVIES) + pick('series', N_SERIES))
    log(f'IMDb: {len(chosen)} elegidas; buscando títulos en España…')
    es = {}
    for line in stream_tsv('title.akas.tsv.gz'):
        tt = line[:line.index('\t')]
        if tt not in chosen:
            continue
        p = line.rstrip('\n').split('\t')
        # titleId ordering title region language types attributes isOriginalTitle
        if p[3] == 'ES' and p[2]:
            score = 2 if 'imdbDisplay' in p[5] else 1
            if 'working' in p[5] or 'alternative' in p[5] and score < 2:
                continue
            if tt not in es or score > es[tt][1]:
                es[tt] = (p[2], score)
    out = []
    for tt in chosen:
        b = basics[tt]
        title = es.get(tt, (None,))[0] or b['title']
        o = {'id': tt, 'type': b['type'], 'title': title, 'year': b['year'], 'genres': b['genres'],
             'r': ratings[tt][0], 'v': ratings[tt][1]}
        if b['orig'] and b['orig'] != title:
            o['orig'] = b['orig']
        if b['type'] == 'movie' and b['runtime']:
            o['runtime'] = b['runtime']
        if b['type'] == 'series' and b['runtime']:
            o['epRuntime'] = b['runtime']
        if b['type'] == 'series' and b['end']:
            o['end'] = b['end']
        out.append(o)
    log(f'IMDb: {len(out)} pelis y series listas')
    return out


def build_games():
    log('Wikidata: juegos con nota de Metacritic…')
    q = """SELECT ?it ?l ?score ?d ?links (GROUP_CONCAT(DISTINCT ?gl; separator="|") AS ?gs)
      (GROUP_CONCAT(DISTINCT ?pl; separator="|") AS ?ps) (SAMPLE(?dev) AS ?devl) (SAMPLE(?mc) AS ?mcid) WHERE {
      ?it wdt:P31 wd:Q7889; p:P444 ?st. ?st ps:P444 ?score; pq:P447 wd:Q150248.
      FILTER(REGEX(STR(?score), "^[0-9]+/100$"))
      ?it wikibase:sitelinks ?links. FILTER(?links >= 12)
      OPTIONAL { ?it wdt:P577 ?d. }
      OPTIONAL { ?it wdt:P1712 ?mc. }
      OPTIONAL { ?it wdt:P136 ?g. ?g rdfs:label ?gl. FILTER(LANG(?gl)="es") }
      OPTIONAL { ?it wdt:P400 ?p. ?p rdfs:label ?pl. FILTER(LANG(?pl)="es") }
      OPTIONAL { ?it wdt:P178 ?dv. ?dv rdfs:label ?dev. FILTER(LANG(?dev)="en") }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "es,en". ?it rdfs:label ?l. }
    } GROUP BY ?it ?l ?score ?d ?links"""
    b = get('https://query.wikidata.org/sparql?format=json&query=' + urllib.parse.quote(q), timeout=120, tries=3,
            headers={'Accept': 'application/sparql-results+json', 'User-Agent': 'PuntuaBot/1.0 (https://github.com/avillar25/puntua)'})
    if not b:
        log('Wikidata no respondió')
        return None
    by = {}
    for x in json.loads(b)['results']['bindings']:
        qid = x['it']['value'].split('/')[-1]
        sc = int(x['score']['value'].split('/')[0])
        o = by.get(qid)
        if o and o['ms'] >= sc:
            continue
        gs = (x.get('gs') or {}).get('value', '').split('|')
        genres = []
        for g in gs:
            for rx, name in WD_GEN:
                if re.search(rx, g.lower()):
                    if name not in genres:
                        genres.append(name)
                    break
        plat = [p.replace('PlayStation ', 'PS').replace('Microsoft Windows', 'PC') for p in (x.get('ps') or {}).get('value', '').split('|') if p]
        by[qid] = {'id': qid, 'type': 'game', 'title': x['l']['value'], 'ms': sc, 'r': round(sc / 10, 1),
                   'year': int(x['d']['value'][:4]) if x.get('d') else None, 'genres': genres[:3],
                   'platforms': ', '.join(dict.fromkeys(plat))[:120], 'creator': (x.get('devl') or {}).get('value', ''),
                   'links': int(x['links']['value']), 'mc': (x.get('mcid') or {}).get('value', '')}
    games = sorted(by.values(), key=lambda g: -(g['links'] * 0.6 + (g['ms'] - 70) * 3))[:N_GAMES]
    # Nombres: el servicio de etiquetas de la consulta a veces no los da; se piden aparte (español y, si no, inglés)
    ids = [g['id'] for g in games]
    names = {}
    for i in range(0, len(ids), 50):
        b2 = get('https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels&languages=es|en&ids=' + '|'.join(ids[i:i + 50]),
                 timeout=60, tries=3, headers={'User-Agent': 'PuntuaBot/1.0 (https://github.com/avillar25/puntua)'})
        if b2:
            for qid, ent in json.loads(b2).get('entities', {}).items():
                lb = ent.get('labels', {})
                n = (lb.get('es') or lb.get('en') or {}).get('value')
                if n:
                    names[qid] = n
        time.sleep(0.5)
    for g in games:
        if names.get(g['id']):
            g['title'] = names[g['id']]
    games = [g for g in games if not re.match(r'^Q\d+$', g['title'])]
    log(f'Wikidata: {len(games)} juegos')
    return games


def slugify(t):
    import unicodedata
    t = unicodedata.normalize('NFKD', t).encode('ascii', 'ignore').decode().lower().replace("'", '').replace('’', '').replace('&', 'and')
    return re.sub(r'[^a-z0-9]+', '-', t).strip('-')


def find_posters(items, posters, misses):
    t0 = time.time()
    new = 0
    retry_after = 14 * 86400
    for o in items:
        if o['id'] in posters or time.time() - t0 > POSTER_BUDGET_S:
            continue
        if time.time() - misses.get(o['id'], 0) < retry_after:
            continue
        url = None
        if o['type'] in ('movie', 'series'):
            # Buscador de IMDb (el mismo que usa su web al escribir): devuelve el cartel de cada título
            b = get(f"https://v3.sg.media-imdb.com/suggestion/x/{o['id']}.json", timeout=20, tries=1)
            if b:
                try:
                    for d in json.loads(b).get('d', []):
                        if d.get('id') == o['id'] and d.get('i', {}).get('imageUrl'):
                            url = re.sub(r'\._V1_.*?(\.\w+)$', r'._V1_QL75_UX380_\1', d['i']['imageUrl'])
                            break
                except Exception:
                    pass
            time.sleep(0.3)
        if not url and o['type'] == 'series':
            b = get('https://api.tvmaze.com/lookup/shows?imdb=' + o['id'], timeout=20, tries=1)
            if b:
                img = (json.loads(b).get('image') or {})
                url = img.get('medium') or img.get('original')
            time.sleep(0.6)
        if not url and o['type'] == 'game':
            slug = (o.get('mc') or '').split('/')[-1] or slugify(o['title'])
            b = get(f"https://www.metacritic.com/game/{slug}/", timeout=30, tries=1)
            if b:
                m = (re.search(rb'<meta[^>]+property="og:image"[^>]+content="([^"]+)"', b)
                     or re.search(rb'<meta[^>]+content="([^"]+)"[^>]+property="og:image"', b)
                     or re.search(rb'"image"\s*:\s*"(https:[^"]+)"', b))
                if m:
                    url = m.group(1).decode().replace('\\u002F', '/')
            time.sleep(1)
        if url:
            posters[o['id']] = url
            misses.pop(o['id'], None)
            new += 1
        else:
            misses[o['id']] = int(time.time())
    log(f'Carteles: {new} nuevos, {len(misses)} sin cartel por ahora')


def main():
    old = json.loads(OUT.read_text()) if OUT.exists() else {'items': []}
    pj = json.loads(POSTERS.read_text()) if POSTERS.exists() else {}
    posters, misses = (pj.get('ok', {}), pj.get('miss', {})) if 'ok' in pj else ({k: v for k, v in pj.items() if v}, {})
    if pj.get('v') != 4:   # nueva forma de buscar las portadas de los juegos: se reintentan
        misses = {k: t for k, t in misses.items() if not k.startswith('Q')}
    try:
        av = build_imdb()
    except Exception as e:
        log('IMDb falló:', e)
        av = [o for o in old['items'] if o['type'] != 'game']
    try:
        games = build_games()
    except Exception as e:
        log('Wikidata falló:', e)
        games = None
    if games is None:
        games = [o for o in old['items'] if o['type'] == 'game']
    items = av + games
    # Primero los carteles de lo más popular
    items.sort(key=lambda o: -(o.get('v', 0) / 1000 + o.get('links', 0) * 20))
    find_posters(items, posters, misses)
    for o in items:
        if posters.get(o['id']):
            o['img'] = posters[o['id']]
        o.pop('links', None)
    POSTERS.write_text(json.dumps({'v': 4, 'ok': posters, 'miss': misses}, separators=(',', ':'), sort_keys=True))
    OUT.write_text(json.dumps({'t': int(time.time()), 'items': items}, ensure_ascii=False, separators=(',', ':')))
    log(f'Descubrir: {len(items)} títulos, {sum(1 for o in items if o.get("img"))} con cartel')


if __name__ == '__main__':
    sys.exit(main())
