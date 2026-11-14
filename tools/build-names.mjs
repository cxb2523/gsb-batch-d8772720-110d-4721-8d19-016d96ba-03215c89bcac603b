import fs from 'node:fs';
import path from 'node:path';

// The game ships its id-to-name tables as inlined enum IIFEs in the bundle:
//   e("FlyTargetName",function(e){return e.FLY_GOLD="黄金",...}({}))
//   _("SeaItemName",function(_){return _.SEA_FISH="鱼",... }({}))
// There is no .proto or config feed for these, so scrape them out of the source.

const ROOT = path.resolve(import.meta.dirname, '../work/extracted');
const OUT = path.resolve(import.meta.dirname, '../work/names.json');

const ENUM = /[A-Za-z_$]\(\s*"([A-Za-z][A-Za-z0-9_]{2,48})"\s*,\s*function\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)\s*\{\s*return\s+([\s\S]{0,6000}?)\}\s*\(\s*\{\s*\}\s*\)\s*\)/g;
const ASSIGN = /\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|(\d+))/g;

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.js')) yield full;
  }
}

const enums = {};
let files = 0;

for (const file of walk(ROOT)) {
  const source = fs.readFileSync(file, 'utf8');
  files += 1;
  for (const match of source.matchAll(ENUM)) {
    const [, name, param, body] = match;
    // The body must only assign onto the IIFE parameter, otherwise this is some other
    // function that merely happens to match the shape.
    const assignments = [...body.matchAll(ASSIGN)].filter((hit) => body.includes(`${param}.${hit[1]}`));
    if (assignments.length < 2) continue;
    const table = enums[name] ?? (enums[name] = {});
    for (const hit of assignments) {
      const value = hit[2] !== undefined ? hit[2] : Number(hit[3]);
      if (table[hit[1]] === undefined) table[hit[1]] = value;
    }
  }
}

const names = Object.keys(enums).sort();
const payload = { generatedFrom: files, enums };
fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 1)}\n`);
console.log(`build-names: ${names.length} enums from ${files} files -> ${path.relative(process.cwd(), OUT)}`);
for (const name of ['ItemName', 'FlyTargetName', 'SeaItemName', 'ResType', 'ResourceType']) {
  if (enums[name]) console.log(`  ${name}: ${Object.keys(enums[name]).length} entries, e.g. ${JSON.stringify(Object.entries(enums[name]).slice(0, 3))}`);
}
