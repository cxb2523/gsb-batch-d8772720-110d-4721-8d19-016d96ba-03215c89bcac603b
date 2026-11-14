// Print char-window context around occurrences of a needle in (possibly minified) JS.
// usage: node ctx.mjs <file> <needle> [before] [after] [maxHits]
import fs from 'node:fs';
const [file, needle, beforeS = '200', afterS = '400', maxS = '5'] = process.argv.slice(2);
const before = +beforeS, after = +afterS, maxHits = +maxS;
const txt = fs.readFileSync(file, 'utf8');
let i = -1, n = 0;
while ((i = txt.indexOf(needle, i + 1)) !== -1 && n < maxHits) {
  n++;
  const s = Math.max(0, i - before), e = Math.min(txt.length, i + needle.length + after);
  console.log(`\n===== hit ${n} @ ${i} =====`);
  console.log(txt.slice(s, e).replace(/\n/g, '\\n'));
}
if (n === 0) console.log('(no match)');
console.log(`\n[total shown: ${n}]`);
