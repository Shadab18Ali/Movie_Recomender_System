// Double Feature: router, views and search. The page shell (header, hero,
// search box, skeletons, footer) is static HTML, so the interface is visible
// immediately; this module fills it in as data arrives.

import {
  SORTS, browseFilms, describeWhy, filmPath, genrePath, matchLabel, parseRoute, searchFilms, slugify,
} from './core.js';
import { loadFilm, loadIndex } from './data.js';
import { ICONS, h, icon } from './dom.js';
import { backdropSrc, getImages, watchPoster } from './posters.js';

const PAGE_SIZE = 24;
const SITE_NAME = 'Double Feature';
const DEFAULT_TITLE = 'Double Feature — Movie Recommendation System';
const DEFAULT_DESCRIPTION = document.querySelector('meta[name="description"]').getAttribute('content');

const view = document.getElementById('view');
const hero = document.getElementById('hero');
const announcer = document.getElementById('announcer');
const browseState = new Map(); // route key -> number of cards shown

let renderToken = 0;
let firstRender = true;
let pendingFocus = null; // selector to focus after the next render instead of the page heading

// ---------- small building blocks ----------
const yearGenre = (f) => [f.year, f.genres.slice(0, 2).join(', ')].filter(Boolean).join(' · ');

function rating(f, { votes = false } = {}) {
  if (f.rating == null) return h('span', { class: 'rating rating--none' }, 'Not yet rated');
  return h('span', { class: 'rating' },
    icon(ICONS.star, 'icon icon-star'),
    h('span', { class: 'sr-only' }, 'Rated '),
    f.rating.toFixed(1),
    h('span', { class: 'sr-only' }, ' out of 10'),
    votes ? h('span', { class: 'rating-votes' }, ` (${f.votes.toLocaleString()} votes)`) : null);
}

function posterFrame(f, { alt = '', eager = false, sizes = '' } = {}) {
  const frame = h('div', {
    class: 'poster',
    'data-id': f.id,
    'data-alt': alt,
    'data-eager': eager ? '1' : null,
    'data-sizes': sizes || null,
  }, h('div', { class: 'poster-fallback', 'aria-hidden': 'true' },
    h('span', { class: 'poster-fallback-title' }, f.title),
    f.year ? h('span', { class: 'poster-fallback-year' }, f.year) : null));
  watchPoster(frame);
  return frame;
}

function filmCard(f) {
  return h('li', {},
    h('a', { class: 'card', href: filmPath(f) },
      posterFrame(f),
      h('div', { class: 'card-body' },
        h('h3', { class: 'card-title' }, f.title),
        h('p', { class: 'card-meta' }, yearGenre(f)),
        h('p', { class: 'card-rating' }, rating(f)))));
}

function recCard(f, rec, i, sourceTitle) {
  const reasons = describeWhy(rec.why);
  return h('li', {},
    h('a', { class: `card card--rec${i === 0 ? ' card--pick' : ''}`, href: filmPath(f) },
      h('div', { class: 'card-media' },
        posterFrame(f, { sizes: '(max-width: 600px) 40vw, 200px' }),
        i === 0 ? h('span', { class: 'pick-badge' }, 'Your double feature') : null),
      h('div', { class: 'card-body' },
        h('p', { class: `match match--${rec.match}` }, matchLabel(rec.match)),
        h('h3', { class: 'card-title' }, f.title),
        h('p', { class: 'card-meta' }, yearGenre(f), ' ', rating(f)),
        rec.blurb ? h('p', { class: 'card-blurb' }, rec.blurb) : null,
        h('div', { class: 'why' },
          h('p', { class: 'sr-only' }, `Why it matches ${sourceTitle}:`),
          reasons.length
            ? h('ul', {}, reasons.slice(0, 2).map((r) => h('li', {}, r)))
            : h('ul', {}, h('li', {}, 'Similar storyline'))))));
}

function skeletonCards(n, rec = false) {
  return h('ul', { class: `grid${rec ? ' grid--recs' : ''}`, 'aria-hidden': 'true' },
    Array.from({ length: n }, () => h('li', {},
      h('div', { class: 'card card--skeleton' },
        h('div', { class: 'poster skeleton' }),
        h('div', { class: 'card-body' },
          h('div', { class: 'skeleton skeleton-line' }),
          h('div', { class: 'skeleton skeleton-line skeleton-line--short' }),
          rec ? h('div', { class: 'skeleton skeleton-line' }) : null)))));
}

