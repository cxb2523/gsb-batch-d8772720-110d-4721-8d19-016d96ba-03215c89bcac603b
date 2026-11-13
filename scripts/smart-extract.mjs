#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const activeChildren = new Set();

function resolveSkillDir() {
  if (process.env.BROWSER_SEARCH_HOME) return process.env.BROWSER_SEARCH_HOME;
  const candidate = dirname(SCRIPT_DIR);
  try {
    const pkg = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf-8'));
    if (pkg.name === 'browser-search') return candidate;
  } catch {}
  return '/home/johell/.config/opencode/skills/browser-search';
}

const skillDir = resolveSkillDir();
const SKILL_DIR = join(skillDir, 'scripts');
// Gli override SMART_EXTRACT_*_BIN servono solo ai test con stub: in produzione restano i path reali.
const CAMOFOX = process.env.SMART_EXTRACT_CAMOFOX_BIN || join(SKILL_DIR, 'camofox', 'camofox.mjs');
const CLOAK = process.env.SMART_EXTRACT_CLOAK_BIN || join(SKILL_DIR, 'cloak', 'cloak-fetch.mjs');

const PKG = join(skillDir, 'package.json');
let VERSION = '0.1.0';
try {
  VERSION = JSON.parse(readFileSync(PKG, 'utf-8')).version || VERSION;
} catch {}

// Codici di motivo di fallimento macchina-leggibili (reasonCode), stabili nel tempo.
const REASON_CODES = {
  TOOL_UNAVAILABLE: 'tool-unavailable', // processo/browser non disponibile, modulo non installato, camofox_stuck
  TOOL_ERROR: 'tool-error',             // il tool è partito ma ha restituito un errore generico
  TOOL_TIMEOUT: 'tool-timeout',         // timeout/kill del processo o deadline interna
  HTTP_4XX: 'http-4xx',                 // navigazione con stato HTTP 4xx
  HTTP_5XX: 'http-5xx',                 // navigazione con stato HTTP 5xx
  ERROR_PAGE: 'error-page',             // contenuto riconosciuto come pagina di errore/blocked
  TOO_SHORT: 'too-short',               // contenuto sotto la soglia --min-chars
  EMPTY_RESULT: 'empty-result',         // risultato vuoto/null/{}
};

function help() {
  process.stderr.write(`smart-extract v${VERSION} — Estrazione dati con escalation automatica Camofox → CloakBrowser

USO:
  Mode normale (Camofox, con auto-escalation se tutti falliscono):
    smart-extract.mjs <url1> [url2 ...] [--expr "<expr>"] [options]

  Mode fallback (solo Cloak, per URL specifici già falliti su Camofox):
    smart-extract.mjs --fallback <url1> [url2 ...] [options]

OPZIONI:
  --expr "<expr>"       Espressione JS da valutare (solo Camofox). Se restituisce
                        un Element DOM, viene estratto il textContent. Se restituisce
                        un oggetto, viene auto-convertito in JSON. Se è una stringa
                        o un numero, viene passato com'è.
  --min-chars <n>       Soglia minima caratteri (default: 300).
  --wait <ms>           Attesa extra per rendering JS (default: 2000).
  --timeout <ms>        Timeout generale (default: 60000). Cloak riceve 2x.
  --verbose             Log diagnostici dettagliati su stderr.

COMPORTAMENTO (mode normale):
  - Esegue Camofox su TUTTI gli URL forniti (readability/snapshot o evaluate/tab)
  - Se TUTTI falliscono → scala automaticamente a Cloak senza chiedere
  - Se qualcuno riesce → output risultati, decidi tu se richiamare con --fallback
    per gli URL falliti (ogni risultato dichiara escalationEligible)
  - Con --expr, anche se tutto fallisce non si scala mai a Cloak (Cloak non valuta JS)
  - Risultati sospettosamente corti (es. {}, [], null) emettono un warning in steps[]
  - Output JSON con array "results", un elemento per URL

FORMATO RISULTATI:
  - Successo: { url, ok:true, content, chars, source, steps[], ... }
  - Fallimento: { url, ok:false, reason, reasonCode, failure:{
        stepIndex, step, tool, elapsedMs
      }, steps[], escalationEligible, escalationNote, ... }
      * reasonCode: uno tra ${Object.values(REASON_CODES).join(', ')}
      * failure.tool: nome del tool dello step che ha determinato il fallimento
      * failure.elapsedMs: durata di quello step (ms)
  - In mode full-auto ogni risultato conserva i steps Camofox seguiti da quelli Cloak;
    se Cloak riesce, source = "cloak".
  - Con SIGINT/SIGTERM viene emesso mode:"partial": results[] solo per URL completati
    (successi E fallimenti), pending[] per gli URL mai iniziati, inProgress[] per
    l'URL interrotto a metà. Nessun risultato viene inventato.

COMPORTAMENTO (mode fallback):
  - Salta Camofox, esegue solo Cloak sugli URL specificati
  - Cloak restituisce il contenuto raw (markdown), utile anche per URL API
  - Output stesso formato JSON
`);
  process.exit(2);
}

function log(msg) {
  process.stderr.write(`[smart-extract] ${msg}\n`);
}

