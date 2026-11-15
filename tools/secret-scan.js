/**
 * tools/_scan-secrets.js —— 只读：扫出被 git 跟踪的文件里【像密钥】的行，并判断是真值还是占位符
 *
 * 为什么要单独写：往 GitHub 镜像之前必须确认仓库里没有活密钥 —— 漏一个就是永久泄露。
 *   ⚠️ 本脚本【绝不打印密钥值】，只打印 文件:行号 + 判断结果 + 长度。
 *   （打印了就等于把密钥又写进会话记录和终端历史一次。）
 *
 * 用法: node tools/_scan-secrets.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// 【2026-10-10 修·关键】必须加 core.quotepath=false。
//   默认 core.quotepath=true 时 git 会把中文文件名输出成 "\344\270\255..." 的转义形式，
//   于是 fs.readFileSync(转义名) 全部失败 → 被 catch 吞掉 → **中文名文件被静默跳过**。
//   实测后果：这个扫描器把「中台账号与Key-对照.md」等 10 个最该扫的文件全漏了，
//   还报出一句"共 25 处、0 处真值"，看着很干净 —— 是假阴性，不是真干净。
const files = execSync('git -c safe.directory=* -c core.quotepath=false ls-files', { cwd: ROOT, encoding: 'utf8' })
  .split(/\r?\n/).filter(Boolean);

// 只扫文本类文件。
// 【2026-10-10 修·降噪】全类型扫出 446 处，绝大多数是噪音：
//   · 代码里的 `const KEY = SVC.apiKey` 是【从 config.local.json 读】，不是硬编码；
//   · 设计系统里的 `token`（bloomTokens / design token）和凭据毫无关系。
//   真正的泄露面是【人手把密钥粘进文档】，所以默认只扫 .md，代码靠 .gitignore + 引用式读取保证。
const TEXT = /\.(md)$/i;
// 典型密钥形状
const PATTERNS = [
  ['ghp(GitHub PAT)', /ghp_[A-Za-z0-9]{20,}/g],
  ['github_pat', /github_pat_[A-Za-z0-9_]{20,}/g],
  ['glpat(GitLab)', /glpat-[A-Za-z0-9_\-]{16,}/g],
  ['sk-(OpenAI)', /sk-[A-Za-z0-9]{20,}/g],
  ['AKIA(AWS)', /AKIA[0-9A-Z]{16}/g],
  ['私钥块', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
];
// 「key: value」形态
const KV = /(?:apiKey|api_key|x-api-key|secret|password|passwd|token|access_key|appsecret)\s*[:=]\s*["'`]?([A-Za-z0-9_\-+/=]{12,})/gi;

function verdict(v) {
  const s = String(v);
  if (/\$\{|<[^>]+>|xxxx|XXXX|示例|占位|你的|自行|TODO|请填|REPLACE/i.test(s)) return '占位符';
  const uniq = new Set(s).size;
  if (s.length < 16) return '偏短，可能不是密钥(len=' + s.length + ')';
  if (uniq < 8) return '低熵，不像密钥(len=' + s.length + ')';
  return '★可能真值 len=' + s.length + ' 熵(不同字符)=' + uniq;
}

const hits = [];
// 【2026-10-10 修】原来只认「同一行 key:value」，漏掉了关键词与值分行/在表格里的情况
//   （git grep 命中了 40 行，这里只报出 3 行）。现在按【关键词行】扫，并把长串打码后打印整行，
//   这样能判断它到底是真密钥还是示例，又不会把值写进会话记录。
// 【2026-10-10 补】原来漏了纯 `Key` —— 第一次 git grep 点名的「中台账号与Key-对照.md」等
//   文件没进结果就是这个原因。加上 \bkey\b（后接分隔符+长值才算，避免命的 key 之类噪音）。
const KEYWORD = /(apiKey|api_key|x-api-key|secret|appsecret|password|passwd|token|access_key|授权|密钥|账号与\s*Key|\bKey\b\s*[:：=]\s*\S{12,}|\bkey\b\s*[:：=]\s*\S{12,})/i;
const redact = (s) => String(s).replace(/[A-Za-z0-9_\-+\/=]{16,}/g,
  (m) => '<' + m.slice(0, 3) + '… len=' + m.length + '>');

for (const rel of files) {
  if (!TEXT.test(rel)) continue;
  const abs = path.join(ROOT, rel);
  let src; try { src = fs.readFileSync(abs, 'utf8'); } catch (e) { continue; }
  const lines = src.split(/\r?\n/);
  lines.forEach((ln, i) => {
    for (const [name, re] of PATTERNS) {
      re.lastIndex = 0;
      if (re.test(ln)) hits.push({ rel, line: i + 1, kind: name, verdict: '★命中共识格式', text: redact(ln) });
    }
    KV.lastIndex = 0;
    let m;
    while ((m = KV.exec(ln))) hits.push({ rel, line: i + 1, kind: 'key:value 形态', verdict: verdict(m[1]), text: redact(ln) });
    if (KEYWORD.test(ln)) hits.push({ rel, line: i + 1, kind: '含凭据关键词', verdict: '需人工看', text: redact(ln) });
  });
}

if (!hits.length) { console.log('✅ 没扫到可疑凭据'); process.exit(0); }
const byFile = {};
hits.forEach((h) => { (byFile[h.rel] = byFile[h.rel] || []).push(h); });
console.log('共 ' + hits.length + ' 处命中，分布在 ' + Object.keys(byFile).length + ' 个文件（长串已打码，只留前 3 字符）:\n');
Object.keys(byFile).sort().forEach((f) => {
  console.log('  ' + f);
  byFile[f].forEach((h) => console.log('      :' + h.line + '  [' + h.kind + ' ' + h.verdict + ']\n          '
    + h.text.trim().slice(0, 180)));
});
const real = hits.filter((h) => /★/.test(h.verdict));
console.log('\n★ 里可能含真值的 ' + real.length + ' 处');

