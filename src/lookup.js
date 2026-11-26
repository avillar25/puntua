// Puntúa · rellenar la ficha al añadir un título.
// Series: TVmaze. Pelis y juegos: Wikidata. Nota de IMDb: archivo imdb-ratings.json que genera
// cada semana la tarea de GitHub (pelis y series con al menos 1.000 votos). No pone portadas.
(function () {
  'use strict';
  const GEN = {
    // TVmaze (inglés) y etiquetas habituales → géneros que usa Puntúa
    'action': 'Acción', 'adventure': 'Aventura', 'animation': 'Animación', 'anime': 'Anime', 'comedy': 'Comedia',
    'crime': 'Crimen', 'documentary': 'Documental', 'drama': 'Drama', 'family': 'Familiar', 'children': 'Infantil',
    'fantasy': 'Fantasía', 'history': 'Historia', 'horror': 'Terror', 'music': 'Música', 'musical': 'Musical',
    'mystery': 'Misterio', 'romance': 'Romance', 'science-fiction': 'Ciencia ficción', 'science fiction': 'Ciencia ficción',
    'sports': 'Deporte', 'thriller': 'Suspense', 'war': 'Bélica', 'western': 'Western', 'supernatural': 'Fantasía',
    'espionage': 'Suspense', 'legal': 'Drama', 'medical': 'Drama', 'food': 'Documental', 'nature': 'Naturaleza', 'travel': 'Documental',
  };
  // Wikidata en español: «película de terror», «cine de acción», «videojuego de rol»… → géneros de Puntúa
  const WD = [
    [/terror|horror/, 'Terror'], [/ciencia ficci/, 'Ciencia ficción'], [/acci[oó]n-aventura|accion aventura/, 'Acción-aventura'],
    [/acci[oó]n/, 'Acción'], [/aventura/, 'Aventura'], [/comedia/, 'Comedia'], [/drama/, 'Drama'], [/suspense|suspenso|thriller/, 'Suspense'],
    [/crimen|policiac|criminal|gánster|gangster/, 'Crimen'], [/misterio/, 'Misterio'], [/fantas/, 'Fantasía'], [/animaci|animad/, 'Animación'],
    [/anime/, 'Anime'], [/document/, 'Documental'], [/romántic|romance/, 'Romance'], [/bélic|guerra/, 'Bélica'], [/biogr/, 'Biografía'],
    [/hist[oó]ric/, 'Historia'], [/musical/, 'Musical'], [/m[uú]sic/, 'Música'], [/familia|infantil/, 'Familiar'], [/western|oeste/, 'Western'],
    [/disparos|shooter/, 'Shooter'], [/mundo abierto/, 'Mundo abierto'], [/rol de acci|action rpg|arpg/, 'RPG de acción'], [/rol|rpg/, 'RPG'],
    [/supervivencia/, 'Supervivencia'], [/plataformas/, 'Plataformas'], [/estrategia/, 'Estrategia'], [/lucha/, 'Lucha'],
    [/conducci|carreras/, 'Conducción'], [/simulaci/, 'Simulación'], [/deport/, 'Deporte'], [/f[uú]tbol/, 'Fútbol'], [/baloncesto/, 'Baloncesto'],
    [/metroidvania/, 'Metroidvania'], [/roguelike|roguelite/, 'Roguelike'], [/soulslike/, 'Soulslike'], [/puzle|rompecabezas/, 'Puzle'],
    [/sandbox/, 'Sandbox'], [/sigilo/, 'Sigilo'],
  ];
  const wdGenres = labels => { const out = []; for (const l of labels) { const s = String(l).toLowerCase(); for (const [re, g] of WD) if (re.test(s)) { if (!out.includes(g)) out.push(g); break; } } return out.slice(0, 4); };
  const strip = h => String(h || '').replace(/<[^>]+>/g, '').trim();

  async function getJSON(url, opt) { const r = await fetch(url, opt); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }

  let ratingsP = null;
  function imdbRating(tt) {
    if (!tt) return Promise.resolve(null);
    if (!ratingsP) ratingsP = fetch((window.PUNTUA_REMOTE || '') + 'imdb-ratings.json').catch(() => fetch('imdb-ratings.json')).then(r => r.ok ? r.json() : {}).catch(() => ({}));
    return ratingsP.then(m => { const v = m[tt]; return v == null ? null : (Array.isArray(v) ? v[0] : v); });
  }

  /* ---------- Series (TVmaze) ---------- */
  async function searchSeries(q) {
    const res = await getJSON('https://api.tvmaze.com/search/shows?q=' + encodeURIComponent(q));
    return res.slice(0, 8).map(({ show: s }) => ({
      key: 'tv:' + s.id, label: s.name,
      sub: [s.premiered && s.premiered.slice(0, 4), s.network && s.network.name || s.webChannel && s.webChannel.name, (s.genres || []).slice(0, 2).join(', ')].filter(Boolean).join(' · '),
      src: { kind: 'tv', id: s.id },
    }));
  }
  async function detailSeries(id) {
    const s = await getJSON('https://api.tvmaze.com/shows/' + id + '?embed[]=seasons&embed[]=crew');
    const emb = s._embedded || {};
    const seasons = (emb.seasons || []).filter(x => x.number > 0 && (x.episodeOrder || x.premiereDate)).length || null;
    const creator = (emb.crew || []).filter(c => /creator/i.test(c.type)).map(c => c.person && c.person.name).filter(Boolean).slice(0, 2).join(', ');
    const imdb = s.externals && s.externals.imdb;
    const genres = [...new Set((s.genres || []).map(g => GEN[g.toLowerCase()]).filter(Boolean))].slice(0, 4);
    const out = { title: s.name, year: s.premiered ? +s.premiered.slice(0, 4) : null, creator, seasons, genres, imdbId: imdb || null };
    const r = await imdbRating(imdb); if (r) { out.extRating = r; out.extSrc = 'IMDb'; }
    return out;
  }

  /* ---------- Pelis y juegos (Wikidata) ---------- */
  const SPARQL = 'https://query.wikidata.org/sparql?format=json&query=';
  async function searchWD(q, kind) {
    const cls = kind === 'game' ? 'wd:Q7889' : 'wd:Q11424';
    const qq = q.replace(/["\\]/g, ' ');
    const query = `SELECT ?it ?l ?y ?who WHERE {
      SERVICE wikibase:mwapi { bd:serviceParam wikibase:endpoint "www.wikidata.org"; wikibase:api "EntitySearch";
        mwapi:search "${qq}"; mwapi:language "es"; mwapi:limit "25". ?it wikibase:apiOutputItem mwapi:item. }
      ?it wdt:P31/wdt:P279? ${cls}.
      OPTIONAL { ?it wdt:P577 ?d. BIND(YEAR(?d) AS ?y) }
      OPTIONAL { ?it ${kind === 'game' ? 'wdt:P178' : 'wdt:P57'} ?p. ?p rdfs:label ?who. FILTER(LANG(?who)="es" || LANG(?who)="en") }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "es,en". ?it rdfs:label ?l. }
    } LIMIT 60`;
    const j = await getJSON(SPARQL + encodeURIComponent(query), { headers: { Accept: 'application/sparql-results+json' } });
    const by = new Map();
    for (const b of j.results.bindings) {
      const id = b.it.value.split('/').pop(); const o = by.get(id) || { id, l: b.l && b.l.value, y: null, who: '' };
      if (b.y && (!o.y || +b.y.value < o.y)) o.y = +b.y.value; if (b.who && !o.who) o.who = b.who.value;
      by.set(id, o);
    }
    return [...by.values()].slice(0, 8).map(o => ({ key: 'wd:' + o.id, label: o.l || o.id, sub: [o.y, o.who].filter(Boolean).join(' · '), src: { kind, id: o.id } }));
  }
  async function detailWD(id, kind) {
    const v = kind === 'game';
    const query = `SELECT ?l ?d ?dur ?imdb (GROUP_CONCAT(DISTINCT ?gl; separator="|") AS ?gs) (GROUP_CONCAT(DISTINCT ?wl; separator="|") AS ?ws) (GROUP_CONCAT(DISTINCT ?pl; separator="|") AS ?ps) WHERE {
      BIND(wd:${id} AS ?it)
      OPTIONAL { ?it wdt:P577 ?d. }
      OPTIONAL { ?it wdt:P2047 ?dur. }
      OPTIONAL { ?it wdt:P345 ?imdb. }
      OPTIONAL { ?it wdt:P136 ?g. ?g rdfs:label ?gl. FILTER(LANG(?gl)="es") }
      OPTIONAL { ?it ${v ? 'wdt:P178' : 'wdt:P57'} ?w. ?w rdfs:label ?wl. FILTER(LANG(?wl)="es" || LANG(?wl)="en") }
      ${v ? 'OPTIONAL { ?it wdt:P400 ?p. ?p rdfs:label ?pl. FILTER(LANG(?pl)="es") }' : ''}
      SERVICE wikibase:label { bd:serviceParam wikibase:language "es,en". ?it rdfs:label ?l. }
    } GROUP BY ?l ?d ?dur ?imdb ORDER BY ?d LIMIT 1`;
    const j = await getJSON(SPARQL + encodeURIComponent(query), { headers: { Accept: 'application/sparql-results+json' } });
    const b = j.results.bindings[0] || {};
    const val = k => b[k] && b[k].value;
    const ws = (val('ws') || '').split('|').filter(Boolean);
    const out = {
      title: val('l') || '', year: val('d') ? +val('d').slice(0, 4) : null,
      creator: [...new Set(ws)].slice(0, 2).join(', '), genres: wdGenres((val('gs') || '').split('|').filter(Boolean)),
    };
    if (!v) { if (val('dur')) out.runtime = Math.round(+val('dur')); out.imdbId = val('imdb') || null; const r = await imdbRating(out.imdbId); if (r) { out.extRating = r; out.extSrc = 'IMDb'; } }
    else {
      const plat = (val('ps') || '').split('|').filter(Boolean).map(p => p.replace(/^PlayStation /, 'PS').replace(/^Microsoft Windows$/, 'PC').replace(/^Nintendo Switch.*/, 'Switch').replace(/^Xbox Series X y Series S$|^Xbox Series X\/S$/, 'Xbox Series'));
      out.platforms = [...new Set(plat)].slice(0, 6).join(', ');
    }
    return out;
  }

  window.PuntuaLookup = {
    search: (type, q) => type === 'series' ? searchSeries(q) : searchWD(q, type === 'game' ? 'game' : 'movie'),
    detail: c => c.src.kind === 'tv' ? detailSeries(c.src.id) : detailWD(c.src.id, c.src.kind),
  };
})();
