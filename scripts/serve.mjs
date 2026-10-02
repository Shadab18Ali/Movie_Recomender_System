// Local dev server that mirrors the Vercel deployment closely enough for
// development and end-to-end tests:
//   - serves web/ as static files with brotli/gzip compression
//   - applies the same rewrites as vercel.json (client-side routes -> index.html)
//   - mounts api/*.js serverless functions (req.query / res.status().json())
//
// Usage: node scripts/serve.mjs [port]      (default 3000)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const WEB = join(ROOT, 'web');
const require = createRequire(import.meta.url);
const vercel = JSON.parse(await readFile(join(ROOT, 'vercel.json'), 'utf8'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// "/film/:slug" -> RegExp
const toRegExp = (source) => new RegExp(`^${source.replace(/:[a-z]+\*/gi, '.*').replace(/:[a-z]+/gi, '[^/]+')}$`);
const rewrites = (vercel.rewrites || []).map((r) => ({ re: toRegExp(r.source), dest: r.destination }));
const headerRules = (vercel.headers || []).map((r) => ({ re: toRegExp(r.source), headers: r.headers }));

// Same response headers as production (CSP, caching, ...), matched on the requested path.
function applyHeaders(res, path) {
  for (const rule of headerRules) {
    if (rule.re.test(path)) rule.headers.forEach(({ key, value }) => res.setHeader(key, value));
  }
}

function wrapResponse(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
    return res;
  };
  return res;
}

// Compressed bodies are cached per file+mtime so large JSON isn't recompressed on every request.
const compressed = new Map();
function compress(file, mtime, encoding, body) {
  const key = `${file}:${mtime}:${encoding}`;
  if (!compressed.has(key)) {
    compressed.set(key, encoding === 'br'
      ? brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } })
      : gzipSync(body, { level: 9 }));
  }
  return compressed.get(key);
}

async function sendFile(req, res, file, status = 200, path = '') {
  const body = await readFile(file);
  const { mtimeMs } = await stat(file);
  const type = TYPES[extname(file)] || 'application/octet-stream';
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-cache');
  applyHeaders(res, path);
  const accept = req.headers['accept-encoding'] || '';
  const compressible = /text|json|xml|svg|javascript/.test(type) && body.length > 1024;
  if (compressible && accept.includes('br')) {
    res.setHeader('Content-Encoding', 'br');
    res.writeHead(status).end(compress(file, mtimeMs, 'br', body));
  } else if (compressible && accept.includes('gzip')) {
    res.setHeader('Content-Encoding', 'gzip');
    res.writeHead(status).end(compress(file, mtimeMs, 'gzip', body));
  } else {
    res.writeHead(status).end(body);
  }
}

async function isFile(p) {
  try { return (await stat(p)).isFile(); } catch { return false; }
}

const port = Number(process.argv[2] || process.env.PORT || 3000);

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    const requested = decodeURIComponent(url.pathname);
    let path = requested;
    applyHeaders(res, requested);

    if (path.startsWith('/api/')) {
      const name = path.slice(5).replace(/[^a-z0-9-]/gi, '');
      const file = join(ROOT, 'api', `${name}.js`);
      if (!(await isFile(file))) { res.writeHead(404).end('Not found'); return; }
      req.query = Object.fromEntries(url.searchParams);
      await require(file)(req, wrapResponse(res));
      return;
    }

    const rewrite = rewrites.find((r) => r.re.test(path));
    if (rewrite) path = rewrite.dest;
    if (path.endsWith('/')) path += 'index.html';

    const file = normalize(join(WEB, path));
    if (!file.startsWith(WEB)) { res.writeHead(403).end(); return; }
    if (await isFile(file)) { await sendFile(req, res, file, 200, requested); return; }
    await sendFile(req, res, join(WEB, '404.html'), 404, requested);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500).end('Server error');
  }
}).listen(port, () => console.log(`Double Feature dev server: http://localhost:${port}`));
