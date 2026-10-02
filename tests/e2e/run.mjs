// End-to-end tests against the local dev server (same rewrites, headers and
// API function as Vercel). Run: npm run test:e2e
// Needs Playwright's Chromium (`npx playwright install chromium` once).

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORT = 3200 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.E2E_SCREENSHOTS || '';
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const results = [];
async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✗ ${name}\n      ${String(err?.message || err).split('\n').join('\n      ')}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const server = spawn(process.execPath, ['scripts/serve.mjs', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => { if (String(d).includes('http://')) resolve(); });
  server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
});

const browser = await chromium.launch();

/**
 * New page with Google Fonts stubbed (external, not under test) and every
 * console error / page error / CSP violation recorded.
 */
async function open(path = '/', { viewport = { width: 1280, height: 900 }, javaScriptEnabled = true, reducedMotion = 'no-preference', bypassCSP = false, setup } = {}) {
  const context = await browser.newContext({ viewport, javaScriptEnabled, reducedMotion, bypassCSP });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  if (setup) await setup(page, context);
  if (path) await page.goto(BASE + path);
  page.errors = errors;
  page.done = async () => context.close();
  return page;
}

const noErrors = (page, allow = []) => {
  const unexpected = page.errors.filter((e) => !allow.some((re) => re.test(e)));
  assert(unexpected.length === 0, `console errors:\n${unexpected.join('\n')}`);
};

async function filmJSON(page, id) {
  return page.evaluate(async (i) => (await fetch(`/data/film/${i}.json`)).json(), id);
}

console.log(`\nDouble Feature e2e — ${BASE}\n`);

// ---------- loading ----------
await test('shell (hero + working search) renders before the index arrives; skeleton, then content', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const page = await open(null, {
    setup: (p) => p.route('**/data/index.json', async (r) => { await gate; await r.continue(); }),
  });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#hero-title');
  assert(await page.isVisible('#q-hero'), 'hero search visible');
  assert(await page.isEnabled('#q-hero'), 'search usable while loading');
  assert(await page.locator('.skeleton').first().isVisible(), 'skeleton shown while loading');
  assert(!(await page.content()).includes('Loading the index'), 'old loading text gone');
  await page.fill('#q-hero', 'incep');
  await page.waitForSelector('#q-hero-list .suggestion--skeleton');
  release();
  await page.waitForSelector('#q-hero-list [role="option"]');
  assert((await page.textContent('#q-hero-list [role="option"]')).includes('Inception'), 'suggestion appears once loaded');
  await page.waitForSelector('.browse .grid .card');
  assert(await page.locator('.static-skeleton:visible').count() === 0, 'static skeleton removed');
  noErrors(page);
  await page.done();
});

await test('index is downloaded once and reused across navigation; film data is cached', async () => {
  const counts = {};
  const page = await open('/', { setup: (p) => p.on('request', (r) => { const u = new URL(r.url()).pathname; counts[u] = (counts[u] || 0) + 1; }) });
  await page.waitForSelector('.grid .card');
  await page.click('.grid .card >> nth=0');
  await page.waitForSelector('.grid--recs .card');
  await page.click('.crumbs a >> text=Home');
  await page.waitForSelector('.browse .grid .card');
  await page.goBack();
  await page.waitForSelector('.grid--recs .card');
  assert(counts['/data/index.json'] === 1, `index.json requested ${counts['/data/index.json']} times`);
  const filmReqs = Object.entries(counts).filter(([u]) => u.startsWith('/data/film/'));
  assert(filmReqs.every(([, n]) => n === 1), `film json refetched: ${JSON.stringify(filmReqs)}`);
  noErrors(page);
  await page.done();
});

await test('failed index request shows a helpful error and "Try again" recovers', async () => {
  let fail = true;
  const page = await open('/', { setup: (p) => p.route('**/data/index.json', (r) => (fail ? r.fulfill({ status: 503, body: 'down' }) : r.continue())) });
  await page.waitForSelector('.notice--error', { timeout: 10000 });
  const text = await page.textContent('.notice--error');
  assert(/couldn’t load the film collection/i.test(text) && !/503|stack|Error:/i.test(text), `message: ${text}`);
  fail = false;
  await page.click('.notice--error button:has-text("Try again")');
  await page.waitForSelector('.browse .grid .card');
  noErrors(page, [/503/]);
  await page.done();
});