// Classificazione miglior-sforzo del motivo di fallimento del processo tool,
// basata su ciò che il tool ha scritto (stderr/stdout) o sull'essere stato killato.
function classifyToolFailure(res) {
  const hay = [res.parseError, res.stderr, res.data?.error, res.motivo]
    .filter(Boolean).join(' ').toLowerCase();
  if (res.killed || /timeout|timed out|deadline|scaduto/.test(hay)) return REASON_CODES.TOOL_TIMEOUT;
  if (/cloakbrowser not installed|cannot find package|err_module_not_found|camofox_stuck|econnrefused|enoent|non operativo|non disponibile|browser non in esecuzione|connection refused|status 503|\b503\b/.test(hay)) {
    return REASON_CODES.TOOL_UNAVAILABLE;
  }
  return REASON_CODES.TOOL_ERROR;
}

function run(cmd, args, opts = {}) {
  const spawnCmd = cmd.endsWith('.mjs') ? process.execPath : cmd;
  const spawnArgs = cmd.endsWith('.mjs') ? [cmd, ...args] : args;
  const timeout = opts.timeout || 30000;
  // camofox.mjs si ferma da solo (chiudendo le sue tab) poco prima che il kill lo colpisca
  const env = cmd === CAMOFOX ? { ...process.env, CAMOFOX_DEADLINE_MS: String(Math.max(timeout - 3000, 2000)) } : process.env;
  return new Promise((resolve) => {
    const child = execFile(spawnCmd, spawnArgs, {
      maxBuffer: 10 * 1024 * 1024,
      ...opts,
      timeout,
      env,
    }, (err, stdout, stderr) => {
      activeChildren.delete(child);
      if (opts._url) state.spawned.delete(opts._url);
      const parsed = { cmd, args: args.slice(0, 3).concat(args.length > 3 ? ['...'] : []) };
      parsed.exitCode = err ? (err.code || err.status || 1) : 0;
      parsed.signal = err?.signal || null;
      if (err && err.killed) parsed.killed = true;

      let data = null;
      let parseError = null;
      if (stdout) {
        try {
          data = JSON.parse(stdout);
        } catch {
          parseError = stdout.trim().slice(0, 500);
        }
      }
      parsed.data = data;
      parsed.parseError = parseError;
      parsed.stderr = stderr.trim().slice(0, 1000) || null;
      parsed.elapsedMs = opts._start ? Date.now() - opts._start : -1;

      if (!data || data.error) {
        parsed.fallito = true;
        parsed.motivo = data?.error || parseError || `exit ${parsed.exitCode}`;
        parsed.reasonCode = classifyToolFailure(parsed);
      } else if (data.ok === false) {
        parsed.fallito = true;
        parsed.motivo = data.error || 'errore sconosciuto';
        parsed.reasonCode = classifyToolFailure(parsed);
      }

      resolve(parsed);
    });
    activeChildren.add(child);
    if (opts._url) state.spawned.add(opts._url);
    child.on('error', (e) => {
      activeChildren.delete(child);
      if (opts._url) state.spawned.delete(opts._url);
      resolve({
        cmd, args, exitCode: -1, killed: false, data: null, parseError: null,
        stderr: e.message, fallito: true, motivo: e.message,
        reasonCode: REASON_CODES.TOOL_UNAVAILABLE,
        elapsedMs: Date.now() - (opts._start || Date.now()),
      });
    });
  });
}

function isEmptyResult(v) {
  if (v == null) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return true;
  return false;
}

