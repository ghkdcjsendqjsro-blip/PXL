import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = path.join(root, 'public');
const portIndex = process.argv.indexOf('--port');
const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('올바른 포트를 지정하세요.');
const origin = `http://localhost:${port}`;
process.env.LOCAL_DEV = 'true';
process.env.APP_ORIGIN ||= origin;

const routes = {
  '/api/generate': '../api/generate.js',
  '/api/feedback': '../api/feedback.js',
  '/api/feedback-image': '../api/feedback-image.js',
  '/api/status': '../api/status.js',
};
const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.webp':'image/webp', '.woff2':'font/woff2', '.ico':'image/x-icon' };

const server = http.createServer(async (incoming, outgoing) => {
  for (const [key,value] of Object.entries(securityHeaders)) outgoing.setHeader(key,value);
  outgoing.setHeader('Cache-Control','no-store');
  try {
    const url = new URL(incoming.url, origin);
    if (routes[url.pathname]) {
      const headers = new Headers();
      for (const [key,value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      }
      const controller = new AbortController();
      incoming.on('aborted', () => controller.abort());
      const options = { method:incoming.method, headers, signal:controller.signal };
      if (!['GET','HEAD'].includes(incoming.method)) {
        options.body = Readable.toWeb(incoming);
        options.duplex = 'half';
      }
      const request = new Request(url, options);
      const route = await import(routes[url.pathname]);
      const response = await route.default.fetch(request);
      outgoing.statusCode = response.status;
      response.headers.forEach((value,key) => outgoing.setHeader(key,value));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      outgoing.writeHead(404, {'Content-Type':'application/json; charset=utf-8'});
      outgoing.end(JSON.stringify({error:{code:'NOT_FOUND',message:'요청한 API를 찾지 못했어요.'}}));
      return;
    }
    if (!['GET','HEAD'].includes(incoming.method)) {
      outgoing.writeHead(405, {Allow:'GET, HEAD'}); outgoing.end(); return;
    }
    const pathname = decodeURIComponent(url.pathname);
    const file = path.resolve(publicRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
    const relative = path.relative(publicRoot,file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part=>part.startsWith('.'))) {
      outgoing.writeHead(404); outgoing.end('Not found'); return;
    }
    const bytes = await readFile(file);
    outgoing.writeHead(200, {'Content-Type':mime[path.extname(file).toLowerCase()] || 'application/octet-stream'});
    outgoing.end(incoming.method === 'HEAD' ? undefined : bytes);
  } catch (error) {
    if (outgoing.headersSent) { outgoing.end(); return; }
    const missing = ['ENOENT','EISDIR'].includes(error.code);
    outgoing.writeHead(missing ? 404 : 500, {'Content-Type':'text/plain; charset=utf-8'});
    outgoing.end(missing ? 'Not found' : '로컬 서버 요청을 처리하지 못했어요.');
    if (!missing) console.error('[local-server]', error.name);
  }
});
server.requestTimeout = 120_000;
server.on('error',error=>{
  console.error(error.code === 'EADDRINUSE' ? `포트 ${port}가 사용 중입니다. npm run dev -- --port 3001 로 실행하세요.` : '로컬 서버를 실행하지 못했습니다.');
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => console.log(`\n  SUMINPIXEL\n  Local: ${origin}\n  종료: Ctrl+C\n`));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close(()=>process.exit()));
