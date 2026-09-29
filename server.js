// Servidor sin dependencias:
//   GET  /api/report   → análisis del dataset en ./data (útil para bots/alertas)
//   POST /api/analyze  → análisis de fuentes enviadas como JSON {serverLog, deployLog, carrierLog, heartbeats, seats}
//   GET  /*            → UI estática (la UI también funciona sin este servidor: el motor corre en el navegador)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from './src/engine/analyze.js';
import { loadDir } from './src/node/load.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC = new Set(['public', 'src', 'data']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml' };
const MAX_BODY = 2 * 1024 * 1024;

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('payload demasiado grande'), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveStatic(res, pathname) {
  const rel = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname)).replace(/^[/\\]+/, '');
  const top = rel.split(/[/\\]/)[0];
  const file = resolve(ROOT, rel);
  // Solo se sirven index.html y las carpetas públicas; nada fuera de ROOT.
  if (!file.startsWith(ROOT + sep) || (rel !== 'index.html' && !PUBLIC.has(top))) return send(res, 404, { error: 'no encontrado' });
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? 'application/octet-stream');
  } catch {
    send(res, 404, { error: 'no encontrado' });
  }
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && pathname === '/api/report') return send(res, 200, analyze(await loadDir(join(ROOT, 'data'))));
    if (req.method === 'POST' && pathname === '/api/analyze') return send(res, 200, analyze(await readBody(req)));
    if (req.method === 'GET') return serveStatic(res, pathname);
    send(res, 405, { error: 'método no permitido' });
  } catch (err) {
    send(res, err.status ?? 400, { error: err.message });
  }
}).listen(PORT, () => console.log(`Centro de Comando de Incidentes → http://localhost:${PORT}`));