function smartStringify(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    if (v.nodeType === 1) {
      const text = v.textContent?.trim() || v.innerText?.trim() || '';
      return text;
    }
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function isSuspiciouslyShort(content) {
  if (!content) return true;
  const t = content.trim();
  if (t.length < 3) return true;
  if (t === '{}' || t === '[]' || t === 'null' || t === 'undefined') return true;
  return false;
}

const ERROR_PATTERNS = [
  'access denied', 'accesso negato', 'access dinied',
  '403 forbidden', '403 errore', 'forbidden',
  'you don\'t have permission', 'non hai i permessi',
  'reference #', 'errore 403', 'error 403',
  'too many requests', 'troppe richieste',
  'please enable javascript', 'attiva javascript',
  'sorry, you have been blocked', 'blocked',
];

function isErrorPage(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.trim().toLowerCase();
  for (const pattern of ERROR_PATTERNS) {
    if (lower.includes(pattern)) return true;
  }
  return false;
}

function isPoorContent(text, minChars) {
  if (isEmptyResult(text)) return { poor: true, motivo: 'risultato vuoto', code: REASON_CODES.EMPTY_RESULT };
  if (typeof text === 'string' && isErrorPage(text)) {
    const trimmed = text.trim().length;
    if (trimmed < 500) {
      return { poor: true, motivo: `pagina di errore rilevata (${trimmed} caratteri)`, code: REASON_CODES.ERROR_PAGE };
    }
  }
  if (typeof text === 'string' && text.trim().length < minChars) {
    return { poor: true, motivo: `contenuto troppo corto (${text.trim().length} < ${minChars} caratteri)`, code: REASON_CODES.TOO_SHORT };
  }
  return { poor: false };
}

function output(obj) {
  process.stdout.write(JSON.stringify({ version: VERSION, ...obj }) + '\n');
}

function parseIntArg(args, flag, def) {
  const i = args.indexOf(flag);
  if (i >= 0 && i + 1 < args.length) {
    const v = parseInt(args[i + 1], 10);
    return isNaN(v) ? def : v;
  }
  return def;
}

function parseArgs() {
  const all = process.argv.slice(2);
  if (all.includes('--help') || all.length === 0) help();

  const fallback = all.includes('--fallback');
  const exprIdx = all.indexOf('--expr');
  const expr = exprIdx >= 0 && exprIdx + 1 < all.length ? all[exprIdx + 1] : null;

  const nonFlagArgs = all.filter(a => (a.startsWith('http://') || a.startsWith('https://')) && !a.startsWith('--'));
  const urls = nonFlagArgs.length > 0 ? nonFlagArgs : null;

  if (!urls) { log('almeno un URL richiesto'); help(); }

  const opts = {
    urls,
    expr,
    fallback,
    minChars: parseIntArg(all, '--min-chars', 300),
    wait: parseIntArg(all, '--wait', 2000),
    timeout: parseIntArg(all, '--timeout', 60000),
    verbose: all.includes('--verbose'),
  };

  return opts;
}

async function tryCamofoxEvaluate(url, expr, opts) {
  const start = Date.now();
  log(`Camofox evaluate: ${url}`);
  const res = await run(CAMOFOX, ['evaluate', url, expr], { _url: url, _start: start, timeout: 15000 });
  if (!res.data || res.data.ok === false) {
    res.fallito = true;
    res.motivo = res.data?.error || 'nessun output JSON valido';
    res.reasonCode = res.reasonCode || REASON_CODES.TOOL_ERROR;
  }
  return res;
}

async function tryCamofoxReadability(url, opts) {
  const start = Date.now();
  log(`Camofox readability: ${url}`);
  const res = await run(CAMOFOX, ['readability', url, '--min-chars', String(opts.minChars)], { _url: url, _start: start, timeout: 45000 });
  return res;
}

async function tryCamofoxSnapshot(url, opts) {
  const start = Date.now();
  log(`Camofox snapshot: ${url}`);
  const res = await run(CAMOFOX, ['snapshot', url], { _url: url, _start: start, timeout: 30000 });
  return res;
}

async function tryCamofoxTabEvaluate(url, expr, opts) {
  const start = Date.now();
  log(`Camofox tab open --wait: ${url}`);
  const openRes = await run(CAMOFOX, ['tab', 'open', url, '--wait'], { _url: url, _start: start, timeout: 15000 });
  if (!openRes.data || !openRes.data.tabId) {
    openRes.fallito = true;
    openRes.motivo = openRes.data?.error || 'tab open fallito';
    openRes.reasonCode = openRes.reasonCode || REASON_CODES.TOOL_ERROR;
    // openData anche in caso di errore: può portare httpStatus di navigazione
    openRes.openData = openRes.data || null;
    openRes.tabOpenElapsed = openRes.elapsedMs;
    return openRes;
  }
  const tabId = openRes.data.tabId;

  const evalStart = Date.now();
  log(`Camofox tab evaluate: tabId=${tabId}`);
  const evalRes = await run(CAMOFOX, ['tab', 'evaluate', tabId, expr], { _url: url, _start: evalStart, timeout: 15000 });

  if (evalRes.data && evalRes.data.ok !== false) {
    const result = evalRes.data.result;
    if (isEmptyResult(result)) {
      evalRes.fallito = true;
      evalRes.motivo = 'risultato vuoto';
      evalRes.reasonCode = REASON_CODES.EMPTY_RESULT;
    }
  } else {
    evalRes.fallito = true;
    evalRes.motivo = evalRes.data?.error || 'tab evaluate fallito';
    evalRes.reasonCode = evalRes.reasonCode || REASON_CODES.TOOL_ERROR;
  }

  log(`Camofox tab close: ${tabId}`);
  await run(CAMOFOX, ['tab', 'close', tabId], { _url: url, timeout: 5000 }).catch(() => {});

  evalRes.tabOpenElapsed = openRes.elapsedMs;
  evalRes.openData = openRes.data;
  return evalRes;
}

async function tryCamofoxRenderedText(url, opts) {
  return tryCamofoxTabEvaluate(url, 'document.body.innerText', opts);
}

function isCloakNotInstalled(res) {
  const hay = [res.parseError || '', res.stderr || '', res.data?.error || '', res.motivo || ''].join(' ').toLowerCase();
  return hay.includes('cannot find package') && hay.includes('cloakbrowser') || hay.includes('err_module_not_found') && hay.includes('cloakbrowser');
}

async function tryCloak(url, opts) {
  const start = Date.now();
  log(`CloakBrowser fetch: ${url}`);

  const generalTimeout = opts.timeout || 60000;
  const cloArgs = [url, '--format', 'markdown', '--wait', String(Math.max(opts.wait || 2000, 1000)), '--timeout', String(Math.min(generalTimeout, 120000))];

  if (opts.verbose) cloArgs.push('--verbose');

  const res = await run(CLOAK, cloArgs, { _url: url, _start: start, timeout: generalTimeout * 2 });
  if (!res.data || res.data.error) {
    res.fallito = true;
    if (isCloakNotInstalled(res)) {
      res.motivo = `cloakbrowser not installed — run 'npm install' in skill dir (${skillDir}) then 'node -e "import(\\'cloakbrowser\\').then(c=>c.ensureBinary())"' and verify with 'bash scripts/check.sh'`;
      res.reasonCode = REASON_CODES.TOOL_UNAVAILABLE;
    } else {
      res.motivo = res.data?.error || res.parseError || res.stderr?.slice(0, 500) || 'nessun output JSON valido';
      res.reasonCode = res.reasonCode || classifyToolFailure(res);
    }
    return res;
  }
  if (res.data && res.data.content) {
    const poor = isPoorContent(res.data.content, opts.minChars);
    if (poor.poor) {
      res.fallito = true;
      res.motivo = poor.motivo;
      res.reasonCode = poor.code;
    }
  }
  return res;
}

function extractReadabilityContent(data) {
  if (!data || !data.results || !data.results[0]) return null;
  const r = data.results[0].readability;
  if (r && r.text) {
    return { content: r.text, chars: r.length || r.text.length, title: r.title || '' };
  }
  const s = data.results[0].snapshot;
  if (s) {
    const text = typeof s === 'string' ? s : (s.text || s.snapshot || JSON.stringify(s));
    return { content: text, chars: text.length };
  }
  return null;
}

function extractSnapshotContent(data) {
  if (!data || !data.snapshot) return null;
  const s = data.snapshot;
  const text = typeof s === 'string' ? s : (s.text || s.snapshot || JSON.stringify(s));
  return { content: text, chars: text.length };
}

function pickRicher(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (a.chars || 0) >= (b.chars || 0) ? a : b;
}

// Stato HTTP della navigazione (Camofox 1.15+): evaluate/snapshot lo hanno in data.httpStatus,
// readability in data.results[0].httpStatus, tab open in data.httpStatus.
function httpStatusOf(data) {
  const v = data?.httpStatus ?? data?.results?.[0]?.httpStatus;
  return typeof v === 'number' ? v : null;
}

function finalizeSteps(steps) {
  (steps || []).forEach((s, i) => { s.index = i; });
  return steps || [];
}

// L'ultimo step che ha avuto esito negativo oppure il cui contenuto è stato scartato
// (fallbackReason): è quello che determina il reason a livello di URL.
function lastFailedStep(steps) {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.ok === false || s.fallbackReason) return s;
  }
  return null;
}