await test('network failure on a film page: header still renders, recommendations retry', async () => {
  let fail = true;
  const page = await open('/film/155-the-dark-knight', { setup: (p) => p.route('**/data/film/155.json*', (r) => (fail ? r.abort('internetdisconnected') : r.continue())) });
  await page.waitForSelector('.recs .notice--error', { timeout: 10000 });
  assert((await page.textContent('.film-title')) === 'The Dark Knight', 'title from index still shown');
  fail = false;
  await page.click('.recs button:has-text("Try again")');
  await page.waitForSelector('.grid--recs .card');
  noErrors(page, [/ERR_INTERNET_DISCONNECTED/]);
  await page.done();
});

await test('a hung request times out instead of loading forever', async () => {
  const page = await open('/', { setup: (p) => p.route('**/data/index.json', () => { /* never answer */ }) });
  await page.waitForSelector('.notice--error', { timeout: 40000 });
  assert(/too long/i.test(await page.textContent('.notice--error')), 'timeout message');
  await page.done();
});

await test('malformed index data shows the error state, not a crash', async () => {
  const page = await open('/', { setup: (p) => p.route('**/data/index.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"id":[1],"genres":[]}' })) });
  await page.waitForSelector('.notice--error');
  noErrors(page);
  await page.done();
});

// ---------- search ----------
await test('search: partial title, keyboard selection, Enter opens the film', async () => {
  const page = await open('/');
  await page.waitForSelector('.grid .card');
  await page.fill('#q-hero', 'dark kni');
  await page.waitForSelector('#q-hero-list [role="option"]');
  assert((await page.textContent('#q-hero-list [role="option"] >> nth=0')).startsWith('The Dark Knight'), 'best match first');
  await page.keyboard.press('ArrowDown');
  assert(await page.getAttribute('#q-hero', 'aria-activedescendant') === 'q-hero-list-0', 'aria-activedescendant set');
  await page.keyboard.press('Enter');
  await page.waitForURL('**/film/155-the-dark-knight');
  await page.waitForSelector('.grid--recs .card');
  assert(await page.evaluate(() => document.activeElement?.tagName) === 'H1', 'focus moved to page heading');
  noErrors(page);
  await page.done();
});

