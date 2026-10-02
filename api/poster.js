// Vercel serverless function: GET /api/poster?id=<tmdb movie id>
// Returns {poster, backdrop}: TMDB image *paths* such as "/abc123.jpg" (or
// null). The browser builds sized URLs from them (w185/w342/w500), so it can
// pick the right resolution. The API key stays on the server; set
// TMDB_API_KEY in the Vercel project settings (either the v3 API key or the
// v4 "API Read Access Token" works). Without it the endpoint answers
// {configured: false} (as a 200, so browsers don't log an error for every
// poster) and the frontend shows its typographic fallback posters.

const IMAGE_PATH = /^\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/;
const TIMEOUT_MS = 6000;

const clean = (p) => (typeof p === 'string' && IMAGE_PATH.test(p) ? p : null);

module.exports = async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const key = process.env.TMDB_API_KEY;
  if (!key) {
    // Never cached: once TMDB_API_KEY is added and the site redeployed, posters
    // must start working immediately rather than after a CDN cache expires.
    // (The client sends only one probe request per page view in this state.)
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ configured: false, poster: null, backdrop: null });
    return;
  }

  const id = String((req.query && req.query.id) || '');
  if (!/^\d{1,9}$/.test(id)) {
    res.status(400).json({ error: 'id must be a numeric TMDB movie id' });
    return;
  }

  const isBearer = key.startsWith('eyJ');
  const url = `https://api.themoviedb.org/3/movie/${id}${isBearer ? '' : `?api_key=${encodeURIComponent(key)}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: isBearer ? { Authorization: `Bearer ${key}`, accept: 'application/json' } : { accept: 'application/json' },
    });
    if (r.status === 404) {
      res.setHeader('Cache-Control', 'public, s-maxage=86400');
      res.status(200).json({ poster: null, backdrop: null });
      return;
    }
    if (!r.ok) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(502).json({ error: 'The poster service is unavailable' });
      return;
    }
    const m = await r.json();
    res.setHeader('Cache-Control', 'public, s-maxage=2592000, stale-while-revalidate=86400');
    res.status(200).json({ poster: clean(m.poster_path), backdrop: clean(m.backdrop_path) });
  } catch {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: 'The poster service is unavailable' });
  } finally {
    clearTimeout(timer);
  }
};