// Aggiunge reasonCode e failure{stepIndex,step,tool,elapsedMs} a un risultato negativo.
// I campi esistenti (reason, steps, httpStatus, warning) restano invariati.
function normalizeResult(r, ctx = {}) {
  finalizeSteps(r.steps);
  if (r.ok) return r;
  const last = lastFailedStep(r.steps);
  r.reasonCode = r.reasonCode || last?.reasonCode || REASON_CODES.TOOL_ERROR;
  // Uno stato HTTP 4xx/5xx osservato sulla navigazione è la causa più precisa:
  // prevale anche su motivi "di contenuto" come too-short/error-page.
  if (ctx.httpStatus != null) {
    if (ctx.httpStatus >= 500) r.reasonCode = REASON_CODES.HTTP_5XX;
    else if (ctx.httpStatus >= 400) r.reasonCode = REASON_CODES.HTTP_4XX;
  }
  r.failure = {
    stepIndex: last ? last.index : -1,
    step: last ? last.index + 1 : 0,
    tool: last?.tool || null,
    elapsedMs: last ? (last.elapsedMs ?? 0) : null,
  };
  return r;
}

// Camofox bloccato e riavvio di camofox.mjs non riuscito (errore "camofox_stuck"): inutile
// insistere sugli URL successivi, si segnano falliti subito e l'escalation a Cloak fa il resto.
let camofoxStuck = false;

async function processUrlCamofox(url, opts) {
  if (camofoxStuck) {
    const steps = [{
      tool: 'camofox', ok: false, motivo: 'saltato: Camofox bloccato',
      reasonCode: REASON_CODES.TOOL_UNAVAILABLE, elapsedMs: 0,
    }];
    return normalizeResult({
      url, ok: false, content: null, chars: 0, title: null,
      reason: 'Camofox bloccato (riavvio non riuscito), URL saltato',
      reasonCode: REASON_CODES.TOOL_UNAVAILABLE,
      steps, elapsedMs: 0,
    });
  }
  const ctx = { httpStatus: null };
  const r = await processUrlCamofoxCore(url, opts, ctx);
  normalizeResult(r, ctx);
  if (!r.ok && /camofox_stuck/.test(JSON.stringify(r.steps || []))) {
    camofoxStuck = true;
    log('Camofox bloccato e riavvio non riuscito, salto Camofox per gli URL restanti');
  }
  if (ctx.httpStatus !== null) {
    r.httpStatus = ctx.httpStatus;
    if (ctx.httpStatus >= 400) {
      r.warning = `HTTP ${ctx.httpStatus}: il contenuto potrebbe essere una pagina di errore o una challenge`;
    }
  }
  return r;
}

