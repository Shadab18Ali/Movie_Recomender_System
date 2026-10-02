# Double Feature — Movie Recommendation System

Name a film you love and Double Feature recommends the 12 films closest to it, by story, genre,
themes, cast and director, from the [TMDB 5000 Movie Dataset](https://www.kaggle.com/datasets/tmdb/tmdb-movie-metadata).

Live: https://movierecomendersystem.vercel.app

## How the recommendations work

Content-based filtering, computed once at build time:

1. Each film becomes a bag of tags: its overview words (lower-cased, split on punctuation,
   stop words removed, then Porter-stemmed) plus whole-name tags for genres, keywords, the top 3
   cast members and the director (`Science Fiction` → `sciencefiction`).
2. Tags are vectorised with `CountVectorizer(max_features=5000)` and every pair of films is
   compared with cosine similarity.
3. For each film the 12 most similar films are kept. A film never recommends itself, films that
   share no tags are never recommended, and ties are broken by popularity so results are
   deterministic. Each recommendation records *why* it matches (same director, shared cast,
   shared themes/keywords, shared genres) and a match level (very close / close / related, from
   dataset-wide score percentiles).

It does not use ratings or viewing history.

## Architecture

```
model/build_recommendations.py   pipeline → static data (run when the model or data changes)
web/                             the site Vercel serves (no build step, no framework)
  index.html                     page shell: header, hero, search, skeletons, metadata
  styles.css
  js/boot.js                     tiny sync script: picks the route's skeleton before first paint
  js/app.js                      router (History API), views, search combobox
  js/core.js                     pure logic: search ranking, routing, index decoding (unit-tested)
  js/data.js                     fetch with timeout + retry + memoisation
  js/posters.js                  TMDB poster lookups: queued, cached, lazy, with fallbacks
  data/index.json                every film (id, title, year, rating, genres…), ~88 KB compressed
  data/film/<id>.json            one film's details + 12 recommendations, ~1.5 KB compressed
  sitemap.xml, robots.txt, og.png, favicon.svg, 404.html
api/poster.js                    Vercel function: TMDB poster paths (keeps the API key server-side)
movie-recommender-system.ipynb   step-by-step exploration of the same pipeline
```

The page shell renders immediately; the film index (needed for search and browsing) is preloaded
in parallel and each film's recommendations are fetched only when that film is opened. Every
request has a timeout and a retry, and every failure shows a "Try again" action.

URLs: `/`, `/genre/<genre>`, `/search?q=<title>`, `/film/<id>-<slug>` (old `#/movie/<id>` links redirect).

## Develop

```bash
pip install -r requirements-dev.txt   # pandas, scikit-learn, nltk, pytest, ruff
npm install                          # eslint, typescript, playwright, axe-core (dev only)

npm run build:data   # regenerate web/data and web/sitemap.xml
npm run dev          # http://localhost:3000, with the same rewrites/headers/API as Vercel
```

`tmdb_5000_movies.csv` is included. `tmdb_5000_credits.csv` (~40 MB) is not: download it from
Kaggle into the repo root and rebuild to add cast and director to the tags and the
"Same director" / "Also stars" reasons. Everything works without it.

## Test

```bash
npm run lint        # ESLint
npm run typecheck   # tsc --checkJs over web/js
npm test            # unit tests for search, routing, index decoding (node:test)
npm run test:py     # pipeline + generated-data tests (pytest)
npm run test:e2e    # Playwright: loading, failures, search, recommendations, posters,
                    # 9 viewport widths, keyboard, axe-core accessibility, SEO, no-JS
```

## Deploy (Vercel)

`vercel.json` serves `web/` as static files with no install or build step, adds the client-side
route rewrites, security headers (CSP etc.) and cache headers.

Posters are optional: add `TMDB_API_KEY` (a TMDB v3 API key or v4 read access token, free from
[themoviedb.org](https://www.themoviedb.org/settings/api)) under **Settings → Environment
Variables** and redeploy. Without it the site shows typographic title cards instead of posters.

This product uses the TMDB API but is not endorsed or certified by TMDB.
