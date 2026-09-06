import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../public/', import.meta.url));
const port = Number(process.env.PORT || 8788), host = process.env.HOST || '127.0.0.1';
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/bootstrap') return res.end(JSON.stringify({ configured: false, authenticated: false, setupError: '这是静态预览服务器。使用 ?demo=1 体验演示；真实本地调试请运行 npm run dev。' }));
    res.statusCode = 503; return res.end(JSON.stringify({ error: { message: '静态预览不连接 Cloudflare。' } }));
  }
  try {
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { res.statusCode = 400; return res.end('Bad URL'); }
    const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(root) || pathname.startsWith('/_')) { res.statusCode = 403; return res.end('Forbidden'); }
    const bytes = await readFile(file);
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.end(bytes);
  } catch { res.statusCode = 404; res.end('Not found'); }
}).listen(port, host, () => console.log(`Cloudlane demo: http://${host}:${port}/?demo=1 (no Cloudflare API calls)`));