async function processUrlCamofoxCore(url, opts, ctx) {
  const note = (d) => { const v = httpStatusOf(d); if (v !== null) ctx.httpStatus = v; };
  const urlStart = Date.now();
  const steps = [];

  if (opts.expr) {
    const s1 = await tryCamofoxEvaluate(url, opts.expr, opts);
    note(s1.data);
    const res1 = s1.data?.result;
    steps.push({ tool: 'camofox-evaluate', ok: !s1.fallito, motivo: s1.motivo || null, reasonCode: s1.reasonCode || null, elapsedMs: s1.elapsedMs });

    if (!s1.fallito && !isEmptyResult(res1)) {
      const resultStr = smartStringify(res1);
      if (!isErrorPage(resultStr)) {
        if (isSuspiciouslyShort(resultStr)) {
          steps[steps.length - 1].warning = `risultato sospettosamente corto ('${resultStr}') — possibile selettore JS errato o espressione che restituisce vuoto`;
        }
        return { url, ok: true, content: resultStr, chars: resultStr.length, source: 'camofox-evaluate', title: null, steps, elapsedMs: Date.now() - urlStart };
      }
      steps[steps.length - 1].fallbackReason = `pagina di errore rilevata via --expr`;
      steps[steps.length - 1].reasonCode = REASON_CODES.ERROR_PAGE;
      steps[steps.length - 1].ok = false;
    }

    const s2 = await tryCamofoxTabEvaluate(url, opts.expr, opts);
    note(s2.openData);
    const res2 = s2.data?.result;
    steps.push({ tool: 'camofox-tab', ok: !s2.fallito, motivo: s2.motivo || null, reasonCode: s2.reasonCode || null, elapsedMs: (s2.elapsedMs || 0) + (s2.tabOpenElapsed || 0) });

    if (!s2.fallito && !isEmptyResult(res2)) {
      const resultStr = smartStringify(res2);
      if (!isErrorPage(resultStr)) {
        if (isSuspiciouslyShort(resultStr)) {
          steps[steps.length - 1].warning = `risultato sospettosamente corto ('${resultStr}') — possibile selettore JS errato o espressione che restituisce vuoto`;
        }
        return { url, ok: true, content: resultStr, chars: resultStr.length, source: 'camofox-tab', title: null, steps, elapsedMs: Date.now() - urlStart };
      }
      steps[steps.length - 1].fallbackReason = `pagina di errore rilevata via --expr`;
      steps[steps.length - 1].reasonCode = REASON_CODES.ERROR_PAGE;
      steps[steps.length - 1].ok = false;
    }

    const lastResult = s2.data?.result ?? s1.data?.result;
    const lastResultStr = lastResult != null ? smartStringify(lastResult) : null;
    return { url, ok: false, content: lastResultStr, chars: lastResultStr?.length || 0, reason: 'Camofox fallito su entrambi i tentativi', source: steps[steps.length - 1]?.tool || 'camofox', steps, elapsedMs: Date.now() - urlStart };
  }

  // Un solo caricamento: camofox.mjs readability prende nella stessa tab Readability e, se e' troppo povera,
  // snapshot e testo renderizzato. Si ricarica la pagina solo se serve (vedi sotto).
  const s1 = await tryCamofoxReadability(url, opts);
  note(s1.data);
  const item0 = s1.data?.results?.[0] || null;
  const s1Failed = !item0 || !!item0.error;
  steps.push({ tool: 'camofox-readability', ok: !s1.fallito && !s1Failed, motivo: s1.motivo || item0?.error || null, reasonCode: s1.reasonCode || null, elapsedMs: s1.elapsedMs });

  let best = extractReadabilityContent(s1.data);
  if (item0?.readability?.text && !s1Failed) {
    const poor = isPoorContent(best.content, opts.minChars);
    if (!poor.poor) {
      return { url, ok: true, content: best.content, chars: best.chars, title: best.title || '', source: 'camofox-readability', steps, elapsedMs: Date.now() - urlStart };
    }
    steps[steps.length - 1].fallbackReason = poor.motivo;
    steps[steps.length - 1].reasonCode = poor.code;
  }

  if (item0?.snapshot) {
    const snap = extractSnapshotContent({ snapshot: item0.snapshot });
    steps.push({ tool: 'camofox-snapshot', ok: true, motivo: null, reasonCode: null, sameTab: true, elapsedMs: 0 });
    best = pickRicher(best, snap);
    if (best) {
      const poor = isPoorContent(best.content, opts.minChars);
      if (!poor.poor) {
        return { url, ok: true, content: best.content, chars: best.chars, title: best.title || '', source: 'camofox-snapshot', steps, elapsedMs: Date.now() - urlStart };
      }
      steps[steps.length - 1].fallbackReason = poor.motivo;
      steps[steps.length - 1].reasonCode = poor.code;
    }
  }

  if (item0?.renderedText) {
    const rendered = smartStringify(item0.renderedText);
    steps.push({ tool: 'camofox-render-text', ok: true, motivo: null, reasonCode: null, sameTab: true, elapsedMs: 0 });
    if (!isEmptyResult(rendered)) {
      const poor = isPoorContent(rendered, opts.minChars);
      if (!poor.poor) {
        return { url, ok: true, content: rendered, chars: rendered.length, title: best?.title || null, source: 'camofox-render-text', steps, elapsedMs: Date.now() - urlStart };
      }
      steps[steps.length - 1].fallbackReason = poor.motivo;
      steps[steps.length - 1].reasonCode = poor.code;
    }
  }

  // Ricarica solo se il primo tentativo e' fallito del tutto, oppure se i contenuti poveri sembrano una challenge/blocco
  // (HTTP >= 400 o pagina di errore): dopo la challenge un secondo caricamento puo' riuscire. Una pagina semplicemente
  // corta, senza segni di blocco, non viene ricaricata inutilmente.
  const blockHint = (ctx.httpStatus !== null && ctx.httpStatus >= 400) || isErrorPage(best?.content);
  if (!s1Failed && !blockHint) {
    const last = steps[steps.length - 1];
    return { url, ok: false, content: best?.content || null, chars: best?.chars || 0, title: best?.title || null, reason: last?.fallbackReason || last?.motivo || 'Camofox fallito', steps, elapsedMs: Date.now() - urlStart };
  }

  const s2 = await tryCamofoxSnapshot(url, opts);
  note(s2.data);
  steps.push({ tool: 'camofox-snapshot', ok: !s2.fallito, motivo: s2.motivo || null, reasonCode: s2.reasonCode || null, elapsedMs: s2.elapsedMs });

  const snap2 = extractSnapshotContent(s2.data);
  best = pickRicher(best, snap2);
  if (best) {
    const poor = isPoorContent(best.content, opts.minChars);
    if (!poor.poor) {
      return { url, ok: true, content: best.content, chars: best.chars, title: best.title || '', source: 'camofox-snapshot', steps, elapsedMs: Date.now() - urlStart };
    }
    steps[steps.length - 1].fallbackReason = poor.motivo;
    steps[steps.length - 1].reasonCode = poor.code;
  }

  const s3 = await tryCamofoxRenderedText(url, opts);
  note(s3.openData);
  steps.push({ tool: 'camofox-render-text', ok: !s3.fallito, motivo: s3.motivo || null, reasonCode: s3.reasonCode || null, elapsedMs: s3.elapsedMs });
  if (!s3.fallito && s3.data?.result != null) {
    const rendered = smartStringify(s3.data.result);
    if (!isEmptyResult(rendered)) {
      const poor = isPoorContent(rendered, opts.minChars);
      if (!poor.poor) {
        return { url, ok: true, content: rendered, chars: rendered.length, title: best?.title || null, source: 'camofox-render-text', steps, elapsedMs: Date.now() - urlStart };
      }
      steps[steps.length - 1].fallbackReason = poor.motivo;
      steps[steps.length - 1].reasonCode = poor.code;
    }
  }

  const last = steps[steps.length - 1];
  return { url, ok: false, content: best?.content || null, chars: best?.chars || 0, title: best?.title || null, reason: last?.fallbackReason || last?.motivo || 'Camofox fallito', steps, elapsedMs: Date.now() - urlStart };
}