await test('search: no results, special characters, empty submit, clear and Escape', async () => {
  const page = await open('/');
  await page.waitForSelector('.grid .card');
  await page.fill('#q-hero', 'qwertyzzz');
  await page.waitForSelector('#q-hero-list .suggestion--message');
  assert(/No films match/.test(await page.textContent('#q-hero-list')), 'no-results message');
  await page.fill('#q-hero', '@#$%^&*');
  await page.waitForSelector('#q-hero-list .suggestion--message');
  await page.keyboard.press('Escape');
  assert(await page.isHidden('#q-hero-list'), 'Escape closes suggestions');
  await page.click('#hero .search-clear');
  assert(await page.inputValue('#q-hero') === '' && await page.isHidden('#hero .search-clear'), 'clear button resets');
  await page.click('#hero button[type="submit"]');
  assert(new URL(page.url()).pathname === '/', 'empty search does not navigate');
  await page.fill('#q-hero', 'batman');
  await page.keyboard.press('Enter'); // no option highlighted -> results page
  await page.waitForURL('**/search?q=batman');
  await page.waitForSelector('.page .grid .card');
  assert(await page.locator('.page .grid .card').count() >= 5, 'results grid');
  await page.goto(BASE + '/search?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
  await page.waitForSelector('.notice');
  assert(await page.locator('script:text("alert(1)")').count() === 0, 'query is rendered as text, never HTML');
  noErrors(page);
  await page.done();
});

// ---------- recommendations ----------
await test('recommendations: 12 results, never the film itself, sorted, relevant, explained', async () => {
  const page = await open('/film/155');
  await page.waitForURL('**/film/155-the-dark-knight'); // canonical slug added
  await page.waitForSelector('.grid--recs .card');
  const data = await filmJSON(page, 155);
  const cards = await page.locator('.grid--recs .card').evaluateAll((els) => els.map((a) => a.getAttribute('href')));
  assert(cards.length === 12, `expected 12, got ${cards.length}`);
  assert(cards.every((href) => !href.startsWith('/film/155-')), 'film recommends itself');
  assert(JSON.stringify(cards.map((h) => Number(h.split('/')[2].split('-')[0]))) === JSON.stringify(data.recs.map((r) => r.id)), 'order matches data');
  const scores = data.recs.map((r) => r.score);
  assert(scores.every((s, i) => i === 0 || scores[i - 1] >= s), 'sorted by similarity');
  assert((await page.textContent('.grid--recs .card-title >> nth=0')) === 'The Dark Knight Rises', 'best match is relevant');
  assert(/Because you liked\s*The Dark Knight, you may also like/.test(await page.textContent('#recs-title')), 'clear explanation heading');
  assert(await page.locator('.grid--recs .why li').count() >= 12, 'every card explains why');
  assert(await page.title() === 'The Dark Knight (2008) · Double Feature', `title: ${await page.title()}`);
  assert((await page.getAttribute('link[rel="canonical"]', 'href')).endsWith('/film/155-the-dark-knight'), 'canonical updated');
  noErrors(page);
  await page.done();
});

await test('legacy #/movie and #/genre links redirect; unknown film and page are handled', async () => {
  const page = await open('/#/movie/155');
  await page.waitForURL('**/film/155-the-dark-knight');
  await page.goto(BASE + '/#/genre/Science%20Fiction');
  await page.waitForURL('**/genre/science-fiction');
  await page.waitForSelector('a.chip[aria-current="page"]:has-text("Science Fiction")');
  await page.goto(BASE + '/film/999999999-nope');
  await page.waitForSelector('h1:has-text("couldn’t find that film")');
  const res = await page.goto(BASE + '/definitely-not-a-page');
  assert(res.status() === 404 && (await page.textContent('h1')) === 'Page not found', '404 page');
  noErrors(page, [/404/]);
  await page.done();
});

await test('browse: genre filter keeps place, sort, show more, back button', async () => {
  const page = await open('/');
  await page.waitForSelector('.browse .grid .card');
  assert(await page.locator('.browse .grid .card').count() === 24, 'first page of 24');
  await page.click('button:has-text("Show more films")');
  assert(await page.locator('.browse .grid .card').count() === 48, 'show more adds 24');
  await page.click('a.chip:has-text("Animation")');
  await page.waitForURL('**/genre/animation');
  await page.waitForSelector('h2:has-text("Animation films")');
  assert(await page.evaluate(() => document.activeElement?.id) === 'browse-title', 'focus on list heading');
  await page.selectOption('#sort', 'top');
  await page.waitForURL('**/genre/animation?sort=top');
  assert(await page.evaluate(() => document.activeElement?.id) === 'sort', 'focus stays on sort');
  assert((await page.textContent('.browse .card-title >> nth=0')) === 'Spirited Away', 'top rated animation');
  await page.goBack();
  await page.waitForURL(`${BASE}/`);
  await page.waitForSelector('h2:has-text("Browse the collection")');
  noErrors(page);
  await page.done();
});

// ---------- posters ----------
await test('posters: unconfigured API -> typographic fallbacks, one probe request, no errors', async () => {
  let calls = 0;
  const page = await open('/', { setup: (p) => p.on('request', (r) => { if (r.url().includes('/api/poster')) calls += 1; }) });
  await page.waitForSelector('.grid .card');
  await page.waitForTimeout(500);
  assert(calls === 1, `expected a single probe, got ${calls}`);
  assert(await page.locator('.poster img').count() === 0, 'no broken images');
  assert(await page.locator('.poster-fallback').first().isVisible(), 'fallback visible');
  noErrors(page);
  await page.done();
});

await test('posters: real posters load lazily with alt text; broken images fall back', async () => {
  const page = await open(null, {
    setup: async (p) => {
      await p.route('**/api/poster*', (r) => {
        const id = new URL(r.request().url()).searchParams.get('id');
        r.fulfill({ json: { poster: `/p${id}.jpg`, backdrop: `/b${id}.jpg` } });
      });
      await p.route('https://image.tmdb.org/**', (r) => (r.request().url().includes('/p807.jpg')
        ? r.fulfill({ status: 404, body: '' })
        : r.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX })));
    },
  });
  await page.goto(BASE + '/film/155-the-dark-knight');
  await page.waitForSelector('.film-hero .poster.has-image img');
  assert(await page.getAttribute('.film-hero .poster img', 'alt') === 'Poster for The Dark Knight (2008)', 'main poster alt');
  assert(await page.getAttribute('.film-hero .poster img', 'loading') === 'eager', 'hero poster is eager');
  await page.waitForSelector('.grid--recs .poster.has-image img');
  assert(await page.getAttribute('.grid--recs .poster img >> nth=0', 'alt') === '', 'card posters are decorative (title is in the link)');
  assert(await page.getAttribute('.grid--recs .poster img >> nth=0', 'loading') === 'lazy', 'card posters lazy-load');
  assert((await page.getAttribute('.grid--recs .poster img >> nth=0', 'srcset')).includes('w185'), 'responsive srcset');
  await page.waitForSelector('.film-backdrop.is-loaded');
  await page.goto(BASE + '/film/807-se7en');
  await page.waitForSelector('.film-hero .poster-fallback');
  await page.waitForTimeout(500);
  assert(await page.locator('.film-hero .poster img').count() === 0, 'broken image removed, fallback kept');
  noErrors(page, [/404/]);
  await page.done();
});

