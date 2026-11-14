// Dump a System.register module body from a Cocos/rollup bundle.
// usage: node mod.mjs <file> <moduleName> [maxChars]
import fs from 'node:fs';
const [file, name, maxS = '200000'] = process.argv.slice(2);
const max = +maxS;
const txt = fs.readFileSync(file, 'utf8');
const start = txt.indexOf(`System.register("${name}"`);
if (start < 0) { console.log('(module not found)'); process.exit(1); }
let end = txt.indexOf('System.register("', start + 10);
if (end < 0) end = txt.length;
console.log(txt.slice(start, Math.min(end, start + max)));
console.log(`\n\n[module length: ${end - start} chars]`);