async function processUrlCloak(url, opts) {
  const urlStart = Date.now();
  const steps = [];
  const s = await tryCloak(url, opts);
  steps.push({ tool: 'cloak', ok: !s.fallito, motivo: s.motivo || null, reasonCode: s.reasonCode || null, elapsedMs: s.elapsedMs });

  if (!s.fallito && s.data?.content) {
    return { url, ok: true, content: s.data.content, chars: s.data.content.length, title: s.data.title || '', source: 'cloak', steps, elapsedMs: Date.now() - urlStart };
  }

  const r = {
    url, ok: false, content: s.data?.content || null, chars: s.data?.content?.length || 0,
    title: s.data?.title || null, reason: s.motivo || 'Cloak fallito',
    reasonCode: s.reasonCode || REASON_CODES.TOOL_ERROR,
    steps, elapsedMs: Date.now() - urlStart,
  };
  return normalizeResult(r);
}

// Marca ogni risultato con le condizioni di escalation verso Cloak.
// Non cambia mai l'exito: aggiunge solo informazioni verificabili dal chiamante.
function applyEscalationInfo(r, { expr, cloakAttempted }) {
  if (r.ok) {
    r.escalationEligible = false;
    r.escalationNote = 'URL estratto con successo, nessuna escalation necessaria';
    return;
  }
  if (cloakAttempted) {
    r.escalationEligible = false;
    r.escalationNote = 'Cloak già tentato su questo URL: non restano strumenti di escalation automatica';
    return;
  }
  if (expr) {
    r.escalationEligible = false;
    r.escalationNote = 'Modalità --expr: Cloak non valuta espressioni JS, escalation non applicabile';
    return;
  }
  r.escalationEligible = true;
  r.escalationNote = `Rilanciare manualmente: node smart-extract.mjs --fallback "${r.url}"`;
}

// ---------------------------------------------------------------------------
// Stato batch: tiene traccia di cosa è completato, cosa è in corso e cosa non
// è ancora partito, così l'output partial non inventa risultati per gli URL
// mai iniziati.
// ---------------------------------------------------------------------------
const state = {
  opts: null,
  urls: [],
  phase: null,
  completed: new Map(), // url -> risultato finale della fase corrente
  queued: new Set(),    // url non ancora iniziati nella fase corrente
  inFlight: new Set(),  // url iniziati dal ciclo ma non completati
  spawned: new Set(),   // url con almeno un processo tool spawnato e non ancora terminato
  interrupted: false,
  interruptSignal: null,
  cloakDone: new Set(), // url per cui Cloak è stato effettivamente eseguito
};

