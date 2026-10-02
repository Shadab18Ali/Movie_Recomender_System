"""Build the content-based recommendation data used by the web frontend.

Runs the same pipeline as movie-recommender-system.ipynb and writes
web/data/movies.json: movie metadata plus the top-N most similar movies for
every title, so the frontend can be served as static files (e.g. on Vercel)
without shipping pandas/scikit-learn or a 4800x4800 similarity matrix.

Usage:
    python model/build_recommendations.py

tmdb_5000_credits.csv is optional. When it is present next to
tmdb_5000_movies.csv, the top 3 cast members and the director are added to
each movie's tags; without it only overview, genres and keywords are used.
"""

import argparse
import ast
import json
from pathlib import Path

import numpy as np
import pandas as pd
from nltk.stem.porter import PorterStemmer
from sklearn.feature_extraction.text import CountVectorizer
from sklearn.metrics.pairwise import cosine_similarity

ROOT = Path(__file__).resolve().parent.parent
TOP_N = 12

ps = PorterStemmer()


def convert(text):
    return [i['name'] for i in ast.literal_eval(text)]


def convert3(text):
    return convert(text)[:3]


def fetch_director(text):
    return [i['name'] for i in ast.literal_eval(text) if i['job'] == 'Director']


def collapse(L):
    return [i.replace(" ", "") for i in L]


def stem(text):
    return " ".join(ps.stem(word) for word in text.split())


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
    return movies, has_credits


def build_tags(movies):
    df = movies[['id', 'title', 'overview', 'genres', 'keywords', 'cast', 'crew']].copy()
    df['overview'] = df['overview'].fillna('')
    df['genres'] = df['genres'].apply(convert).apply(collapse)
    df['keywords'] = df['keywords'].apply(convert).apply(collapse)
    df['cast'] = df['cast'].apply(convert3).apply(collapse)
    df['crew'] = df['crew'].apply(fetch_director).apply(collapse)
    df['tags'] = (df['overview'].str.split() + df['genres'] + df['keywords']
                  + df['cast'] + df['crew'])
    df['tags'] = df['tags'].apply(lambda x: stem(" ".join(x).lower()))
    return df['tags']


def top_similar(tags, top_n):
    cv = CountVectorizer(max_features=5000, stop_words='english')
    vector = cv.fit_transform(tags)
    similarity = cosine_similarity(vector)
    np.fill_diagonal(similarity, -1)  # never recommend a movie to itself
    idx = np.argsort(-similarity, axis=1)[:, :top_n]
    scores = np.take_along_axis(similarity, idx, axis=1)
    return idx, scores


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--data-dir', type=Path, default=ROOT)
    parser.add_argument('--out', type=Path, default=ROOT / 'web' / 'data' / 'movies.json')
    parser.add_argument('--top', type=int, default=TOP_N)
    args = parser.parse_args()

    movies, has_credits = load_movies(args.data_dir)
    movies = movies.reset_index(drop=True)  # row position == similarity row
    idx, scores = top_similar(build_tags(movies), args.top)

    def names(text, limit=None):
        return convert(text)[:limit]

    records = []
    for i, m in movies.iterrows():
        records.append({
            'id': int(m['id']),
            'title': m['title'],
            'year': m['release_date'][:4] if isinstance(m['release_date'], str) else None,
            'rating': round(float(m['vote_average']), 1),
            'votes': int(m['vote_count']),
            'popularity': round(float(m['popularity']), 2),
            'runtime': int(m['runtime']) if pd.notna(m['runtime']) and m['runtime'] > 0 else None,
            'genres': names(m['genres']),
            'overview': m['overview'] if isinstance(m['overview'], str) else '',
            'cast': convert3(m['cast']),
            'director': fetch_director(m['crew'])[:1],
            'recs': [[int(j), round(float(s), 3)] for j, s in zip(idx[i], scores[i])],
        })

    args.out.parent.mkdir(parents=True, exist_ok=True)
    payload = {'withCredits': has_credits, 'movies': records}
    args.out.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')))
    size_kb = args.out.stat().st_size / 1024
    print(f"wrote {len(records)} movies to {args.out.relative_to(ROOT)} ({size_kb:.0f} KB)")


if __name__ == '__main__':
    main()
