"""Tests for model/build_recommendations.py and the data it generated in web/data."""

import json
import sys
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'model'))

import build_recommendations as br  # noqa: E402

DATA = ROOT / 'web' / 'data'


# ---------- normalisation ----------
def test_punctuation_does_not_block_stemming():
    assert br.overview_tokens("Crimes, crime and CRIME.") == ['crime', 'crime', 'crime']


def test_stop_words_removed_before_stemming():
    tokens = br.overview_tokens("because they were always above everything")
    assert tokens == []  # 'becaus', 'alway', 'abov' must not leak through


def test_entity_tokens_are_single_alphanumeric_tags():
    assert br.entity_token('Science Fiction') == 'sciencefiction'
    assert br.entity_token('Spider-Man') == 'spiderman'
    assert br.entity_token("Ma'ayan") == 'maayan'


def test_malformed_json_columns_are_tolerated():
    assert br.convert('not json') == []
    assert br.convert(float('nan')) == []
    assert br.fetch_director('[{"job": "Writer", "name": "x"}]') == []


@pytest.mark.parametrize('title, slug', [
    ('Amélie', 'amelie'),
    ('Se7en', 'se7en'),
    ('Batman & Robin', 'batman-robin'),
    ('  ...  ', 'film'),
])
def test_slugify(title, slug):
    assert br.slugify(title) == slug


def test_blurb_cuts_on_word_boundary():
    text = 'word ' * 100
    out = br.blurb(text, 30)
    assert out.endswith('…') and len(out) <= 31 and 'wor…' not in out


# ---------- similarity ----------
CORPUS = pd.Series([
    'space alien war',       # 0
    'space alien war',       # 1 identical to 0
    'space alien',           # 2
    'love romance paris',    # 3
    'zzz',                   # 4 shares nothing with anyone
])


def test_top_similar_excludes_self_sorts_and_limits():
    results = br.top_similar(CORPUS, top_n=2)
    for i, recs in enumerate(results):
        assert all(j != i for j, _ in recs)
        assert len(recs) <= 2
        scores = [s for _, s in recs]
        assert scores == sorted(scores, reverse=True)
    assert results[0][0][0] == 1  # identical document is the best match


def test_top_similar_drops_unrelated_films():
    results = br.top_similar(CORPUS, top_n=4)
    assert results[4] == []  # 'zzz' shares no tags, so nothing is recommended
    assert all(s > 0 for recs in results for _, s in recs)


def test_ties_are_broken_by_popularity_then_order():
    corpus = pd.Series(['a1 b1', 'a1 c1', 'a1 d1', 'a1 e1'])
    by_order = br.top_similar(corpus, top_n=3)
    assert [j for j, _ in by_order[0]] == [1, 2, 3]
    by_pop = br.top_similar(corpus, top_n=3, popularity=[0, 1, 5, 3])
    assert [j for j, _ in by_pop[0]] == [2, 3, 1]


def test_top_similar_is_deterministic():
    assert br.top_similar(CORPUS, top_n=3) == br.top_similar(CORPUS, top_n=3)


# ---------- generated data ----------
needs_data = pytest.mark.skipif(not (DATA / 'index.json').exists(), reason='run model/build_recommendations.py first')


@pytest.fixture(scope='module')
def index():
    return json.loads((DATA / 'index.json').read_text(encoding='utf-8'))


@needs_data
def test_index_columns_line_up(index):
    n = len(index['id'])
    assert n > 4000
    for col in ('title', 'year', 'rating', 'votes', 'pop', 'genre'):
        assert len(index[col]) == n, col
    assert len(set(index['id'])) == n
    assert all(0 <= pos < n for pos, _ in index['alt'])
    assert index['genre'] and max(index['genre']) < (1 << len(index['genres']))


@needs_data
def test_every_film_file_is_valid(index):
    ids = set(index['id'])
    files = list((DATA / 'film').glob('*.json'))
    assert len(files) == len(ids)
    for path in files:
        film = json.loads(path.read_text(encoding='utf-8'))
        assert film['id'] in ids and path.stem == str(film['id'])
        recs = film['recs']
        assert 0 < len(recs) <= br.TOP_N
        assert all(r['id'] != film['id'] for r in recs), 'film recommends itself'
        assert all(r['id'] in ids for r in recs)
        assert len({r['id'] for r in recs}) == len(recs), 'duplicate recommendation'
        scores = [r['score'] for r in recs]
        assert scores == sorted(scores, reverse=True), 'not sorted by similarity'
        assert all(s > 0 for s in scores)
        assert all(r['match'] in (1, 2, 3) for r in recs)


@needs_data
def test_recommendations_are_relevant(index):
    pos = {t: i for i, t in enumerate(index['title'])}

    def recs(title):
        film = json.loads((DATA / 'film' / f"{index['id'][pos[title]]}.json").read_text(encoding='utf-8'))
        by_id = dict(zip(index['id'], index['title']))
        return [by_id[r['id']] for r in film['recs']]

    assert {'The Dark Knight Rises', 'Batman Begins'} <= set(recs('The Dark Knight')[:3])
    assert 'Toy Story 2' in recs('Toy Story')[:5]