// Hook di TEST: emissione deterministica di un segnale. Due varianti, entrambe inerti
// in produzione (variabili non impostate). Su Windows process.emit('SIGINT') triggera
// anche l'azione di default del segnale (terminazione con exit code 1), quindi i test
// emettono un evento dedicato ('smart-extract-test-signal') portando il nome del segnale:
// il percorso di cleanup è lo stesso dei segnali reali, solo innescato in modo portabile.
//   - AFTER_URLS: dopo N URL completati di una data fase (utile per colpire la fase Cloak
//     quando il primo URL è già completo);
//   - DELAY_MS: una sola volta, dopo X ms dall'avvio (utile per colpire un URL lento
//     a metà lavorazione, così finisce in inProgress e non in results).
function testSignalName() {
  return process.env.SMART_EXTRACT_TEST_SIGNAL || null;
}
function maybeEmitTestSignal(phase, doneCount) {
  const sig = testSignalName();
  if (!sig) return;
  // AFTER_URLS è attivo solo se NON è stato richiesto un trigger più preciso
  // (ready file o delay), altrimenti i due meccanismi sparerebbero insieme e il
  // segnale arriverebbe sempre al primo URL completato.
  if (process.env.SMART_EXTRACT_TEST_SIGNAL_READY_FILE ||
      parseInt(process.env.SMART_EXTRACT_TEST_SIGNAL_DELAY_MS || '', 10) > 0) {
    return;
  }
  const wantPhase = process.env.SMART_EXTRACT_TEST_SIGNAL_PHASE || 'camofox';
  const after = parseInt(process.env.SMART_EXTRACT_TEST_SIGNAL_AFTER_URLS || '1', 10);
  if (wantPhase === phase && doneCount === after) {
    process.emit('smart-extract-test-signal', sig);
  }
}

function scheduleDelayedTestSignal() {
  const sig = testSignalName();
  const delayMs = parseInt(process.env.SMART_EXTRACT_TEST_SIGNAL_DELAY_MS || '', 10);
  if (!sig || !(delayMs > 0)) return;
  setTimeout(() => process.emit('smart-extract-test-signal', sig), delayMs).unref?.();
}

// Variante ancora più deterministica: un file di "ready" viene creato dallo stub lento
// non appena viene spawnato. Appena compare, smart-extract emette il segnale: l'URL
// lento è quindi garantito in stato inFlight al momento dell'interruzione.
function watchReadyTestSignal() {
  const sig = testSignalName();
  const readyFile = process.env.SMART_EXTRACT_TEST_SIGNAL_READY_FILE;
  if (!sig || !readyFile) return;
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (existsSync(readyFile)) {
      clearInterval(timer);
      process.emit('smart-extract-test-signal', sig);
    } else if (tries > 500) { // ~25s di massimo: non bloccare per sempre
      clearInterval(timer);
    }
  }, 50);
  timer.unref?.();
}

async function processUrls(urls, processor, phase, opts, store) {
  state.phase = phase;
  // La fase parte da zero: i risultati della fase precedente restano nelle
  // variabili del chiamante (es. camofoxResults), non nello stato partial.
  state.queued.clear();
  state.inFlight.clear();
  state.spawned.clear();
  state.completed.clear();
  for (const url of urls) state.queued.add(url);
  const done = [];
  let count = 0;
  for (const url of urls) {
    // Tre stati mutuamente esclusivi per URL, aggiornati in modo sincrono prima di
    // ogni await: queued (mai iniziato) → inFlight (in lavorazione) → completed.
    state.queued.delete(url);
    state.inFlight.add(url);
    let r;
    try {
      r = await processor(url, opts);
    } catch (e) {
      // I processor non dovrebbero thrownare: se succede si registra comunque un
      // fallimento reale (mai un risultato inventato) instead of far crashare il batch.
      r = {
        url, ok: false, content: null, chars: 0, title: null,
        reason: e.message, reasonCode: REASON_CODES.TOOL_ERROR,
        failure: { stepIndex: -1, step: 0, tool: null, elapsedMs: null },
        steps: [], elapsedMs: 0,
      };
    }
    state.inFlight.delete(url);
    const stored = store ? store(url, r) : r;
    state.completed.set(url, stored);
    done.push(stored);
    count += 1;
    maybeEmitTestSignal(phase, count);
    // Interruzione cooperativa: dopo aver chiuso l'URL corrente non se ne inizia
    // nessun altro. I restanti restano in queued e finiscono in pending, non inventati.
    if (state.interrupted) break;
  }
  return done;
}

// Full-auto: ad ogni URL combina l'esito Camofox (già completato) con quello Cloak
// mantenendo i due segmenti di steps in ordine (prima Camofox, poi Cloak).
function mergeCamofoxAndCloak(camRes, cloakRes) {
  const camSteps = Array.isArray(camRes?.steps) ? camRes.steps : [];
  const steps = [...camSteps, ...cloakRes.steps];
  finalizeSteps(steps);
  const merged = {
    ...cloakRes,
    steps,
  };
  // Conserva informazioni Camofox che Cloak non possiede.
  if (camRes?.httpStatus != null && merged.httpStatus == null) merged.httpStatus = camRes.httpStatus;
  if (camRes?.warning && !merged.warning) merged.warning = camRes.warning;
  if (!merged.ok) {
    const last = lastFailedStep(steps);
    merged.reasonCode = merged.reasonCode || last?.reasonCode || REASON_CODES.TOOL_ERROR;
    merged.failure = {
      stepIndex: last ? last.index : -1,
      step: last ? last.index + 1 : 0,
      tool: last?.tool || null,
      elapsedMs: last ? (last.elapsedMs ?? 0) : null,
    };
  }
  return merged;
}

