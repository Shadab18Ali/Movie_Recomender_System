// Pure helpers shared by the app and the unit tests (no DOM access here).

/** Lower-case, strip accents and punctuation: "Amélie!" -> "amelie". */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** URL slug; must match slugify() in model/build_recommendations.py. */
export function slugify(text) {
  const slug = String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || 'film';
}

/**
 * Turn the column-oriented index.json into film objects.
 * Throws if the payload is malformed so the caller can show an error state.
 */
export function decodeIndex(raw) {
  const cols = ['id', 'title', 'year', 'rating', 'votes', 'pop', 'genre'];
  if (!raw || !Array.isArray(raw.id) || !Array.isArray(raw.genres)) {
    throw new Error('Film index is malformed');
  }
  const n = raw.id.length;
  for (const c of cols) {
    if (!Array.isArray(raw[c]) || raw[c].length !== n) throw new Error(`Film index column "${c}" is malformed`);
  }
  const alt = new Map((raw.alt || []).map(([pos, title]) => [pos, title]));
  const films = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const genres = raw.genres.filter((_, b) => raw.genre[i] & (1 << b));
    const altTitle = alt.get(i) || '';
    films[i] = {
      pos: i,
      id: raw.id[i],
      title: String(raw.title[i]),
      altTitle,
      year: raw.year[i] || null,
      rating: raw.votes[i] > 0 ? raw.rating[i] / 10 : null,
      votes: raw.votes[i],
      popularity: raw.pop[i] / 10,
      genres,
      slug: slugify(raw.title[i]),
      norm: normalize(raw.title[i]),
      altNorm: normalize(altTitle),
    };
  }
  return {
    version: String(raw.version || ''),
    withCredits: Boolean(raw.withCredits),
    genres: raw.genres.slice(),
    films,
    byId: new Map(films.map((f) => [f.id, f])),
  };
}

function matchRank(norm, words, q) {
  if (!norm) return Infinity;
  if (norm === q) return 0;
  if (norm.startsWith(q)) return 1;
  if (norm.includes(` ${q}`)) return 2;
  if (norm.includes(q)) return 3;
  const titleWords = norm.split(' ');
  if (words.every((w) => titleWords.some((t) => t.startsWith(w)))) return 4;
  return Infinity;
}

/**
 * Rank films for a free-text query: exact title, then prefix, word start,
 * substring, all-words; original titles count slightly less; ties go to the
 * more popular, then the shorter (closer) title.
 */
export function searchFilms(films, query, limit = 8) {
  const q = normalize(query);
  if (!q) return [];
  const words = q.split(' ');
  const scored = [];
  for (const f of films) {
    const rank = Math.min(matchRank(f.norm, words, q), matchRank(f.altNorm, words, q) + 0.5);
    if (rank !== Infinity) scored.push([rank, f]);
  }
  scored.sort((a, b) => a[0] - b[0]
    || b[1].popularity - a[1].popularity
    || a[1].title.length - b[1].title.length // "toy stor": Toy Story before Toy Story 2
    || a[1].pos - b[1].pos);
  return scored.slice(0, limit).map(([, f]) => f);
}

export const SORTS = {
  popular: { label: 'Most popular', compare: (a, b) => b.popularity - a.popularity },
  top: { label: 'Highest rated', compare: (a, b) => b.rating - a.rating || b.votes - a.votes, minVotes: 300 },
  new: { label: 'Newest', compare: (a, b) => (b.year || 0) - (a.year || 0) || b.popularity - a.popularity },
};

export function browseFilms(films, { genre = null, sort = 'popular' } = {}) {
  const s = SORTS[sort] || SORTS.popular;
  return films
    .filter((f) => (!genre || f.genres.includes(genre)) && (!s.minVotes || f.votes >= s.minVotes))
    .sort(s.compare);
}

/**
 * Parse a location into a route. Unknown or malformed URLs never throw.
 * Legacy hash routes (#/movie/123, #/genre/Drama) from the first version are
 * mapped to their path equivalents.
 */
export function parseRoute(pathname, search = '', hash = '') {
  const params = new URLSearchParams(search);
  const legacy = hash.match(/^#\/(movie|genre)\/(.+)$/);
  if (legacy) {
    const [, kind, value] = legacy;
    if (kind === 'movie' && /^\d+$/.test(value)) return { name: 'film', id: Number(value), legacy: true };
    let genre = value;
    try { genre = decodeURIComponent(value); } catch { /* keep raw */ }
    return { name: 'home', genreSlug: slugify(genre), sort: 'popular', legacy: true };
  }
  const path = pathname.replace(/\/+$/, '') || '/';
  const sort = SORTS[params.get('sort')] ? params.get('sort') : 'popular';
  if (path === '/') return { name: 'home', genreSlug: null, sort };
  const film = path.match(/^\/film\/(\d{1,9})(?:-([a-z0-9-]*))?$/);
  if (film) return { name: 'film', id: Number(film[1]), slug: film[2] || '' };
  const genre = path.match(/^\/genre\/([a-z0-9-]+)$/);
  if (genre) return { name: 'home', genreSlug: genre[1], sort };
  if (path === '/search') return { name: 'search', query: (params.get('q') || '').slice(0, 200) };
  return { name: 'notfound' };
}

export const filmPath = (f) => `/film/${f.id}-${f.slug}`;

export const genrePath = (g) => (g ? `/genre/${slugify(g)}` : '/');

const MATCH_LABELS = { 1: 'Very close match', 2: 'Close match', 3: 'Related' };
export const matchLabel = (level) => MATCH_LABELS[level] || MATCH_LABELS[3];

/** Human-readable reasons a film was recommended, most specific first. */
export function describeWhy(why) {
  const out = [];
  if (!why || typeof why !== 'object') return out;
  if (why.director) out.push(`Same director: ${why.director}`);
  if (Array.isArray(why.cast) && why.cast.length) out.push(`Also stars ${why.cast.join(' and ')}`);
  if (Array.isArray(why.keywords) && why.keywords.length) out.push(`Shared themes: ${why.keywords.join(', ')}`);
  if (Array.isArray(why.genres) && why.genres.length) out.push(why.genres.join(' · '));
  return out;
}

export const TMDB_IMG = 'https://image.tmdb.org/t/p';
const IMAGE_PATH = /^\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/;
export const isImagePath = (p) => typeof p === 'string' && IMAGE_PATH.test(p);
