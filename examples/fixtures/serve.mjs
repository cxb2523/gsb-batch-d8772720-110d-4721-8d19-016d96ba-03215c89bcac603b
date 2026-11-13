// serve.mjs — tiny zero-dependency static server for the example fixtures.
//
//   node serve.mjs [PORT]   (default 8080)
//
// Serves files from this directory over plain HTTP so the interception
// examples can be verified fully offline. Unknown paths return a real
// HTTP 404 on purpose: seeing the 404 reach the page proves that a
// pass-through request (e.g. /api/orders) was not blocked or rewritten.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  // Keep every served path inside this directory (no ../ escapes).
  const filePath = normalize(join(here, pathname === '/' ? 'intercept-demo.html' : pathname));
  if (!filePath.startsWith(here)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
    console.log(`200 ${pathname}`);
  } catch {
    // A genuine network response — pass-through requests land here.
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    console.log(`404 ${pathname}`);
  }
});

server.listen(port, () => {
  console.log(`fixture server on http://localhost:${port}`);
  console.log(`demo page:  http://localhost:${port}/intercept-demo.html`);
});
