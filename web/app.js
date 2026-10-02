'use strict';

const PAGE_SIZE = 40;
const MIN_VOTES_FOR_TOP_RATED = 300;
const SUGGESTED = ['Frozen', 'The Dark Knight', 'Amélie', 'Se7en', 'Spirited Away', 'Before Sunrise'];

const state = {
  movies: [],
  byId: new Map(),
  genres: [],
  home: { genre: 'All', sort: 'popular', shown: PAGE_SIZE },
};

const app = document.getElementById('app');

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const normalize = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

const pad = (n) => String(n).padStart(2, '0');

const fmtRuntime = (min) => (min ? `${min} min` : null);

const byTitle = (title) => state.movies.find((m) => m.title === title);

// ---------- posters (optional, via /api/poster + TMDB) ----------
const posterCache = new Map();
let postersAvailable = true;

function readPosterCache() {
  try {
    const raw = localStorage.getItem('posterCache:v1');
    if (raw) Object.entries(JSON.parse(raw)).forEach(([k, v]) => posterCache.set(Number(k), v));
  } catch { /* storage unavailable */ }
}

let saveTimer;
function savePosterCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const entries = [...posterCache].filter(([, v]) => v && !(v instanceof Promise)).slice(-1500);
      localStorage.setItem('posterCache:v1', JSON.stringify(Object.fromEntries(entries)));
    } catch { /* storage full or unavailable */ }
  }, 500);
}

function fetchImages(id) {
  if (posterCache.has(id)) return Promise.resolve(posterCache.get(id));
  if (!postersAvailable) return Promise.resolve(null);
  const p = fetch(`/api/poster?id=${id}`)
    .then((r) => {
      // 404 = no API route (local static server); 501 = TMDB_API_KEY not configured
      if (r.status === 404 || r.status === 501) { postersAvailable = false; return null; }
      return r.ok ? r.json() : null;
    })
    .catch(() => null)
    .then((data) => {
      const value = data && data.poster ? data : null;
      posterCache.set(id, value);
      if (value) savePosterCache();
      return value;
    });
  posterCache.set(id, p);
  return p;
}

const observer = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      observer.unobserve(e.target);
      loadPoster(e.target);
    });
  }, { rootMargin: '300px' })
  : null;

function loadPoster(el) {
  Promise.resolve(fetchImages(Number(el.dataset.id))).then((img) => {
    if (!img || !img.poster) return;
    const image = new Image();
    image.alt = '';
    image.decoding = 'async';
    image.onload = () => image.classList.add('loaded');
    image.src = img.poster;
    el.appendChild(image);
  });
}

function observePosters(root) {
  root.querySelectorAll('.card[data-id]').forEach((el) => {
    if (observer) observer.observe(el); else loadPoster(el);
  });
}

// ---------- building blocks ----------
// A typographic title card, replaced by the real poster when one is available.
function cardHTML(m, { thumb = false } = {}) {
  if (thumb) {
    return `<div class="card card--thumb" data-id="${m.id}" aria-hidden="true">
      <div class="card-face"><span class="t">${esc(m.title.replace(/^(the|a|an) /i, '').charAt(0))}</span></div>
    </div>`;
  }
  return `<div class="card" data-id="${m.id}" aria-hidden="true">
    <div class="card-face">
      ${m.director.length ? `<span class="d">${esc(m.director[0])}</span>` : ''}
      <span class="t">${esc(m.title)}</span>
      ${m.year ? `<span class="y">${m.year}</span>` : ''}
    </div>
  </div>`;
}

function subline(m) {
  return [m.year, m.genres.slice(0, 2).join(', ')].filter(Boolean).map(esc).join(' · ');
}

function rowHTML(m, n) {
  return `<li><a href="#/movie/${m.id}">
    <span class="r-no">${pad(n)}</span>
    ${cardHTML(m, { thumb: true })}
    <span><span class="r-title">${esc(m.title)}</span><span class="r-sub">${subline(m)}</span></span>
    <span class="r-rating" title="TMDB rating">${m.votes ? `<i>★</i>${m.rating.toFixed(1)}` : '—'}</span>
  </a></li>`;
}

