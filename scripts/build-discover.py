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
      SERVICE wikibase:label { bd:serviceParam wikibase:language "es,en,mul". ?it rdfs:label ?l. }
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
    # Nombres: se piden aparte (español; si no, inglés; si no, el nombre común en todos los idiomas, «mul»)
    ids = [g['id'] for g in games]
    names = {}
    for i in range(0, len(ids), 50):
        b2 = get('https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels&languages=es|en|mul&ids=' + '|'.join(ids[i:i + 50]),
                 timeout=60, tries=3, headers={'User-Agent': 'PuntuaBot/1.0 (https://github.com/avillar25/puntua)'})
        if b2:
            for qid, ent in json.loads(b2).get('entities', {}).items():
                lb = ent.get('labels', {})
                n = (lb.get('es') or lb.get('en') or lb.get('mul') or {}).get('value')
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



WIKI_UA = {'User-Agent': 'PuntuaBot/1.0 (https://github.com/avillar25/puntua)'}


def sparql(q):
    b = get('https://query.wikidata.org/sparql?format=json&query=' + urllib.parse.quote(q), timeout=120, tries=3,
            headers={'Accept': 'application/sparql-results+json', **WIKI_UA})
    return json.loads(b)['results']['bindings'] if b else []


def pageviews(article, days=7):
    """Visitas de los últimos días a un artículo de la Wikipedia en inglés (dato público de Wikimedia)."""
    from datetime import date, timedelta
    end = date.today() - timedelta(days=1)
    start = end - timedelta(days=days - 1)
    url = ('https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/'
           + urllib.parse.quote(article.replace(' ', '_'), safe='') + f'/daily/{start:%Y%m%d}/{end:%Y%m%d}')
    b = get(url, timeout=20, tries=2, headers=WIKI_UA)
    if not b:
        return 0
    return sum(x.get('views', 0) for x in json.loads(b).get('items', []))


def add_popular(items, posters, misses):
    """«Popular ahora»: lo que más visitas tiene esta semana en Wikipedia, incluidos estrenos recientes y próximos."""
    from datetime import date, timedelta
    today = date.today()
    by_id = {o['id']: o for o in items}
    # 1) Artículo de Wikipedia de lo que ya hay en Descubrir
    art = {}
    imdb = [o['id'] for o in items if o['id'].startswith('tt')]
    for i in range(0, len(imdb), 300):
        vals = ' '.join(f'"{x}"' for x in imdb[i:i + 300])
        for b in sparql(f'SELECT ?imdb ?a WHERE {{ VALUES ?imdb {{ {vals} }} ?it wdt:P345 ?imdb. ?a schema:about ?it; schema:isPartOf <https://en.wikipedia.org/>. }}'):
            art[b['imdb']['value']] = b['a']['value'].split('/wiki/')[-1]
    qids = [o['id'] for o in items if o['id'].startswith('Q')]
    for i in range(0, len(qids), 300):
        vals = ' '.join('wd:' + x for x in qids[i:i + 300])
        for b in sparql(f'SELECT ?it ?a WHERE {{ VALUES ?it {{ {vals} }} ?a schema:about ?it; schema:isPartOf <https://en.wikipedia.org/>. }}'):
            art[b['it']['value'].split('/')[-1]] = b['a']['value'].split('/wiki/')[-1]
    # 2) Estrenos recientes y próximos que aún no están (pelis, series y juegos)
    lo_f, hi_f = (today - timedelta(days=90)).isoformat(), (today + timedelta(days=200)).isoformat()
    lo_g, hi_g = (today - timedelta(days=150)).isoformat(), (today + timedelta(days=500)).isoformat()
    cand = []
    for kind, cls, lo, hi, minlinks in (('movie', 'wd:Q11424', lo_f, hi_f, 15), ('series', 'wd:Q5398426', lo_f, hi_f, 12), ('game', 'wd:Q7889', lo_g, hi_g, 10)):
        q = f"""SELECT ?it ?d ?imdb ?a ?links (SAMPLE(?es) AS ?les) (SAMPLE(?en) AS ?len) WHERE {{
          ?it wdt:P31 {cls}; wikibase:sitelinks ?links. FILTER(?links >= {minlinks})
          ?it {'wdt:P580|wdt:P577' if kind == 'series' else 'wdt:P577'} ?d. FILTER(?d >= "{lo}"^^xsd:dateTime && ?d <= "{hi}"^^xsd:dateTime)
          ?a schema:about ?it; schema:isPartOf <https://en.wikipedia.org/>.
          OPTIONAL {{ ?it wdt:P345 ?imdb. }}
          OPTIONAL {{ ?it rdfs:label ?es. FILTER(LANG(?es)="es") }} OPTIONAL {{ ?it rdfs:label ?en. FILTER(LANG(?en)="en" || LANG(?en)="mul") }}
        }} GROUP BY ?it ?d ?imdb ?a ?links ORDER BY DESC(?links) LIMIT 150"""
        for b in sparql(q):
            qid = b['it']['value'].split('/')[-1]
            tt = (b.get('imdb') or {}).get('value', '')
            oid = tt if (kind != 'game' and tt.startswith('tt')) else qid
            name = (b.get('les') or b.get('len') or {}).get('value')
            if not name:
                continue
            d = b['d']['value'][:10]
            if oid not in by_id:
                o = {'id': oid, 'type': kind, 'title': name, 'year': int(d[:4]), 'genres': [], 'new': 1}
                if d > today.isoformat():
                    o['up'] = d
                by_id[oid] = o
                cand.append(o)
            elif d > today.isoformat():
                by_id[oid]['up'] = d
            art.setdefault(oid, b['a']['value'].split('/wiki/')[-1])
    log(f'Popular: {len(art)} artículos de Wikipedia; {len(cand)} estrenos nuevos')
    # 3) Visitas de esta semana (primero de los candidatos con más opciones)
    hot = {}
    for oid, a in art.items():
        hot[oid] = pageviews(urllib.parse.unquote(a))
        time.sleep(0.03)
    for o in by_id.values():
        o.pop('hot', None)
        o.pop('pop', None)
        if hot.get(o['id']):
            o['hot'] = hot[o['id']]
    for kind in ('movie', 'series', 'game'):
        top = sorted([o for o in by_id.values() if o['type'] == kind and o.get('hot')], key=lambda o: -o['hot'])[:24]
        for i, o in enumerate(top):
            o['pop'] = i + 1
    # Estrenos nuevos: solo se quedan los que entran en «Popular ahora»
    keep = [o for o in cand if o.get('pop')]
    find_posters(keep, posters, misses)
    for o in keep:
        if posters.get(o['id']):
            o['img'] = posters[o['id']]
    items.extend(keep)
    log(f'Popular: {sum(1 for o in items if o.get("pop"))} títulos marcados como populares')


