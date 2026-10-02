'use strict';

const PAGE_SIZE = 30;
const MIN_VOTES_FOR_TOP_RATED = 300;

const state = {
  movies: [],
  byId: new Map(),
  genres: [],
  home: { genre: 'All', sort: 'popular', shown: PAGE_SIZE },
};

const app = document.getElementById('app');
const searchInput = document.getElementById('search');
const suggestionsEl = document.getElementById('suggestions');

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const normalize = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

const hue = (id) => (id * 47) % 360;

const fmtRuntime = (min) => (min ? `${Math.floor(min / 60)}h ${min % 60}m` : null);

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
      const value = data && (data.poster || data.backdrop) ? data : null;
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
  const id = Number(el.dataset.id);
  Promise.resolve(fetchImages(id)).then((img) => {
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
  root.querySelectorAll('.poster[data-id]').forEach((el) => {
    if (observer) observer.observe(el); else loadPoster(el);
  });
}

// ---------- rendering ----------
function posterHTML(m, badge = true) {
  return `
    <div class="poster" data-id="${m.id}" style="--h:${hue(m.id)}">
      ${badge && m.votes ? `<span class="badge"><span class="star">★</span> ${m.rating.toFixed(1)}</span>` : ''}
      <div class="poster-fallback">${esc(m.title)}${m.year ? `<small>${m.year}</small>` : ''}</div>
    </div>`;
}

function cardHTML(m, score) {
  const meta = [
    m.year ? `<span>${m.year}</span>` : '',
    score != null ? `<span class="match">${Math.round(score * 100)}% match</span>`
      : (m.genres[0] ? `<span>${esc(m.genres[0])}</span>` : ''),
  ].join('');
  return `
    <a class="card" href="#/movie/${m.id}" title="${esc(m.title)}">
      ${posterHTML(m)}
      <div class="card-title">${esc(m.title)}</div>
      <div class="card-meta">${meta}</div>
    </a>`;
}

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

function renderHome() {
  document.title = 'CineMatch — Movie Recommender';
  const { genre, sort, shown } = state.home;
  const list = homeList();
  const sorts = [['popular', 'Popular'], ['top', 'Top rated'], ['new', 'Newest']];

  app.innerHTML = `
    <section class="intro">
      <h1>Pick a movie you love.<br><span>We'll find what to watch next.</span></h1>
      <p>Search above or choose any title below. Recommendations compare plot, genres, keywords,
         cast and director across ${state.movies.length.toLocaleString()} movies.</p>
    </section>

    <div class="chips" role="group" aria-label="Filter by genre">
      ${['All', ...state.genres].map((g) => `
        <button class="chip" data-genre="${esc(g)}" aria-pressed="${g === genre}">${esc(g)}</button>`).join('')}
    </div>

    <div class="section-head">
      <h2>${genre === 'All' ? 'Browse' : esc(genre)} <span class="hint">· ${list.length.toLocaleString()} movies</span></h2>
      <div class="sort" role="group" aria-label="Sort">
        ${sorts.map(([k, label]) => `
          <button class="chip" data-sort="${k}" aria-pressed="${k === sort}">${label}</button>`).join('')}
      </div>
    </div>

    <div class="grid">${list.slice(0, shown).map((m) => cardHTML(m)).join('')}</div>
    ${list.length > shown ? '<div class="more-wrap"><button class="btn" id="more">Show more</button></div>' : ''}
  `;

  app.querySelectorAll('[data-genre]').forEach((b) => b.addEventListener('click', () => {
    const g = b.dataset.genre;
    state.home.genre = g;
    state.home.shown = PAGE_SIZE;
    history.replaceState(null, '', g === 'All' ? '#/' : `#/genre/${encodeURIComponent(g)}`);
    renderHome();
  }));
  app.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => {
    state.home.sort = b.dataset.sort;
    state.home.shown = PAGE_SIZE;
    renderHome();
  }));
  const more = document.getElementById('more');
  if (more) more.addEventListener('click', () => {
    const y = window.scrollY;
    state.home.shown += PAGE_SIZE;
    renderHome();
    window.scrollTo(0, y);
  });
  observePosters(app);
}