function simHTML(score, max) {
  const pct = Math.max(4, Math.round((score / max) * 100));
  return `<span class="sim mono" title="Cosine similarity ${score.toFixed(2)}">
    <span class="sim-bar"><i style="width:${pct}%"></i></span>${score.toFixed(2)}
  </span>`;
}

// ---------- home ----------
function homeList() {
  const { genre, sort } = state.home;
  let list = genre === 'All' ? state.movies : state.movies.filter((m) => m.genres.includes(genre));
  if (sort === 'top') {
    list = list.filter((m) => m.votes >= MIN_VOTES_FOR_TOP_RATED)
      .sort((a, b) => b.rating - a.rating || b.votes - a.votes);
  } else if (sort === 'new') {
    list = [...list].sort((a, b) => (b.year || '0').localeCompare(a.year || '0') || b.popularity - a.popularity);
  } else {
    list = [...list].sort((a, b) => b.popularity - a.popularity);
  }
  return list;
}

let heroSearch;

function renderHome({ keepHero = false } = {}) {
  document.body.classList.add('is-home');
  document.title = 'Double Feature';
  const { genre, sort, shown } = state.home;
  const list = homeList();
  const sorts = [['popular', 'Most popular'], ['top', 'Highest rated'], ['new', 'Newest']];

  const indexHTML = `
    <div class="index-head">
      <h2>${genre === 'All' ? 'The index' : esc(genre)}<small>${list.length.toLocaleString()} films</small></h2>
      <div class="toggles" role="group" aria-label="Sort">
        ${sorts.map(([k, label]) => `<button data-sort="${k}" aria-pressed="${k === sort}">${label}</button>`).join('')}
      </div>
    </div>
    <div class="genres toggles" role="group" aria-label="Filter by genre">
      ${['All', ...state.genres].map((g) => `<button data-genre="${esc(g)}" aria-pressed="${g === genre}">${esc(g)}</button>`).join('')}
    </div>
    <ol class="ledger">${list.slice(0, shown).map((m, i) => rowHTML(m, i + 1)).join('')}</ol>
    ${list.length > shown ? `<button class="more" id="more">Show the next ${Math.min(PAGE_SIZE, list.length - shown)}</button>` : ''}
  `;

  if (keepHero && document.getElementById('index')) {
    document.getElementById('index').innerHTML = indexHTML;
  } else {
    const picks = SUGGESTED.map(byTitle).filter(Boolean);
    app.innerHTML = `
      <section class="hero">
        <p class="kicker">${state.movies.length.toLocaleString()} films · TMDB 5000</p>
        <h1>Name a film you <em>love</em>.</h1>
        <p class="lede">You'll get the twelve films closest to it in story, genre, keywords, cast and director.</p>
        <div class="search search--hero" role="search">
          <input id="search-hero" type="search" placeholder="Start typing a title" autocomplete="off" aria-label="Search films"
                 role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="suggestions-hero">
          <ul id="suggestions-hero" class="suggestions" role="listbox" hidden></ul>
        </div>
        <p class="try"><span class="mono">Or try&nbsp;&nbsp;</span>${picks.map((m) => `<a href="#/movie/${m.id}">${esc(m.title)}</a>`).join('')}</p>
      </section>
      <section id="index">${indexHTML}</section>
    `;
    heroSearch = attachSearch(document.getElementById('search-hero'), document.getElementById('suggestions-hero'));
  }

  const index = document.getElementById('index');
  index.querySelectorAll('[data-genre]').forEach((b) => b.addEventListener('click', () => {
    const g = b.dataset.genre;
    state.home.genre = g;
    state.home.shown = PAGE_SIZE;
    history.replaceState(null, '', g === 'All' ? '#/' : `#/genre/${encodeURIComponent(g)}`);
    renderHome({ keepHero: true });
  }));
  index.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => {
    state.home.sort = b.dataset.sort;
    state.home.shown = PAGE_SIZE;
    renderHome({ keepHero: true });
  }));
  const more = document.getElementById('more');
  if (more) more.addEventListener('click', () => {
    state.home.shown += PAGE_SIZE;
    renderHome({ keepHero: true });
  });
  observePosters(index);
}

