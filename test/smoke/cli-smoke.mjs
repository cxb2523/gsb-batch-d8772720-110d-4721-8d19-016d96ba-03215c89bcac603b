// Standalone smoke harness (not part of node --test): emulates the HasData MCP endpoint well
// enough to drive bin/catalog-scan.mjs end to end. Run with:
//   node test/smoke/cli-smoke.mjs
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workdir = await mkdtemp(path.join(os.tmpdir(), 'catalog-scan-smoke-'));

let productHits = 0;
const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
        const rpc = JSON.parse(body);
        const tool = rpc.params.name;
        const args = rpc.params.arguments ?? {};
        const reply = (payload) =>
            JSON.stringify({
                jsonrpc: '2.0',
                id: rpc.id,
                result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
            });

        if (tool === 'hasdata_shopify_collections_getCollections') {
            response.end(
                reply({ collections: [{ handle: 'shoes', products_count: 251 }, { handle: 'empty', products_count: 0 }] })
            );
            return;
        }

        productHits += 1;
        if (args.collection === 'shoes' && args.page === 1 && productHits <= 2) {
            response.writeHead(429);
            response.end('rate limited');
            return;
        }
        if (args.collection === 'shoes' && args.page === 1) {
            const products = Array.from({ length: 250 }, (_, i) => ({
                handle: `shoe-${i}`,
                title: `Shoe ${i}`,
                variants: [{ price: `${10 + i}.00`, compare_at_price: i === 0 ? '20.00' : null, available: i !== 249 }],
            }));
            response.end(reply({ products }));
            return;
        }
        if (args.collection === 'shoes' && args.page === 2) {
            response.end(
                reply({
                    products: [
                        { handle: 'last-shoe', title: 'Last Shoe', variants: [{ price: '99.00', compare_at_price: null, available: false }] },
                    ],
                })
            );
            return;
        }
        response.end(reply({ products: [] }));
    });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
const output = path.join(workdir, 'scan.json');

function run(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(repoRoot, 'bin/catalog-scan.mjs'), ...args], {
            env: { ...process.env, HASDATA_API_KEY: 'smoke-key' },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('exit', (code) => resolve({ code, stdout, stderr }));
        child.on('error', reject);
    });
}

try {
    const first = await run(['https://shop.example.com', '--endpoint', endpoint, '--output', output]);
    console.log('--- exit code:', first.code);
    console.log(first.stderr.trim());

    const record = JSON.parse(await readFile(output, 'utf8'));
    const report = await readFile(output.replace(/\.json$/, '') + '.md', 'utf8');
    if (!report.includes('# Catalogue scan: https://shop.example.com')) throw new Error('markdown report missing');
    console.log('--- totals:', JSON.stringify(record.totals));
    console.log('--- page outcomes:', JSON.stringify(record.page_outcomes.map((r) => [r.collection, r.page, r.outcome, r.products_on_page, r.cumulative_products, r.attempts])));
    console.log('--- collections:', JSON.stringify(record.collections.map((c) => [c.collection, c.status, c.pages, c.product_count, c.price_min, c.price_max]), null, 0));
    console.log('--- sold out:', JSON.stringify(record.sold_out_products.map((p) => p.handle)));

    // Resume should skip both collections without any product calls.
    const hitsBeforeResume = productHits;
    const second = await run(['--resume', output, '--endpoint', endpoint]);
    console.log('--- resume exit code:', second.code, '| new product calls:', productHits - hitsBeforeResume);
    if (productHits !== hitsBeforeResume) throw new Error('resume re-fetched a completed collection');

    if (first.code !== 0 || second.code !== 0) throw new Error('expected clean exit codes');
    if (record.totals.products !== 251) throw new Error('expected 251 products');
    if (record.totals.empty_pages !== 1) throw new Error('expected one empty page');
    const soldOutHandles = record.sold_out_products.map((p) => p.handle).sort();
    if (JSON.stringify(soldOutHandles) !== JSON.stringify(['last-shoe', 'shoe-249'])) {
        throw new Error(`expected last-shoe and shoe-249 sold out, got ${JSON.stringify(soldOutHandles)}`);
    }
    const shoes = record.collections.find((c) => c.collection === 'shoes');
    if (shoes.price_min !== 10 || shoes.price_max !== 259) throw new Error('unexpected shoes price range');
    console.log('SMOKE OK');
} finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(workdir, { recursive: true, force: true });
}