def main():
    old = json.loads(OUT.read_text()) if OUT.exists() else {'items': []}
    pj = json.loads(POSTERS.read_text()) if POSTERS.exists() else {}
    posters, misses = (pj.get('ok', {}), pj.get('miss', {})) if 'ok' in pj else ({k: v for k, v in pj.items() if v}, {})
    if pj.get('v') != 4:   # nueva forma de buscar las portadas de los juegos: se reintentan
        misses = {k: t for k, t in misses.items() if not k.startswith('Q')}
    if '--popular' in sys.argv:
        # Pasada diaria rápida: solo «Popular ahora» sobre el catálogo que ya hay
        items = [o for o in old['items'] if not o.get('new')]
    else:
        try:
            av = build_imdb()
        except Exception as e:
            log('IMDb falló:', e)
            av = [o for o in old['items'] if o['type'] != 'game' and not o.get('new')]
        try:
            games = build_games()
        except Exception as e:
            log('Wikidata falló:', e)
            games = None
        if games is None:
            games = [o for o in old['items'] if o['type'] == 'game' and not o.get('new')]
        items = av + games
        # Primero los carteles de lo más popular
        items.sort(key=lambda o: -(o.get('v', 0) / 1000 + o.get('links', 0) * 20))
        find_posters(items, posters, misses)
        for o in items:
            if posters.get(o['id']):
                o['img'] = posters[o['id']]
            o.pop('links', None)
    try:
        add_popular(items, posters, misses)
    except Exception as e:
        log('Popular falló:', e)
    POSTERS.write_text(json.dumps({'v': 4, 'ok': posters, 'miss': misses}, separators=(',', ':'), sort_keys=True))
    OUT.write_text(json.dumps({'t': int(time.time()), 'items': items}, ensure_ascii=False, separators=(',', ':')))
    log(f'Descubrir: {len(items)} títulos, {sum(1 for o in items if o.get("img"))} con cartel')


if __name__ == '__main__':
    sys.exit(main())