// ---------- film page ----------
function renderMovie(id) {
  document.body.classList.remove('is-home');
  const m = state.byId.get(id);
  if (!m) {
    document.title = 'Not found · Double Feature';
    app.innerHTML = `<div class="notfound"><h1>That film isn't in the index.</h1>
      <p><a href="#/">Back to the index</a></p></div>`;
    return;
  }
  document.title = `${m.title}${m.year ? ` (${m.year})` : ''} · Double Feature`;

  const facts = [
    m.year,
    fmtRuntime(m.runtime),
    m.votes ? `<span class="rating">★ ${m.rating.toFixed(1)}</span> <span>(${m.votes.toLocaleString()} votes)</span>` : null,
  ].filter(Boolean).map((f) => `<span>${f}</span>`).join('');

  const credits = [
    m.director.length ? `<dt>Directed by</dt><dd>${esc(m.director.join(', '))}</dd>` : '',
    m.cast.length ? `<dt>Starring</dt><dd>${esc(m.cast.join(', '))}</dd>` : '',
    m.genres.length ? `<dt>Genre</dt><dd class="genre-links">${m.genres.map((g) => `<a href="#/genre/${encodeURIComponent(g)}">${esc(g)}</a>`).join(', ')}</dd>` : '',
  ].join('');

  const recs = m.recs.map(([idx, score]) => [state.movies[idx], score]);
  const [best, bestScore] = recs[0];
  const max = bestScore || 1;
  const crumbGenre = m.genres[0];

  app.innerHTML = `
    <nav class="crumbs mono" aria-label="Breadcrumb">
      <a href="#/">Index</a>${crumbGenre ? `<span>/</span><a href="#/genre/${encodeURIComponent(crumbGenre)}">${esc(crumbGenre)}</a>` : ''}
    </nav>

    <article class="film">
      ${cardHTML(m)}
      <div>
        <h1>${esc(m.title)}</h1>
        <div class="facts mono">${facts}</div>
        ${m.overview ? `<p class="overview">${esc(m.overview)}</p>` : ''}
        ${credits ? `<dl class="credits">${credits}</dl>` : ''}
      </div>
    </article>

    <section class="bill">
      <h2>Make it a double feature</h2>
      <p class="note">The closest match to <em>${esc(m.title)}</em>, then the next eleven.</p>

      <div class="pick">
        <a href="#/movie/${best.id}" tabindex="-1">${cardHTML(best)}</a>
        <div>
          ${simHTML(bestScore, max)}
          <h3><a href="#/movie/${best.id}">${esc(best.title)}</a></h3>
          <p>${esc(best.overview)}</p>
          <a class="go" href="#/movie/${best.id}">${best.year ? `${best.year} · ` : ''}See this film</a>
        </div>
      </div>

      <ol class="ledger ledger--recs">
        ${recs.slice(1).map(([r, score], i) => `<li><a href="#/movie/${r.id}">
          <span class="r-no">${pad(i + 2)}</span>
          ${cardHTML(r, { thumb: true })}
          <span><span class="r-title">${esc(r.title)}</span><span class="r-sub">${subline(r)}</span></span>
          ${simHTML(score, max)}
        </a></li>`).join('')}
      </ol>
    </section>
  `;
  observePosters(app);
}

