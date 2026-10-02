"""Build the static data the Double Feature frontend serves.

Runs the content-based pipeline from movie-recommender-system.ipynb once, at
build time, and writes small static files so the browser never computes
similarities or downloads the whole dataset:

  web/data/index.json        compact, column-oriented list of every film
                             (id, title, year, rating, votes, popularity,
                             genres) used for search and browsing (~70 KB
                             compressed)
  web/data/film/<id>.json    one file per film: overview, credits and its
                             top recommendations with the reasons they match
                             (~1-2 KB compressed), fetched only when that
                             film is opened
  web/sitemap.xml            every film and genre URL

Usage:
    python model/build_recommendations.py

tmdb_5000_credits.csv is optional. When it is present next to
tmdb_5000_movies.csv, the top 3 cast members and the director are added to
each movie's tags; without it only overview, genres and keywords are used.
"""

import argparse
import ast
import hashlib
import json
import os
import re
import shutil
import unicodedata
from collections import Counter
from pathlib import Path
from xml.sax.saxutils import escape

import numpy as np
import pandas as pd
from nltk.stem.porter import PorterStemmer
from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS, CountVectorizer
from sklearn.metrics.pairwise import cosine_similarity

ROOT = Path(__file__).resolve().parent.parent
SITE_URL = os.environ.get('SITE_URL', 'https://movierecomendersystem.vercel.app').rstrip('/')
TOP_N = 12
MIN_SCORE = 0.0  # recommendations must share at least one tag
BLURB_CHARS = 160

ps = PorterStemmer()
WORD = re.compile(r'[a-z0-9]+')


# ---------- parsing ----------
def convert(text):
    if not isinstance(text, str) or not text.strip():
        return []
    try:
        return [i['name'] for i in ast.literal_eval(text) if i.get('name')]
    except (ValueError, SyntaxError):
        return []


def convert3(text):
    return convert(text)[:3]


def fetch_director(text):
    if not isinstance(text, str) or not text.strip():
        return []
    try:
        return [i['name'] for i in ast.literal_eval(text) if i.get('job') == 'Director']
    except (ValueError, SyntaxError):
        return []


# ---------- text normalisation ----------
def words(text):
    """Lower-case alphanumeric words; punctuation never sticks to a word."""
    return WORD.findall(text.lower()) if isinstance(text, str) else []


def overview_tokens(text):
    """Stop words are removed *before* stemming so stems like 'becaus' never leak in."""
    return [ps.stem(w) for w in words(text) if w not in ENGLISH_STOP_WORDS]


def entity_token(name):
    """'Science Fiction' -> 'sciencefiction', 'Spider-Man' -> 'spiderman' (one tag per name)."""
    return ''.join(words(name))


def slugify(text):
    """Must match slugify() in web/js/core.js."""
    text = unicodedata.normalize('NFKD', text)
    text = ''.join(c for c in text if not unicodedata.combining(c)).lower()
    text = re.sub(r'[^a-z0-9]+', '-', text).strip('-')[:80].strip('-')
    return text or 'film'


# ---------- pipeline ----------
def load_movies(data_dir):
    movies = pd.read_csv(data_dir / 'tmdb_5000_movies.csv')
    credits_path = data_dir / 'tmdb_5000_credits.csv'
    has_credits = credits_path.exists()
    if has_credits:
        credits = pd.read_csv(credits_path)
        # Merge on the TMDB id: several titles (Batman, The Host, ...) are not unique.
        movies = movies.merge(credits.drop(columns=['title']), left_on='id', right_on='movie_id')
    else:
        print(f"warning: {credits_path.name} not found; building without cast and director")
        movies['cast'] = '[]'
        movies['crew'] = '[]'
    movies = movies.drop_duplicates(subset='id').reset_index(drop=True)  # row position == similarity row
    movies['overview'] = movies['overview'].fillna('')
    movies['genre_list'] = movies['genres'].apply(convert)
    movies['keyword_list'] = movies['keywords'].apply(convert)
    movies['cast_list'] = movies['cast'].apply(convert3)
    movies['director_list'] = movies['crew'].apply(fetch_director)
    return movies, has_credits


def build_tags(movies):
    def tags(row):
        entities = row.genre_list + row.keyword_list + row.cast_list + row.director_list
        return ' '.join(overview_tokens(row.overview) + [t for t in map(entity_token, entities) if t])
    return movies.apply(tags, axis=1)


def top_similar(tags, top_n=TOP_N, popularity=None, min_score=MIN_SCORE):
    """Return, for every row, up to top_n (row, score) pairs sorted by similarity.

    A film never recommends itself, films sharing no tags (score <= min_score)
    are never recommended, and ties are broken deterministically by
    popularity and then by row order.
    """
    cv = CountVectorizer(max_features=5000, token_pattern=r'[a-z0-9]{2,}', lowercase=False)
    vector = cv.fit_transform(tags)
    similarity = cosine_similarity(vector)
    n = similarity.shape[0]
    pop = np.zeros(n) if popularity is None else np.asarray(popularity, dtype=float)
    order = np.arange(n)
    results = []
    for i in range(n):
        scores = similarity[i].copy()
        scores[i] = -np.inf  # never recommend a movie to itself
        ranked = np.lexsort((order, -pop, -scores))  # last key is primary
        picks = [(int(j), float(scores[j])) for j in ranked[:top_n] if scores[j] > min_score]
        results.append(picks)
    return results


