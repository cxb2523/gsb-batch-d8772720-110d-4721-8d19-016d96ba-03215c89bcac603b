import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', 'dist-pages')
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
}

/** A plain static server like GitHub Pages: files under /mecha/, no headers of our own. */
export default async function pagesSetup(): Promise<() => Promise<void>> {
  if (!existsSync(join(ROOT, 'index.html'))) throw new Error('build the web demo first')
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')
    if (!path.startsWith('/mecha/')) {
      res.writeHead(404).end()
      return
    }
    let file = normalize(join(ROOT, path.slice('/mecha/'.length)))
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end()
      return
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
    if (!existsSync(file)) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  writeFileSync(join(import.meta.dirname, '.pages-url'), `http://127.0.0.1:${port}/mecha/`)
  return () => new Promise<void>((ok) => server.close(() => ok()))
}