// ---------- routing ----------
function route() {
  topSearch.close();
  const hash = location.hash.replace(/^#/, '');
  const movie = hash.match(/^\/movie\/(\d+)/);
  const genre = hash.match(/^\/genre\/(.+)/);
  if (movie) {
    renderMovie(Number(movie[1]));
    window.scrollTo(0, 0);
    return;
  }
  const g = genre ? decodeURIComponent(genre[1]) : 'All';
  if (g !== state.home.genre && (g === 'All' || state.genres.includes(g))) {
    state.home.genre = g;
    state.home.shown = PAGE_SIZE;
  }
  renderHome();
  if (genre) document.getElementById('index').scrollIntoView();
  else window.scrollTo(0, 0);
}

// ---------- search ----------
function search(query) {
  const q = normalize(query);
  if (!q) return [];
  const scored = [];
  for (const m of state.movies) {
    const t = m._norm;
    let s;
    if (t === q) s = 0;
    else if (t.startsWith(q)) s = 1;
    else if (t.includes(` ${q}`)) s = 2;
    else if (t.includes(q)) s = 3;
    else continue;
    scored.push([s, -m.popularity, m]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return scored.slice(0, 8).map((x) => x[2]);
}

function highlight(title, query) {
  const q = query.trim();
  const i = title.toLowerCase().indexOf(q.toLowerCase());
  if (!q || i < 0) return esc(title);
  return `${esc(title.slice(0, i))}<mark>${esc(title.slice(i, i + q.length))}</mark>${esc(title.slice(i + q.length))}`;
}

function attachSearch(input, list) {
  let active = -1;
  let results = [];

  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function paintActive() {
    list.querySelectorAll('li[data-id]').forEach((li, i) => {
      li.setAttribute('aria-selected', String(i === active));
      if (i === active) li.scrollIntoView({ block: 'nearest' });
    });
    if (active >= 0) input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
  }

  function open() {
    const query = input.value;
    if (!query.trim()) { close(); return; }
    results = search(query);
    active = results.length ? 0 : -1;
    list.innerHTML = results.length
      ? results.map((m, i) => `
          <li id="${list.id}-${i}" role="option" data-id="${m.id}">
            <span class="s-title">${highlight(m.title, query)}</span>
            <span class="s-meta">${m.year || ''}</span>
          </li>`).join('')
      : '<li class="empty" role="option" aria-disabled="true">Nothing in the index by that name</li>';
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    paintActive();
  }

  function choose(m) {
    input.value = '';
    close();
    input.blur();
    location.hash = `#/movie/${m.id}`;
  }

  input.addEventListener('input', open);
  input.addEventListener('focus', open);
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && results.length) {
      e.preventDefault();
      active = (active + 1) % results.length;
      paintActive();
    } else if (e.key === 'ArrowUp' && results.length) {
      e.preventDefault();
      active = (active - 1 + results.length) % results.length;
      paintActive();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      choose(results[active]);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    e.preventDefault();
    choose(state.byId.get(Number(li.dataset.id)));
  });

  return { input, close };
}

const topSearch = attachSearch(document.getElementById('search-top'), document.getElementById('suggestions-top'));

document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  e.preventDefault();
  const onHome = document.body.classList.contains('is-home');
  (onHome && heroSearch ? heroSearch.input : topSearch.input).focus();
});

// ---------- boot ----------
async function init() {
  readPosterCache();
  // Probe the poster function once (Avatar) so the layout knows up front whether posters exist.
  const probe = Promise.race([
    Promise.resolve(fetchImages(19995)).then((img) => {
      if (img && img.poster) document.body.classList.add('has-posters');
    }),
    new Promise((resolve) => { setTimeout(resolve, 2500); }),
  ]);
  try {
    const res = await fetch('data/movies.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.movies = data.movies;
    const genres = new Set();
    for (const m of state.movies) {
      m._norm = normalize(m.title);
      state.byId.set(m.id, m);
      m.genres.forEach((g) => genres.add(g));
    }
    state.genres = [...genres].sort();
  } catch (err) {
    app.innerHTML = `<p class="status">Couldn't load the film index (${esc(err.message)}).
      Run python model/build_recommendations.py to generate web/data/movies.json.</p>`;
    return;
  }
  await probe;
  topSearch.input.disabled = false;
  window.addEventListener('hashchange', route);
  route();
}

init();
