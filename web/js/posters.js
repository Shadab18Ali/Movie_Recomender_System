// Poster images from TMDB, looked up through the /api/poster serverless
// function so the API key never reaches the browser. Lookups are queued
// (max 6 at once), de-duplicated, cached in localStorage for 14 days, and
// switched off entirely when the function reports it isn't configured. The
// first lookup goes out alone, so an unconfigured site costs one request per
// page view instead of a burst.

import { TMDB_IMG, isImagePath } from './core.js';

const CACHE_KEY = 'df-posters-v2';
const TTL_MS = 14 * 24 * 3600 * 1000;
const MAX_CONCURRENT = 6;

let enabled = true;
let verified = false; // has any lookup succeeded yet?
const memory = new Map(); // id -> {poster, backdrop} | null | Promise
const queue = [];
let active = 0;
let stored = {};

try {
  stored = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {};
  const now = Date.now();
  for (const [id, entry] of Object.entries(stored)) {
    if (Array.isArray(entry) && now - entry[2] < TTL_MS) {
      memory.set(Number(id), entry[0] || entry[1] ? { poster: entry[0], backdrop: entry[1] } : null);
    } else {
      delete stored[id];
    }
  }
} catch { stored = {}; }

let saveTimer = 0;
function remember(id, value) {
  memory.set(id, value);
  stored[id] = [value?.poster || null, value?.backdrop || null, Date.now()];
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const entries = Object.entries(stored);
      if (entries.length > 3000) stored = Object.fromEntries(entries.slice(-2000));
      localStorage.setItem(CACHE_KEY, JSON.stringify(stored));
    } catch { /* storage full or blocked: memory cache still works */ }
  }, 400);
}

function pump() {
  const limit = verified ? MAX_CONCURRENT : 1;
  while (active < limit && queue.length) {
    const { id, resolve } = queue.shift();
    if (!enabled) { resolve(null); continue; }
    active += 1;
    fetch(`/api/poster?id=${encodeURIComponent(id)}`)
      .then(async (res) => {
        // 404: no API route (plain static server).
        if (res.status === 404) { enabled = false; return undefined; }
        if (!res.ok) return undefined; // transient: don't cache
        const data = await res.json();
        if (data?.configured === false) { enabled = false; return undefined; } // TMDB_API_KEY not set
        verified = true;
        const value = {
          poster: isImagePath(data?.poster) ? data.poster : null,
          backdrop: isImagePath(data?.backdrop) ? data.backdrop : null,
        };
        return value.poster || value.backdrop ? value : null;
      })
      .catch(() => undefined)
      .then((value) => {
        if (value === undefined) memory.delete(id);
        else remember(id, value);
        resolve(value ?? null);
      })
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

/** Resolve to {poster, backdrop} image paths for a film, or null. Never rejects. */
export function getImages(id) {
  if (memory.has(id)) return Promise.resolve(memory.get(id));
  if (!enabled) return Promise.resolve(null);
  const promise = new Promise((resolve) => { queue.push({ id, resolve }); });
  memory.set(id, promise);
  pump();
  return promise;
}

export const posterSrcset = (path) => `${TMDB_IMG}/w185${path} 185w, ${TMDB_IMG}/w342${path} 342w, ${TMDB_IMG}/w500${path} 500w`;
export const posterSrc = (path) => `${TMDB_IMG}/w342${path}`;
export const backdropSrc = (path) => `${TMDB_IMG}/w1280${path}`;

const observer = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      fillPoster(entry.target);
    }
  }, { rootMargin: '400px 0px' })
  : null;

/**
 * Add the real poster to a `.poster[data-id]` frame once it scrolls near the
 * viewport. The frame already shows a typographic fallback and has a fixed
 * aspect ratio, so a missing or broken image causes no layout shift.
 */
export function watchPoster(frame) {
  if (observer) observer.observe(frame);
  else fillPoster(frame);
}

function fillPoster(frame) {
  const id = Number(frame.dataset.id);
  getImages(id).then((images) => {
    if (!images?.poster || !frame.isConnected) return;
    const img = document.createElement('img');
    img.alt = frame.dataset.alt || '';
    img.width = 342;
    img.height = 513;
    img.decoding = 'async';
    img.loading = frame.dataset.eager ? 'eager' : 'lazy';
    img.sizes = frame.dataset.sizes || '(max-width: 600px) 45vw, 220px';
    img.srcset = posterSrcset(images.poster);
    img.src = posterSrc(images.poster);
    img.addEventListener('load', () => frame.classList.add('has-image'));
    img.addEventListener('error', () => img.remove()); // keep the fallback, never a broken image
    frame.append(img);
  });
}