let _overallStart;

// Interruzione cooperativa: il segnale NON chiama process.exit subito (terminerebbe
// l'URL in corso lasciandone lo stato ambiguo). Marca l'interruzione e termina i
// processi tool: la await in corso si sblocca, l'URL corrente viene registrato come
// esito reale, poi il ciclo si ferma al confine e si emette il partial una sola volta.
function requestInterrupt(signal) {
  if (state.interrupted) return;
  state.interrupted = true;
  state.interruptSignal = signal;
  for (const child of activeChildren) {
    try { child.kill('SIGTERM'); } catch {}
  }
}

function emitPartial() {
  const signal = state.interruptSignal || 'SIGINT';
  const opts = state.opts || {};
  // Solo URL con un esito reale entrano in results: i pending non vengono falsificati.
  const ordered = state.urls.filter(u => state.completed.has(u)).map(u => state.completed.get(u));
  const inFallback = state.phase === 'fallback';
  for (const r of ordered) {
    const cloakAttempted = inFallback || state.cloakDone.has(r.url);
    applyEscalationInfo(r, { expr: !!opts.expr, cloakAttempted });
  }

  // Classificazione derivata dagli stati, senza inventare esiti:
  //   results    = completed (successi e fallimenti reali)
  //   inProgress = URL con lavoro in corso: nel ciclo (inFlight) O con un processo
  //                tool già spawnato ma non ancora chiuso (spawned), esclusi i completati
  //   pending    = tutto il resto: URL mai toccati
  const started = new Set([...state.inFlight, ...state.spawned]);
  const inProgress = state.urls
    .filter(u => started.has(u) && !state.completed.has(u))
    .map(url => ({
      url,
      phase: state.phase,
      note: `interrotto durante la fase ${state.phase}: nessun risultato finale per questo URL nella fase`,
    }));
  const inProgressUrls = new Set(inProgress.map(x => x.url));
  const pending = state.urls.filter(u =>
    !state.completed.has(u) && !inProgressUrls.has(u));

  output({
    ok: true,
    mode: 'partial',
    interrupted: true,
    signal,
    phase: state.phase,
    results: ordered,
    pending,
    inProgress,
    elapsedMs: _overallStart ? Date.now() - _overallStart : 0,
  });
  // 130 = 128+SIGINT(2), 143 = 128+SIGTERM(15): convenzione shell.
  process.exit(signal === 'SIGTERM' ? 143 : 130);
}

function setupSignalHandlers() {
  process.on('SIGINT', () => requestInterrupt('SIGINT'));
  process.on('SIGTERM', () => requestInterrupt('SIGTERM'));
  // Solo test: evento portabile che veicola il nome del segnale simulato.
  process.on('smart-extract-test-signal', (sig) => requestInterrupt(sig === 'SIGTERM' ? 'SIGTERM' : 'SIGINT'));
}

async function main() {
  setupSignalHandlers();
  scheduleDelayedTestSignal();
  watchReadyTestSignal();
  const opts = parseArgs();
  state.opts = opts;
  state.urls = opts.urls.slice();
  _overallStart = Date.now();

  if (opts.fallback) {
    const results = await processUrls(opts.urls, processUrlCloak, 'fallback', opts);
    if (state.interrupted) return emitPartial();
    for (const r of results) {
      applyEscalationInfo(r, { expr: false, cloakAttempted: true });
    }
    output({
      ok: true,
      mode: 'fallback',
      results,
      elapsedMs: Date.now() - _overallStart,
    });
    return;
  }

  const camofoxResults = await processUrls(opts.urls, processUrlCamofox, 'camofox', opts);
  if (state.interrupted) return emitPartial();
  const allFailed = camofoxResults.every(r => !r.ok);

  // Semantica --expr preservata: anche se tutto fallisce, Cloak non viene mai usato.
  if (allFailed && !opts.expr) {
    log('Tutti gli URL falliti su Camofox, escalation automatica a Cloak...');
    const camByUrl = new Map(camofoxResults.map(r => [r.url, r]));
    const merged = await processUrls(opts.urls, processUrlCloak, 'cloak', opts, (url, cloakRes) => {
      const m = mergeCamofoxAndCloak(camByUrl.get(url), cloakRes);
      state.cloakDone.add(url);
      return m;
    });
    if (state.interrupted) return emitPartial();
    for (const r of merged) {
      applyEscalationInfo(r, { expr: false, cloakAttempted: true });
    }
    output({
      ok: true,
      mode: 'full-auto',
      results: merged,
      elapsedMs: Date.now() - _overallStart,
    });
    return;
  }

  for (const r of camofoxResults) {
    applyEscalationInfo(r, { expr: !!opts.expr, cloakAttempted: false });
  }
  const extra = (allFailed && opts.expr)
    ? { note: "Tutti gli URL falliti in modalita' --expr: Cloak non supporta espressioni JS, nessuna escalation automatica" }
    : {};
  output({
    ok: true,
    mode: 'camofox',
    ...extra,
    results: camofoxResults,
    elapsedMs: Date.now() - _overallStart,
  });
}

main().catch((err) => {
  output({ ok: false, error: err.message, stack: err.stack });
  process.exit(1);
});
