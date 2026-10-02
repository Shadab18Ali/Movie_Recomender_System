// Loading the static data written by model/build_recommendations.py.
// Every request has a timeout and one automatic retry, results are memoised
// for the session, and a failed request is forgotten so "Try again" works.

import { decodeIndex } from './core.js';

const TIMEOUT_MS = 12000;

export class LoadError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, cause?: unknown }} [options]
   */
  constructor(message, { status = 0, cause = undefined } = {}) {
    super(message, { cause });
    this.name = 'LoadError';
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function fetchJSON(url, { retries = 1 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.status === 404) throw new LoadError('Not found', { status: 404 });
      if (!res.ok) throw new LoadError(`HTTP ${res.status}`, { status: res.status });
      return await res.json();
    } catch (err) {
      const status = err instanceof LoadError ? err.status : 0;
      const retryable = status === 0 || status >= 500;
      if (!retryable || attempt >= retries) {
        if (err instanceof LoadError) throw err;
        throw new LoadError(err.name === 'AbortError' ? 'Request timed out' : 'Network error', { cause: err });
      }
      await sleep(800 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
}

let indexPromise = null;

/** The film index (search + browse). Downloaded once per page load. */
export function loadIndex() {
  if (!indexPromise) {
    indexPromise = fetchJSON('/data/index.json')
      .then(decodeIndex)
      .catch((err) => {
        indexPromise = null;
        throw err;
      });
  }
  return indexPromise;
}

const filmCache = new Map();

/** One film's details and recommendations. */
export function loadFilm(id, version = '') {
  if (!filmCache.has(id)) {
    const url = `/data/film/${encodeURIComponent(id)}.json${version ? `?v=${encodeURIComponent(version)}` : ''}`;
    filmCache.set(id, fetchJSON(url).then(sanitizeFilm).catch((err) => {
      filmCache.delete(id);
      throw err;
    }));
  }
  return filmCache.get(id);
}

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);

/** Defensive copy: tolerate missing or malformed fields instead of crashing the page. */
function sanitizeFilm(raw) {
  if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.id)) throw new LoadError('Film data is malformed');
  return {
    id: raw.id,
    overview: typeof raw.overview === 'string' ? raw.overview : '',
    tagline: typeof raw.tagline === 'string' ? raw.tagline : '',
    runtime: Number.isFinite(raw.runtime) && raw.runtime > 0 ? raw.runtime : null,
    director: strings(raw.director),
    cast: strings(raw.cast),
    keywords: strings(raw.keywords),
    recs: (Array.isArray(raw.recs) ? raw.recs : [])
      .filter((r) => r && Number.isFinite(r.id) && r.id !== raw.id)
      .map((r) => ({
        id: r.id,
        score: Number(r.score) || 0,
        match: [1, 2, 3].includes(r.match) ? r.match : 3,
        why: r.why && typeof r.why === 'object' ? r.why : {},
        blurb: typeof r.blurb === 'string' ? r.blurb : '',
      })),
  };
}
