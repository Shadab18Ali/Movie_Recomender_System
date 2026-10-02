// Vercel serverless function: GET /api/poster?id=<tmdb movie id>
// Returns {poster, backdrop} image URLs from TMDB. The API key stays on the
// server; set TMDB_API_KEY in the Vercel project settings (either the v3 API
// key or the v4 "API Read Access Token" works). Without it the frontend
// falls back to generated placeholder posters.

const IMG = 'https://image.tmdb.org/t/p';

module.exports = async (req, res) => {
  const key = process.env.TMDB_API_KEY;
  if (!key) {
    res.status(501).json({ error: 'TMDB_API_KEY is not configured' });
    return;
  }

  const id = String(req.query.id || '');
  if (!/^\d{1,9}$/.test(id)) {
    res.status(400).json({ error: 'id must be a numeric TMDB movie id' });
    return;
  }

  const isBearer = key.startsWith('eyJ');
  const url = `https://api.themoviedb.org/3/movie/${id}${isBearer ? '' : `?api_key=${encodeURIComponent(key)}`}`;

  try {
    const r = await fetch(url, {
      headers: isBearer ? { Authorization: `Bearer ${key}`, accept: 'application/json' } : { accept: 'application/json' },
    });
    if (r.status === 404) {
      res.setHeader('Cache-Control', 'public, s-maxage=86400');
      res.status(200).json({ poster: null, backdrop: null });
      return;
    }
    if (!r.ok) {
      res.status(502).json({ error: `TMDB responded with ${r.status}` });
      return;
    }
    const m = await r.json();
    res.setHeader('Cache-Control', 'public, s-maxage=2592000, stale-while-revalidate=86400');
    res.status(200).json({
      poster: m.poster_path ? `${IMG}/w342${m.poster_path}` : null,
      backdrop: m.backdrop_path ? `${IMG}/w1280${m.backdrop_path}` : null,
    });
  } catch {
    res.status(502).json({ error: 'Could not reach TMDB' });
  }
};
