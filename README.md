# Movie Recommender System

A **content-based** movie recommender with a web frontend. Pick a movie you like and it suggests
the most similar films from the [TMDB 5000 Movie Dataset](https://www.kaggle.com/datasets/tmdb/tmdb-movie-metadata).

## How it works

1. Each movie is described by a bag of *tags*: overview words, genres, keywords, the top 3 cast
   members and the director (multi-word names are collapsed, e.g. `ScienceFiction`).
2. Tags are lower-cased and stemmed (Porter stemmer), then vectorised with
   `CountVectorizer(max_features=5000, stop_words='english')`.
3. Movies are compared with cosine similarity; the closest ones are the recommendations.

It does not use ratings or viewing history: recommendations are based purely on what the movies
are about and who made them.

## Project layout

```
movie-recommender-system.ipynb   # step-by-step exploration of the model
model/build_recommendations.py   # same pipeline; exports web/data/movies.json
web/                             # static frontend (HTML/CSS/JS), deployed to Vercel
  data/movies.json               # precomputed movies + top 12 recommendations each
api/poster.js                    # optional Vercel function: fetches posters from TMDB
vercel.json
```

The frontend is fully static: recommendations are precomputed, so Vercel serves plain files
with no Python runtime and no 4800×4800 similarity matrix.

## Data

- `tmdb_5000_movies.csv` is included.
- `tmdb_5000_credits.csv` (~40 MB) is **not** included. Download it from
  [Kaggle](https://www.kaggle.com/datasets/tmdb/tmdb-movie-metadata) and place it in the repo
  root to add cast and director to the tags. Everything still runs without it, using overview,
  genres and keywords only.

## Run locally

```bash
pip install -r requirements.txt

# rebuild web/data/movies.json (re-run after adding the credits file)
python model/build_recommendations.py

# serve the frontend
python -m http.server 8000 --directory web
# open http://localhost:8000
```

Posters need the `/api/poster` function, so locally you'll see generated placeholder posters
unless you use `vercel dev`.

## Deploy to Vercel

1. Push this repo to GitHub, then in Vercel choose **Add New → Project** and import it.
2. Keep the defaults. `vercel.json` already sets the output directory to `web` and turns off
   the build step.
3. *(Optional, for posters)* Create a free API key at
   [themoviedb.org](https://www.themoviedb.org/settings/api) and add it in Vercel under
   **Settings → Environment Variables** as `TMDB_API_KEY` (the v3 API key or the v4 read access
   token both work), then redeploy.

## Fixes over the original notebook

- `recommend()` used a DataFrame *label* as a *position* in the similarity matrix. After
  `dropna()` left gaps in the index, movies past the first gap got another film's recommendations
  (e.g. *Napoleon Dynamite* got *Dogtown and Z-Boys*'s), and the last movies raised `IndexError`.
  The index is now reset.
- Movies and credits are merged on the TMDB `id` instead of `title`, which paired up different
  films sharing a title (*Batman*, *The Host*, *Out of the Blue*).
- The notebook no longer crashes when `tmdb_5000_credits.csv` is missing.
- `recommend()` handles unknown titles, is case-insensitive and returns a list.
- Added stemming, removed the unused `.toarray()` dense copy, and fixed the duplicated cast logic.

This product uses the TMDB API but is not endorsed or certified by TMDB.