function loadingBlock(label, n = 12, rec = false) {
  return h('div', { class: 'loading', role: 'status' },
    h('p', { class: 'sr-only' }, label),
    skeletonCards(n, rec));
}

function errorBlock(title, err, onRetry) {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const detail = offline ? 'You appear to be offline. Check your connection and try again.'
    : err?.message === 'Request timed out' ? 'The server took too long to respond. It is usually quick, so trying again should help.'
      : 'Something went wrong while loading. Trying again usually fixes it.';
  return h('div', { class: 'notice notice--error', role: 'alert' },
    h('h2', { class: 'notice-title' }, title),
    h('p', {}, detail),
    onRetry ? h('button', { type: 'button', class: 'btn', onClick: onRetry }, icon(ICONS.retry), 'Try again') : null);
}

function setMeta({ title = '', description = '', path = '/' } = {}) {
  document.title = title ? `${title} · ${SITE_NAME}` : DEFAULT_TITLE;
  const desc = description || DEFAULT_DESCRIPTION;
  const url = new URL(path || '/', location.origin).href;
  const set = (sel, attr, value) => { const el = document.querySelector(sel); if (el) el.setAttribute(attr, value); };
  set('meta[name="description"]', 'content', desc);
  set('link[rel="canonical"]', 'href', url);
  set('meta[property="og:title"]', 'content', title || DEFAULT_TITLE);
  set('meta[property="og:description"]', 'content', desc);
  set('meta[property="og:url"]', 'content', url);
  set('meta[name="twitter:title"]', 'content', title || DEFAULT_TITLE);
  set('meta[name="twitter:description"]', 'content', desc);
}

function show(...nodes) {
  view.replaceChildren(...nodes);
}

// After client-side navigation, move focus to the new page's heading so
// keyboard and screen-reader users start at the top of the new content.
function focusHeading() {
  const preferred = pendingFocus && view.querySelector(pendingFocus);
  pendingFocus = null;
  if (preferred) {
    if (!preferred.matches('a, button, input, select, textarea')) preferred.setAttribute('tabindex', '-1');
    preferred.focus({ preventScroll: true });
    return;
  }
  const heading = view.querySelector('h1') || (hero.hidden ? null : hero.querySelector('h1'));
  const target = heading || document.getElementById('main');
  target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}