await test('posters: API failure (500) leaves fallbacks and does not break the page', async () => {
  const page = await open('/film/155-the-dark-knight', { setup: (p) => p.route('**/api/poster*', (r) => r.fulfill({ status: 500, body: 'x' })) });
  await page.waitForSelector('.grid--recs .card');
  assert(await page.locator('.poster img').count() === 0, 'no images');
  noErrors(page, [/500/]);
  await page.done();
});

// ---------- responsive ----------
const WIDTHS = [320, 375, 390, 430, 768, 1024, 1280, 1440, 1920];
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
await test(`no horizontal overflow or tiny targets at ${WIDTHS.join(', ')}px`, async () => {
  const problems = [];
  for (const width of WIDTHS) {
    const page = await open(null, { viewport: { width, height: 900 } });
    for (const path of ['/', '/film/155-the-dark-knight', '/search?q=star']) {
      await page.goto(BASE + path);
      await page.waitForSelector(path.startsWith('/film') ? '.grid--recs .card' : '.grid .card');
      const report = await page.evaluate(() => {
        const out = { overflow: document.documentElement.scrollWidth - window.innerWidth, small: [] };
        for (const el of document.querySelectorAll('a, button, input, select')) {
          const r = el.getBoundingClientRect();
          const inline = el.tagName === 'A' && el.closest('p, dd, li.crumb, .crumbs, .site-footer');
          if (!r.width || !r.height || inline || getComputedStyle(el).visibility === 'hidden') continue;
          if (r.width < 24 || r.height < 24) out.small.push(`${el.tagName}.${el.className} ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
        return out;
      });
      if (report.overflow > 0) problems.push(`${width}px ${path}: overflows by ${report.overflow}px`);
      if (report.small.length) problems.push(`${width}px ${path}: small targets ${report.small.slice(0, 3).join(', ')}`);
      if (SHOTS && [320, 390, 768, 1440].includes(width)) {
        await page.screenshot({ path: `${SHOTS}/${width}${path.replace(/[^a-z0-9]+/gi, '_')}.png`, fullPage: true });
      }
    }
    noErrors(page);
    await page.done();
  }
  assert(problems.length === 0, problems.join('\n'));
});

// ---------- accessibility ----------
await test('keyboard only: skip link, search, navigation, visible focus', async () => {
  const page = await open('/');
  await page.waitForSelector('.grid .card');
  await page.keyboard.press('Tab');
  assert(await page.evaluate(() => document.activeElement?.className) === 'skip-link', 'skip link is first');
  assert(await page.isVisible('.skip-link'), 'skip link visible on focus');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab'); // first "try" chip or search
  const focused = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent?.trim());
  for (let i = 0; i < 4 && (await focused()) !== 'q-hero'; i += 1) await page.keyboard.press('Shift+Tab');
  assert(await focused() === 'q-hero', 'reached hero search by keyboard');
  await page.keyboard.type('toy stor');
  await page.waitForSelector('#q-hero-list [role="option"]');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForURL('**/film/862-toy-story');
  await page.waitForSelector('.grid--recs .card');
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => document.activeElement?.closest('.grid--recs') != null)) break;
  }
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  assert(outline !== 'none', 'focused card has a visible outline');
  noErrors(page);
  await page.done();
});

await test('axe-core: no WCAG A/AA violations on home, film, search, error and 404 pages', async () => {
  const violations = [];
  const pages = [
    ['/', '.grid .card'],
    ['/film/155-the-dark-knight', '.grid--recs .card'],
    ['/search?q=love', '.grid .card'],
    ['/search?q=zzzzzz', '.notice'],
    ['/nope', 'h1'],
  ];
  for (const [path, ready] of pages) {
    const page = await open(path, { bypassCSP: true }); // only so axe itself can be injected
    await page.waitForSelector(ready);
    await page.addScriptTag({ content: AXE });
    const res = await page.evaluate(() => window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }));
    for (const v of res.violations) violations.push(`${path}: ${v.id} (${v.impact}) — ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join('; ')}`);
    await page.done();
  }
  assert(violations.length === 0, violations.join('\n'));
});

await test('prefers-reduced-motion disables skeleton shimmer and transitions', async () => {
  const page = await open('/', { reducedMotion: 'reduce' });
  await page.waitForSelector('.grid .card');
  const anim = await page.evaluate(() => {
    const el = document.createElement('div');
    el.className = 'skeleton';
    document.body.append(el);
    return getComputedStyle(el).animationName;
  });
  assert(anim === 'none', `animation: ${anim}`);
  await page.done();
});

await test('without JavaScript the page explains itself instead of a stuck loader', async () => {
  const page = await open('/', { javaScriptEnabled: false });
  assert(await page.isVisible('#hero-title'), 'hero visible');
  assert(await page.isVisible('noscript, .notice'), 'noscript notice');
  assert(await page.locator('.static-skeleton:visible').count() === 0, 'no endless skeleton');
  assert((await page.locator('.try a').count()) >= 5, 'crawlable film links');
  await page.done();
});

await test('SEO: metadata, robots.txt, sitemap.xml and security headers', async () => {
  const page = await open('/');
  const meta = await page.evaluate(() => ({
    title: document.title,
    desc: document.querySelector('meta[name="description"]')?.content,
    canonical: document.querySelector('link[rel="canonical"]')?.href,
    og: document.querySelector('meta[property="og:image"]')?.content,
    tw: document.querySelector('meta[name="twitter:card"]')?.content,
    h1: document.querySelectorAll('h1').length,
    lang: document.documentElement.lang,
  }));
  assert(meta.title === 'Double Feature — Movie Recommendation System', meta.title);
  assert(meta.desc?.length > 80 && meta.canonical && meta.og?.endsWith('/og.png') && meta.tw === 'summary_large_image' && meta.lang === 'en', JSON.stringify(meta));
  assert(meta.h1 === 1, `exactly one h1 (got ${meta.h1})`);
  await page.goto(BASE + '/film/155-the-dark-knight');
  await page.waitForSelector('.film-title');
  assert(await page.locator('h1:visible').count() === 1, 'film page has one visible h1');
  const robots = await (await page.request.get(BASE + '/robots.txt')).text();
  assert(robots.includes('Sitemap:'), 'robots.txt references sitemap');
  const sitemap = await (await page.request.get(BASE + '/sitemap.xml')).text();
  assert((sitemap.match(/<loc>/g) || []).length > 4800, 'sitemap lists films');
  const res = await page.request.get(BASE + '/');
  assert(res.headers()['content-security-policy']?.includes("script-src 'self'"), 'CSP header');
  for (const asset of ['/og.png', '/favicon.svg', '/apple-touch-icon.png', '/site.webmanifest']) {
    assert((await page.request.get(BASE + asset)).ok(), `${asset} exists`);
  }
  await page.done();
});

await browser.close();
server.kill();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed\n`);
process.exit(failed.length ? 1 : 0);