function renderMovie(id) {
  const m = state.byId.get(id);
  if (!m) {
    app.innerHTML = '<div class="error">Movie not found. <a class="back" href="#/">← Back to browse</a></div>';
    return;
  }
  document.title = `${m.title}${m.year ? ` (${m.year})` : ''} — CineMatch`;
  const facts = [
    m.votes ? `<span class="rating"><span class="star">★</span> ${m.rating.toFixed(1)} <span style="color:var(--text-dim);font-weight:400">(${m.votes.toLocaleString()})</span></span>` : '',
    m.year ? `<span>${m.year}</span>` : '',
    fmtRuntime(m.runtime) ? `<span>${fmtRuntime(m.runtime)}</span>` : '',
  ].filter(Boolean).join('');
  const people = [
    m.director.length ? `<dt>Director</dt><dd>${esc(m.director.join(', '))}</dd>` : '',
    m.cast.length ? `<dt>Starring</dt><dd>${esc(m.cast.join(', '))}</dd>` : '',
  ].join('');

  app.innerHTML = `
    <a class="back" href="#/">← Browse all movies</a>
    <article class="hero">
      <div class="hero-backdrop" aria-hidden="true"></div>
      <div class="hero-inner">
        ${posterHTML(m, false)}
        <div>
          <h1>${esc(m.title)}</h1>
          <div class="facts">${facts}</div>
          <div class="genre-tags">${m.genres.map((g) => `<a href="#/genre/${encodeURIComponent(g)}">${esc(g)}</a>`).join('')}</div>
          ${m.overview ? `<p class="overview">${esc(m.overview)}</p>` : ''}
          ${people ? `<dl class="people">${people}</dl>` : ''}
        </div>
      </div>
    </article>

    <div class="section-head">
      <h2>Because you like ${esc(m.title)}</h2>
      <span class="hint">Most similar movies</span>
    </div>
    <div class="grid">
      ${m.recs.map(([idx, score]) => cardHTML(state.movies[idx], score)).join('')}
    </div>
  `;

  Promise.resolve(fetchImages(m.id)).then((img) => {
    const bd = app.querySelector('.hero-backdrop');
    if (!img || !img.backdrop || !bd) return;
    const pre = new Image();
    pre.onload = () => { bd.style.backgroundImage = `url("${img.backdrop}")`; bd.classList.add('loaded'); };
    pre.src = img.backdrop;
  });
  observePosters(app);
}

// ---------- routing ----------
function route() {
  closeSuggestions();
  const hash = location.hash.replace(/^#/, '');
  const movie = hash.match(/^\/movie\/(\d+)/);
  const genre = hash.match(/^\/genre\/(.+)/);
  if (movie) {
    renderMovie(Number(movie[1]));
  } else {
    const g = genre ? decodeURIComponent(genre[1]) : 'All';
    if (g !== state.home.genre && (g === 'All' || state.genres.includes(g))) {
      state.home.genre = g;
      state.home.shown = PAGE_SIZE;
    }
    renderHome();
  }
  window.scrollTo(0, 0);
}

// ---------- search ----------
let activeIndex = -1;
let currentResults = [];

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

function renderSuggestions() {
  const query = searchInput.value;
  currentResults = search(query);
  activeIndex = currentResults.length ? 0 : -1;
  if (!query.trim()) { closeSuggestions(); return; }
  suggestionsEl.innerHTML = currentResults.length
    ? currentResults.map((m, i) => `
        <li id="sugg-${i}" role="option" data-id="${m.id}" aria-selected="${i === activeIndex}">
          <span>${highlight(m.title, query)}</span>
          <span class="s-meta">${m.year || ''}${m.genres[0] ? ` · ${esc(m.genres[0])}` : ''}</span>
        </li>`).join('')
    : '<li class="empty" role="option" aria-disabled="true">No movies found</li>';
  suggestionsEl.hidden = false;
  searchInput.setAttribute('aria-expanded', 'true');
  updateActive();
}

function updateActive() {
  suggestionsEl.querySelectorAll('li[data-id]').forEach((li, i) => {
    li.setAttribute('aria-selected', String(i === activeIndex));
    if (i === activeIndex) li.scrollIntoView({ block: 'nearest' });
  });
  if (activeIndex >= 0) searchInput.setAttribute('aria-activedescendant', `sugg-${activeIndex}`);
  else searchInput.removeAttribute('aria-activedescendant');
}

function closeSuggestions() {
  suggestionsEl.hidden = true;
  searchInput.setAttribute('aria-expanded', 'false');
  searchInput.removeAttribute('aria-activedescendant');
}

function choose(m) {
  searchInput.value = '';
  closeSuggestions();
  searchInput.blur();
  location.hash = `#/movie/${m.id}`;
}

searchInput.addEventListener('input', renderSuggestions);
searchInput.addEventListener('focus', () => { if (searchInput.value.trim()) renderSuggestions(); });
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' && currentResults.length) {
    e.preventDefault();
    activeIndex = (activeIndex + 1) % currentResults.length;
    updateActive();
  } else if (e.key === 'ArrowUp' && currentResults.length) {
    e.preventDefault();
    activeIndex = (activeIndex - 1 + currentResults.length) % currentResults.length;
    updateActive();
  } else if (e.key === 'Enter' && activeIndex >= 0) {
    e.preventDefault();
    choose(currentResults[activeIndex]);
  } else if (e.key === 'Escape') {
    closeSuggestions();
  }
});
suggestionsEl.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  e.preventDefault();
  choose(state.byId.get(Number(li.dataset.id)));
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search')) closeSuggestions();
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== searchInput) {
    e.preventDefault();
    searchInput.focus();
  }
});

// ---------- boot ----------
async function init() {
  readPosterCache();
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
    app.innerHTML = `<div class="error">Couldn't load movie data (${esc(err.message)}).<br>
      Run <code>python model/build_recommendations.py</code> to generate web/data/movies.json.</div>`;
    return;
  }
  searchInput.disabled = false;
  window.addEventListener('hashchange', route);
  route();
}

init();