const truncate = (text, n) => (text.length > n ? `${text.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : text);

// ---------- views ----------
async function renderHome(route, token) {
  hero.hidden = false;
  document.documentElement.dataset.route = 'home';
  const heading = h('h2', { id: 'browse-title', class: 'section-title' }, 'Browse the collection');
  show(h('section', { class: 'browse', 'aria-labelledby': 'browse-title' },
    h('div', { class: 'section-head' }, heading), loadingBlock('Loading films…')));

  let index;
  try {
    index = await loadIndex();
  } catch (err) {
    if (token !== renderToken) return;
    show(errorBlock('We couldn’t load the film collection', err, () => render()));
    return;
  }
  if (token !== renderToken) return;

  const genre = route.genreSlug ? index.genres.find((g) => slugify(g) === route.genreSlug) : null;
  if (route.genreSlug && !genre) {
    navigate('/', { replace: true });
    return;
  }
  const list = browseFilms(index.films, { genre, sort: route.sort });
  const key = `${genre}|${route.sort}`;
  const shown = Math.min(browseState.get(key) || PAGE_SIZE, list.length);
  heading.textContent = genre ? `${genre} films` : 'Browse the collection';
  setMeta(genre
    ? { title: `${genre} films`, description: `Browse ${list.length.toLocaleString()} ${genre.toLowerCase()} films and find what to watch next with Double Feature.`, path: genrePath(genre) }
    : { path: '/' });

  const withSort = (path) => (route.sort === 'popular' ? path : `${path}?sort=${route.sort}`);
  const genreNav = h('nav', { class: 'genres', 'aria-label': 'Genres' },
    h('ul', {}, [null, ...index.genres].map((g) => h('li', {},
      h('a', {
        class: 'chip',
        href: withSort(genrePath(g)),
        'data-nav': 'stay',
        'aria-current': g === genre ? 'page' : null,
      }, g || 'All')))));

  const sortSelect = h('select', {
    id: 'sort',
    onChange: (e) => {
      const sort = e.target.value;
      navigate(`${genrePath(genre)}${sort === 'popular' ? '' : `?sort=${sort}`}`, { replace: true, keepScroll: true, focus: '#sort' });
    },
  }, Object.entries(SORTS).map(([k, s]) => h('option', { value: k, selected: k === route.sort }, s.label)));

  const grid = h('ul', { class: 'grid' }, list.slice(0, shown).map(filmCard));
  const status = h('p', { class: 'count', 'aria-live': 'polite' }, `Showing ${shown.toLocaleString()} of ${list.length.toLocaleString()} films`);
  const more = shown < list.length ? h('button', {
    type: 'button',
    class: 'btn btn-wide',
    onClick: () => {
      const now = grid.children.length;
      const next = Math.min(now + PAGE_SIZE, list.length);
      grid.append(...list.slice(now, next).map(filmCard));
      browseState.set(key, next);
      status.textContent = `Showing ${next.toLocaleString()} of ${list.length.toLocaleString()} films`;
      if (next >= list.length) more.remove();
      grid.children[now]?.querySelector('a')?.focus({ preventScroll: true });
    },
  }, 'Show more films') : null;

  show(h('section', { class: 'browse', 'aria-labelledby': 'browse-title' },
    h('div', { class: 'section-head' },
      heading,
      h('div', { class: 'sort' }, h('label', { for: 'sort' }, 'Sort by'), sortSelect)),
    genreNav,
    list.length ? grid : h('p', { class: 'empty' }, 'No films in this category yet.'),
    h('div', { class: 'more' }, status, more)));
}

async function renderSearch(route, token) {
  hero.hidden = true;
  document.documentElement.dataset.route = 'search';
  const query = route.query.trim();
  setMeta({ title: query ? `Search: ${query}` : 'Search', path: `/search?q=${encodeURIComponent(query)}` });
  const title = h('h1', { class: 'page-title' }, query ? ['Results for ', h('q', {}, query)] : 'Search films');
  show(h('section', { class: 'page' }, title, loadingBlock('Searching…', 8)));

  let index;
  try {
    index = await loadIndex();
  } catch (err) {
    if (token !== renderToken) return;
    show(h('section', { class: 'page' }, title, errorBlock('We couldn’t search the collection', err, () => render())));
    return;
  }
  if (token !== renderToken) return;

  if (!query) {
    show(h('section', { class: 'page' }, title,
      h('p', { class: 'empty' }, 'Type a film title in the search box to find it.')));
    return;
  }
  const results = searchFilms(index.films, query, 48);
  if (!results.length) {
    const popular = browseFilms(index.films).slice(0, 6);
    show(h('section', { class: 'page' }, title,
      h('div', { class: 'notice' },
        h('h2', { class: 'notice-title' }, 'No films match that search'),
        h('p', {}, 'Check the spelling, try fewer words, or search for the original title. The collection covers 4,800 mostly English-language films released up to 2016.')),
      h('h2', { class: 'section-title' }, 'Popular in the collection'),
      h('ul', { class: 'grid' }, popular.map(filmCard))));
    return;
  }
  show(h('section', { class: 'page' }, title,
    h('h2', { class: 'count' }, `${results.length === 48 ? 'Top 48' : results.length} matching ${results.length === 1 ? 'film' : 'films'}`),
    h('ul', { class: 'grid' }, results.map(filmCard))));
}

async function renderFilm(route, token) {
  hero.hidden = true;
  document.documentElement.dataset.route = 'film';
  show(h('div', { class: 'film-loading' },
    h('div', { class: 'film-hero film-hero--skeleton', 'aria-hidden': 'true' },
      h('div', { class: 'poster skeleton' }),
      h('div', {},
        h('div', { class: 'skeleton skeleton-title' }),
        h('div', { class: 'skeleton skeleton-line skeleton-line--short' }),
        h('div', { class: 'skeleton skeleton-line' }),
        h('div', { class: 'skeleton skeleton-line' }))),
    loadingBlock('Loading film…', 4, true)));

  let index;
  try {
    index = await loadIndex();
  } catch (err) {
    if (token !== renderToken) return;
    show(h('section', { class: 'page' }, errorBlock('We couldn’t load this film', err, () => render())));
    return;
  }
  if (token !== renderToken) return;

  const film = index.byId.get(route.id);
  if (!film) {
    renderNotFound('We couldn’t find that film', 'It may have been removed, or the link is mistyped. Try searching for it instead.');
    return;
  }
  if (route.legacy || route.slug !== film.slug) {
    history.replaceState(null, '', filmPath(film)); // canonical URL
  }
  setMeta({
    title: `${film.title}${film.year ? ` (${film.year})` : ''}`,
    description: `Films like ${film.title}: ${SITE_NAME} recommends the 12 closest matches by story, genre, themes, cast and director.`,
    path: filmPath(film),
  });

  const details = h('div', { class: 'film-details' },
    h('div', { class: 'skeleton skeleton-line' }),
    h('div', { class: 'skeleton skeleton-line' }),
    h('div', { class: 'skeleton skeleton-line skeleton-line--short' }));
  const recsBody = h('div', {}, loadingBlock(`Finding films like ${film.title}…`, 4, true));
  const backdrop = h('div', { class: 'film-backdrop', 'aria-hidden': 'true' });
  const primaryGenre = film.genres[0];

  show(h('article', { class: 'film' },
    backdrop,
    h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' },
      h('ol', {},
        h('li', {}, h('a', { href: '/' }, 'Home')),
        primaryGenre ? h('li', {}, h('a', { href: genrePath(primaryGenre) }, primaryGenre)) : null,
        h('li', {}, h('span', { 'aria-current': 'page' }, film.title)))),
    h('div', { class: 'film-hero' },
      posterFrame(film, { alt: `Poster for ${film.title}${film.year ? ` (${film.year})` : ''}`, eager: true, sizes: '(max-width: 720px) 50vw, 300px' }),
      h('div', { class: 'film-info' },
        h('h1', { class: 'film-title' }, film.title),
        h('ul', { class: 'facts' },
          film.year ? h('li', {}, film.year) : null,
          h('li', { class: 'facts-runtime', hidden: true }),
          h('li', {}, rating(film, { votes: true }))),
        film.genres.length ? h('ul', { class: 'genre-links', 'aria-label': 'Genres' },
          film.genres.map((g) => h('li', {}, h('a', { class: 'chip', href: genrePath(g) }, g)))) : null,
        details)),
    h('section', { class: 'recs', 'aria-labelledby': 'recs-title' },
      h('h2', { id: 'recs-title', class: 'section-title' },
        'Because you liked ', h('em', {}, film.title), ', you may also like…'),
      h('p', { class: 'section-note' }, 'Ranked by how closely each film’s story, genres, themes and credits match.'),
      recsBody)));

  getImages(film.id).then((images) => {
    if (!images?.backdrop || !backdrop.isConnected) return;
    const img = new Image();
    img.onload = () => {
      backdrop.style.setProperty('background-image', `url("${backdropSrc(images.backdrop)}")`);
      backdrop.classList.add('is-loaded');
    };
    img.src = backdropSrc(images.backdrop);
  });

  const fill = async () => {
    let data;
    try {
      data = await loadFilm(film.id, index.version);
    } catch (err) {
      if (token !== renderToken) return;
      const retry = () => {
        details.replaceChildren(h('div', { class: 'skeleton skeleton-line' }));
        recsBody.replaceChildren(loadingBlock(`Finding films like ${film.title}…`, 4, true));
        fill();
      };
      details.replaceChildren();
      recsBody.replaceChildren(errorBlock('We couldn’t load the recommendations', err, retry));
      return;
    }
    if (token !== renderToken) return;

    const runtime = /** @type {HTMLElement | null} */ (view.querySelector('.facts-runtime'));
    if (runtime && data.runtime) {
      runtime.textContent = `${Math.floor(data.runtime / 60)}h ${data.runtime % 60}m`;
      runtime.hidden = false;
    }
    const credits = [
      data.director.length ? [data.director.length > 1 ? 'Directors' : 'Director', data.director.join(', ')] : null,
      data.cast.length ? ['Starring', data.cast.join(', ')] : null,
      data.keywords.length ? ['Themes', data.keywords.slice(0, 6).join(', ')] : null,
    ].filter(Boolean);
    details.replaceChildren(
      data.tagline ? h('p', { class: 'tagline' }, data.tagline) : null,
      h('p', { class: 'overview' }, data.overview || 'No synopsis is available for this film.'),
      credits.length ? h('dl', { class: 'credits' }, credits.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])) : null,
    );
    if (data.overview) {
      setMeta({
        title: `${film.title}${film.year ? ` (${film.year})` : ''}`,
        description: `If you liked ${film.title}, try these films. ${truncate(data.overview, 110)}`,
        path: filmPath(film),
      });
    }

    const recs = data.recs.map((r) => [index.byId.get(r.id), r]).filter(([f]) => f);
    recsBody.replaceChildren(recs.length
      ? h('ol', { class: 'grid grid--recs' }, recs.map(([f, r], i) => recCard(f, r, i, film.title)))
      : h('p', { class: 'empty' }, 'We couldn’t find films similar enough to recommend. Try another title.'));
  };
  fill();
}

function renderNotFound(title = 'Page not found', text = 'The page you’re looking for doesn’t exist.') {
  hero.hidden = true;
  document.documentElement.dataset.route = 'search';
  setMeta({ title });
  show(h('section', { class: 'page' },
    h('h1', { class: 'page-title' }, title),
    h('div', { class: 'notice' },
      h('p', {}, text),
      h('p', {}, h('a', { class: 'btn', href: '/' }, 'Go to the home page')))));
}

// ---------- routing ----------
export function render() {
  renderToken += 1;
  const token = renderToken;
  const route = parseRoute(location.pathname, location.search, location.hash);
  if (route.legacy && route.name === 'home') {
    history.replaceState(null, '', route.genreSlug ? `/genre/${route.genreSlug}` : '/');
  }
  closeAllSuggestions();
  const isFirst = firstRender;
  firstRender = false;
  let done;
  if (route.name === 'film') done = renderFilm(route, token);
  else if (route.name === 'search') done = renderSearch(route, token);
  else if (route.name === 'home') done = renderHome(route, token);
  else done = Promise.resolve(renderNotFound());
  return done.finally(() => {
    if (!isFirst && token === renderToken) focusHeading();
  });
}

function navigate(url, { replace = false, keepScroll = false, focus = null } = {}) {
  const target = new URL(url, location.href);
  if (target.href === location.href && !replace) return;
  pendingFocus = focus;
  history[replace ? 'replaceState' : 'pushState'](null, '', target.pathname + target.search);
  render();
  if (!keepScroll) window.scrollTo(0, 0);
}

document.addEventListener('click', (e) => {
  const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
  if (!(a instanceof HTMLAnchorElement) || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (a.target && a.target !== '_self') return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || /\.\w+$/.test(url.pathname)) return;
  if (url.hash && url.pathname === location.pathname && url.search === location.search) return; // in-page anchor (skip link)
  e.preventDefault();
  // Genre filters keep the reader's place in the list instead of jumping to the top.
  if (a.dataset.nav === 'stay') navigate(url.pathname + url.search, { keepScroll: true, focus: '#browse-title' });
  else navigate(url.pathname + url.search);
});

window.addEventListener('popstate', () => render());

// ---------- search (combobox) ----------
const searches = [];

function closeAllSuggestions() {
  searches.forEach((s) => s.close());
}

function createSearch(form) {
  const input = form.querySelector('input');
  const list = form.querySelector('[role="listbox"]');
  const clear = form.querySelector('.search-clear');
  let results = [];
  let active = -1;
  let timer = 0;
  let seq = 0;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const say = (text) => { announcer.textContent = text; };

  function paint(state, query) {
    list.replaceChildren();
    if (state === 'loading') {
      list.append(...[1, 2, 3].map(() => h('li', { class: 'suggestion suggestion--skeleton', 'aria-hidden': 'true' },
        h('span', { class: 'skeleton skeleton-line' }))));
      say('Loading film titles…');
    } else if (state === 'error') {
      list.append(h('li', { class: 'suggestion suggestion--message', role: 'presentation' },
        'Couldn’t load film titles. ',
        h('button', {
          type: 'button',
          class: 'link-button',
          onMousedown: (e) => e.preventDefault(),
          onClick: () => { update(); input.focus(); },
        }, 'Try again')));
      say('Couldn’t load film titles.');
    } else if (!results.length) {
      list.append(h('li', { class: 'suggestion suggestion--message', role: 'presentation' },
        'No films match ', h('q', {}, query), '. Check the spelling or try another title.'));
      say('No matching films.');
    } else {
      results.forEach((f, i) => list.append(h('li', {
        id: `${list.id}-${i}`,
        class: 'suggestion',
        role: 'option',
        'aria-selected': 'false',
        'data-index': i,
      },
      h('span', { class: 'suggestion-title' }, f.title),
      h('span', { class: 'suggestion-meta' }, yearGenre(f)))));
      say(`${results.length} ${results.length === 1 ? 'film' : 'films'} found. Use the up and down arrows to choose.`);
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    setActive(-1);
  }

  function setActive(i) {
    active = i;
    list.querySelectorAll('[role="option"]').forEach((li, k) => {
      li.setAttribute('aria-selected', String(k === i));
      if (k === i) li.scrollIntoView({ block: 'nearest' });
    });
    if (i >= 0) input.setAttribute('aria-activedescendant', `${list.id}-${i}`);
    else input.removeAttribute('aria-activedescendant');
  }

  async function update() {
    const query = input.value;
    clear.hidden = !query;
    const mine = ++seq;
    if (!query.trim()) { results = []; close(); return; }
    let index;
    try {
      const pending = loadIndex();
      const settled = await Promise.race([pending, new Promise((r) => { setTimeout(() => r(null), 150); })]);
      if (!settled) {
        if (mine === seq) paint('loading', query);
        index = await pending;
      } else {
        index = settled;
      }
    } catch {
      if (mine === seq) { results = []; paint('error', query); }
      return;
    }
    if (mine !== seq || document.activeElement !== input) return;
    results = searchFilms(index.films, query, 8);
    paint('results', query);
  }

  function choose(f) {
    input.value = '';
    clear.hidden = true;
    close();
    input.blur();
    navigate(filmPath(f));
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(update, 90); // light debounce; matching itself is instant
  });
  input.addEventListener('focus', () => { if (input.value.trim()) update(); });
  input.addEventListener('blur', () => { setTimeout(() => { if (!form.contains(document.activeElement)) close(); }, 150); });
  input.addEventListener('keydown', (e) => {
    const open = !list.hidden && results.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (list.hidden) { update(); return; }
      if (open) setActive((active + 1) % results.length);
    } else if (e.key === 'ArrowUp' && open) {
      e.preventDefault();
      setActive(active <= 0 ? results.length - 1 : active - 1);
    } else if (e.key === 'Escape') {
      if (!list.hidden) close();
      else if (input.value) { input.value = ''; clear.hidden = true; }
    } else if (e.key === 'Tab') {
      close();
    }
  });
  list.addEventListener('mousedown', (e) => {
    if (e.target.closest('[role="option"]')) e.preventDefault(); // keep focus in the input
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('[role="option"]');
    if (li) choose(results[Number(li.dataset.index)]);
  });
  clear.addEventListener('click', () => {
    input.value = '';
    clear.hidden = true;
    results = [];
    close();
    input.focus();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(timer);
    if (active >= 0 && results[active]) { choose(results[active]); return; }
    const query = input.value.trim();
    if (!query) { input.focus(); return; }
    close();
    input.blur();
    navigate(`/search?q=${encodeURIComponent(query)}`);
  });

  form.classList.add('is-enhanced');
  clear.hidden = !input.value;
  const api = { close, input };
  searches.push(api);
  return api;
}

document.querySelectorAll('form[data-search]').forEach(createSearch);

// "/" focuses search, as on most media sites.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  const focused = /** @type {HTMLElement | null} */ (document.activeElement);
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(focused?.tagName || '') || focused?.isContentEditable) return;
  e.preventDefault();
  const target = hero.hidden ? searches[0] : searches[searches.length - 1];
  target?.input.focus();
});

// Start downloading the index right away (it is also preloaded in <head>).
loadIndex().catch(() => { /* surfaced by the view that needs it */ });
render();
