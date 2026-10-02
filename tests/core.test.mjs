import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  browseFilms, decodeIndex, describeWhy, isImagePath, normalize, parseRoute, searchFilms, slugify,
} from '../web/js/core.js';

const raw = {
  version: 'test',
  genres: ['Action', 'Animation', 'Drama'],
  id: [1, 2, 3, 4, 5],
  title: ['Frozen', 'Frozen River', 'The Frozen Ground', 'Amélie', 'Se7en'],
  year: [2013, 2008, 2013, 2001, 0],
  rating: [73, 66, 63, 78, 81],
  votes: [5000, 100, 300, 3000, 0],
  pop: [1000, 50, 80, 400, 300],
  genre: [0b010, 0b100, 0b001, 0b100, 0],
  alt: [[3, "Le Fabuleux Destin d'Amélie Poulain"]],
};
const index = decodeIndex(raw);

test('normalize strips accents, case and punctuation', () => {
  assert.equal(normalize('  Amélie!  '), 'amelie');
  assert.equal(normalize("Ocean's Eleven"), 'ocean s eleven');
  assert.equal(normalize('***'), '');
});

test('slugify matches the Python implementation for shared fixtures', () => {
  assert.equal(slugify('Amélie'), 'amelie');
  assert.equal(slugify('Se7en'), 'se7en');
  assert.equal(slugify('Batman & Robin'), 'batman-robin');
  assert.equal(slugify('  ...  '), 'film');
});

test('decodeIndex builds film objects and rejects malformed data', () => {
  assert.equal(index.films.length, 5);
  assert.deepEqual(index.films[0].genres, ['Animation']);
  assert.equal(index.films[0].rating, 7.3);
  assert.equal(index.films[4].rating, null, 'no votes means no rating');
  assert.equal(index.films[4].year, null);
  assert.equal(index.byId.get(4).altTitle, "Le Fabuleux Destin d'Amélie Poulain");
  assert.throws(() => decodeIndex({}), /malformed/);
  assert.throws(() => decodeIndex({ ...raw, title: ['x'] }), /title/);
});

test('search ranks exact, prefix, word and substring matches', () => {
  const titles = (q) => searchFilms(index.films, q).map((f) => f.title);
  assert.deepEqual(titles('frozen'), ['Frozen', 'Frozen River', 'The Frozen Ground']);
  assert.deepEqual(titles('FROZ'), ['Frozen', 'Frozen River', 'The Frozen Ground']);
  assert.deepEqual(titles('ground frozen'), ['The Frozen Ground'], 'all words, any order');
  assert.deepEqual(titles('amelie'), ['Amélie'], 'accent-insensitive');
  assert.deepEqual(titles('fabuleux'), ['Amélie'], 'original title');
  assert.deepEqual(titles('zzzz'), []);
  assert.deepEqual(titles(''), []);
  assert.deepEqual(titles('%$#'), [], 'special characters only');
  assert.deepEqual(titles("se7en!!"), ['Se7en']);
  assert.equal(searchFilms(index.films, 'e', 2).length, 2, 'limit respected');
});

test('browseFilms filters by genre and sorts', () => {
  assert.deepEqual(browseFilms(index.films).map((f) => f.id), [1, 4, 5, 3, 2]);
  assert.deepEqual(browseFilms(index.films, { genre: 'Drama' }).map((f) => f.id), [4, 2]);
  assert.deepEqual(browseFilms(index.films, { sort: 'top' }).map((f) => f.id), [4, 1, 3], 'needs 300+ votes');
  assert.deepEqual(browseFilms(index.films, { sort: 'new' }).map((f) => f.id), [1, 3, 2, 4, 5]);
});

test('parseRoute handles paths, queries, legacy hashes and junk', () => {
  assert.deepEqual(parseRoute('/'), { name: 'home', genreSlug: null, sort: 'popular' });
  assert.deepEqual(parseRoute('/film/109445-frozen'), { name: 'film', id: 109445, slug: 'frozen' });
  assert.deepEqual(parseRoute('/film/109445'), { name: 'film', id: 109445, slug: '' });
  assert.deepEqual(parseRoute('/genre/science-fiction', '?sort=top'), { name: 'home', genreSlug: 'science-fiction', sort: 'top' });
  assert.equal(parseRoute('/', '?sort=evil').sort, 'popular');
  assert.deepEqual(parseRoute('/search', '?q=dark%20knight'), { name: 'search', query: 'dark knight' });
  assert.equal(parseRoute('/search', `?q=${'x'.repeat(500)}`).query.length, 200);
  assert.deepEqual(parseRoute('/', '', '#/movie/155'), { name: 'film', id: 155, legacy: true });
  assert.equal(parseRoute('/', '', '#/genre/%E0%A4%A').name, 'home', 'malformed escape does not throw');
  assert.equal(parseRoute('/film/abc').name, 'notfound');
  assert.equal(parseRoute('/nope').name, 'notfound');
});

test('describeWhy produces readable reasons and tolerates bad input', () => {
  assert.deepEqual(describeWhy({ director: 'Christopher Nolan', keywords: ['gotham city'], genres: ['Action', 'Crime'] }),
    ['Same director: Christopher Nolan', 'Shared themes: gotham city', 'Action · Crime']);
  assert.deepEqual(describeWhy(null), []);
  assert.deepEqual(describeWhy({ cast: 'not a list' }), []);
});

test('only well-formed TMDB image paths are accepted', () => {
  assert.ok(isImagePath('/kqjL17yufvn9OVLyXYpvtyrFfak.jpg'));
  assert.ok(!isImagePath('https://evil.example/x.jpg'));
  assert.ok(!isImagePath('/../x.jpg'));
  assert.ok(!isImagePath(null));
});

test('real index.json decodes', () => {
  const real = decodeIndex(JSON.parse(readFileSync(new URL('../web/data/index.json', import.meta.url))));
  assert.ok(real.films.length > 4000);
  assert.equal(searchFilms(real.films, 'the dark knight')[0].title, 'The Dark Knight');
});