def match_levels(results):
    """Turn raw cosine scores into 3 human-readable levels using dataset-wide percentiles."""
    all_scores = np.array([s for recs in results for _, s in recs])
    if all_scores.size == 0:
        return lambda s: 3
    very, close = np.percentile(all_scores, [90, 50])
    return lambda s: 1 if s >= very else (2 if s >= close else 3)


def blurb(text, limit=BLURB_CHARS):
    text = ' '.join(text.split())
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(' ', 1)[0].rstrip(',;:.-—')
    return f'{cut}…'


def reasons(src, rec, keyword_df):
    shared_keywords = sorted(set(src.keyword_list) & set(rec.keyword_list), key=lambda k: (keyword_df[k], k))
    shared_cast = [c for c in src.cast_list if c in rec.cast_list]
    shared_director = [d for d in src.director_list if d in rec.director_list]
    why = {}
    if shared_director:
        why['director'] = shared_director[0]
    if shared_cast:
        why['cast'] = shared_cast[:2]
    if shared_keywords:
        why['keywords'] = shared_keywords[:3]
    shared_genres = [g for g in src.genre_list if g in rec.genre_list]
    if shared_genres:
        why['genres'] = shared_genres
    return why


def year_of(date):
    return int(date[:4]) if isinstance(date, str) and date[:4].isdigit() else 0


def write_json(path, payload):
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')


def build(data_dir, out_dir, top_n=TOP_N):
    movies, has_credits = load_movies(data_dir)
    results = top_similar(build_tags(movies), top_n, popularity=movies['popularity'].to_numpy())
    level = match_levels(results)
    keyword_df = Counter(k for ks in movies['keyword_list'] for k in set(ks))

    genres = sorted({g for gs in movies['genre_list'] for g in gs})
    bit = {g: 1 << i for i, g in enumerate(genres)}
    titles = movies['title'].tolist()

    index = {
        'withCredits': has_credits,
        'genres': genres,
        'id': movies['id'].astype(int).tolist(),
        'title': titles,
        'year': [year_of(d) for d in movies['release_date']],
        'rating': [int(round(v * 10)) for v in movies['vote_average'].fillna(0)],
        'votes': movies['vote_count'].fillna(0).astype(int).tolist(),
        'pop': [int(round(p * 10)) for p in movies['popularity'].fillna(0)],
        'genre': [sum(bit[g] for g in set(gs)) for gs in movies['genre_list']],
        # Original titles that differ from the English title, so "Amélie" or
        # "Le Fabuleux Destin d'Amélie Poulain" both find the film.
        'alt': [[i, o] for i, (t, o) in enumerate(zip(titles, movies['original_title']))
                if isinstance(o, str) and o.casefold() != t.casefold()],
    }
    body = json.dumps(index, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
    index['version'] = hashlib.sha256(body.encode()).hexdigest()[:12]

    data_dir_out = out_dir / 'data'
    film_dir = data_dir_out / 'film'
    if film_dir.exists():
        shutil.rmtree(film_dir)
    film_dir.mkdir(parents=True)
    stale = data_dir_out / 'movies.json'  # old single-file format
    if stale.exists():
        stale.unlink()
    write_json(data_dir_out / 'index.json', index)

    rows = list(movies.itertuples(index=False))
    for i, m in enumerate(rows):
        recs = []
        for j, score in results[i]:
            r = rows[j]
            recs.append({
                'id': int(r.id),
                'score': round(score, 3),
                'match': level(score),
                'why': reasons(m, r, keyword_df),
                'blurb': blurb(r.overview),
            })
        runtime = int(m.runtime) if pd.notna(m.runtime) and m.runtime > 0 else None
        write_json(film_dir / f'{int(m.id)}.json', {
            'id': int(m.id),
            'overview': ' '.join(m.overview.split()),
            'tagline': m.tagline if isinstance(m.tagline, str) else '',
            'runtime': runtime,
            'director': m.director_list[:2],
            'cast': m.cast_list,
            'keywords': m.keyword_list[:8],
            'recs': recs,
        })

    urls = [f'{SITE_URL}/']
    urls += [f'{SITE_URL}/genre/{slugify(g)}' for g in genres]
    urls += [f'{SITE_URL}/film/{int(m.id)}-{slugify(m.title)}' for m in rows]
    sitemap = ['<?xml version="1.0" encoding="UTF-8"?>',
               '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    sitemap += [f'  <url><loc>{escape(u)}</loc></url>' for u in urls]
    sitemap.append('</urlset>')
    (out_dir / 'sitemap.xml').write_text('\n'.join(sitemap) + '\n', encoding='utf-8')

    return index, results


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--data-dir', type=Path, default=ROOT)
    parser.add_argument('--out', type=Path, default=ROOT / 'web', help='site root to write data/ and sitemap.xml into')
    parser.add_argument('--top', type=int, default=TOP_N)
    args = parser.parse_args()

    index, results = build(args.data_dir, args.out, args.top)
    size_kb = (args.out / 'data' / 'index.json').stat().st_size / 1024
    short = sum(1 for r in results if len(r) < args.top)
    print(f"wrote index of {len(index['id'])} films ({size_kb:.0f} KB, version {index['version']}), "
          f"{len(results)} film files, sitemap.xml; {short} films have fewer than {args.top} recommendations")


if __name__ == '__main__':
    main()
