import fs from 'node:fs';
import os from 'node:os';
import { isIP } from 'node:net';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_CA_DIR = path.join(PROJECT_ROOT, 'certificates');
export const CA_DIR = process.env.CW_CA_DIR ? path.resolve(process.env.CW_CA_DIR) : DEFAULT_CA_DIR;
export const CA_KEY = path.join(CA_DIR, 'ca.key');
export const CA_CRT = path.join(CA_DIR, 'ca.crt');
const LEAF_KEY = path.join(CA_DIR, 'leaf.key');
const SERIAL = path.join(CA_DIR, 'ca.srl');

export const CA_CN = 'CrazyWaterWorld Local Test CA';

let openssl = process.env.CW_OPENSSL || 'openssl';

function run(args) {
  const options = {
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  try {
    return execFileSync(openssl, args, options).toString();
  } catch (error) {
    if (error.code !== 'ENOENT' || process.env.CW_OPENSSL || process.platform !== 'win32') throw error;
    // Git for Windows often ships OpenSSL without adding usr/bin to PATH.
    let gitPaths = [];
    try { gitPaths = execFileSync('where.exe', ['git'], options).toString().trim().split(/\r?\n/); }
    catch { /* Report an actionable missing dependency below. */ }
    const bundled = gitPaths.map((file) => path.resolve(path.dirname(file), '../usr/bin/openssl.exe'))
      .find((file) => fs.existsSync(file));
    if (!bundled) throw new Error('找不到 OpenSSL。请安装 Git for Windows，或用 CW_OPENSSL 指定 openssl.exe 的完整路径。');
    openssl = bundled;
    return execFileSync(openssl, args, options).toString();
  }
}

export { run as runOpenSsl };

export function initCa({ force = false } = {}) {
  fs.mkdirSync(CA_DIR, { recursive: true });
  if (fs.existsSync(CA_CRT) && !force) return { created: false, path: CA_CRT };
  run(['genrsa', '-out', CA_KEY, '2048']);
  run([
    'req', '-x509', '-new', '-key', CA_KEY, '-sha256', '-days', '3650',
    '-out', CA_CRT,
    '-subj', `/CN=${CA_CN}/O=${CA_CN}/C=CN`,
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  run(['genrsa', '-out', LEAF_KEY, '2048']);
  return { created: true, path: CA_CRT };
}

export function leafFor(host) {
  const safe = host.replace(/[^a-zA-Z0-9.-]/g, '_');
  const key = path.join(CA_DIR, `leaf-${safe}.key`);
  const crt = path.join(CA_DIR, `leaf-${safe}.crt`);
  if (fs.existsSync(crt) && fs.existsSync(key)) {
    return { key, cert: fs.readFileSync(crt), keyPem: fs.readFileSync(key), cached: true };
  }
  const csr = path.join(CA_DIR, `leaf-${safe}.csr`);
  const ext = path.join(CA_DIR, `leaf-${safe}.ext`);
  fs.copyFileSync(LEAF_KEY, key);
  fs.writeFileSync(ext, [
    `subjectAltName=${isIP(host) ? 'IP' : 'DNS'}:${host}`,
    'basicConstraints=CA:FALSE',
    'keyUsage=digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    '',
  ].join('\n'));
  run(['req', '-new', '-key', key, '-out', csr, '-subj', `/CN=${host}`]);
  run([
    'x509', '-req', '-in', csr, '-CA', CA_CRT, '-CAkey', CA_KEY, '-CAcreateserial',
    '-out', crt, '-days', '3650', '-sha256', '-extfile', ext,
  ]);
  return { key, cert: fs.readFileSync(crt), keyPem: fs.readFileSync(key), cached: false };
}

export function prepareLeaf(host) {
  for (const file of [CA_CRT, CA_KEY, LEAF_KEY]) {
    if (!fs.existsSync(file)) {
      throw Object.assign(new Error(`本地证书材料缺失：${path.basename(file)}`), { code: 'CW_MISSING_CA_FILE' });
    }
  }
  const issuer = new X509Certificate(fs.readFileSync(CA_CRT));
  if (!issuer.checkPrivateKey(createPrivateKey(fs.readFileSync(CA_KEY)))) {
    throw new Error('ca.key 与 ca.crt 不匹配');
  }
  const { cert, keyPem } = leafFor(host);
  const leaf = new X509Certificate(cert);
  const now = Date.now();
  const validNow = (certificate) => Date.parse(certificate.validFrom) <= now && now <= Date.parse(certificate.validTo);
  if (!validNow(issuer) || !validNow(leaf) || !leaf.verify(issuer.publicKey)
    || !(isIP(host) ? leaf.checkIP(host) : leaf.checkHost(host)) || !leaf.checkPrivateKey(createPrivateKey(keyPem))) {
    throw new Error(`目标证书无法用于 ${host}，请检查本地 CA 和缓存的目标证书`);
  }
}

export function caFingerprint() {
  if (!fs.existsSync(CA_CRT)) return null;
  return run(['x509', '-in', CA_CRT, '-noout', '-fingerprint', '-sha256']).trim();
}

export function caThumbprint() {
  return new X509Certificate(fs.readFileSync(CA_CRT)).fingerprint.replace(/:/g, '');
}

function storeContains(store, thumbprint, currentUser) {
  try {
    execFileSync('certutil', [...(currentUser ? ['-user'] : []), '-store', store, thumbprint], { stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch (error) {
    const status = error.status >>> 0;
    if (status === 0x80090011 || status === 0x80092004) return false;
    throw new Error(`无法查询${currentUser ? '当前用户' : '本机'}证书库 ${store}（${error.code ?? '0x' + status.toString(16)}）`);
  }
}

export function isInstalled() {
  return fs.existsSync(CA_CRT) && storeContains('Root', caThumbprint(), true);
}

function trustError(message) {
  return Object.assign(new Error(message), { code: 'CW_CA_TRUST' });
}

// StdRegProv reads the user's physical Root via the WMI service. Its result
// diagnoses differing registry views; it must never count as TLS trust.
async function persistedUserRootContainsCert() {
  if (process.platform !== 'win32' || !fs.existsSync(CA_CRT)) return false;
  const cert = new X509Certificate(fs.readFileSync(CA_CRT));
  const script = `
    $ErrorActionPreference = 'Stop'
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $key = $sid + '\\Software\\Microsoft\\SystemCertificates\\Root\\Certificates\\' + $env:CW_CA_SHA1
    $r = Invoke-CimMethod -Namespace root/default -ClassName StdRegProv -MethodName GetBinaryValue -Arguments @{
      hDefKey = [uint32]2147483651; sSubKeyName = $key; sValueName = 'Blob'
    }
    if ($r.ReturnValue -eq 0) { [Convert]::ToBase64String($r.uValue) }`;
  try {
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 5000, env: { ...process.env, CW_CA_SHA1: cert.fingerprint.replace(/:/g, '') },
    });
    return Buffer.from(stdout.trim(), 'base64').includes(cert.raw);
  } catch {
    // WMI is an optional diagnostic; ordinary capture still uses the root store.
    return false;
  }
}

export async function verifyRootView(contains = persistedUserRootContainsCert) {
  if (process.platform === 'win32' && !isInstalled() && await contains()) {
    throw Object.assign(new Error(`Windows 的当前用户 Root 已保存本证书（${caThumbprint()}），但本进程看不到它。请从开始菜单打开普通 PowerShell，在项目目录运行 node src/app.mjs console，无需再次导入。若原控制台仍运行，请先设置 $env:CW_PORT='17323'。`), { code: 'CW_CA_VIEW' });
  }
}

async function addToUserRoot(signal) {
  // Surface the native store operation's HRESULT, including cancellation of
  // the Windows trust dialog. The path is data, never PowerShell source.
  const script = `
    $ErrorActionPreference = 'Stop'
    try {
      Add-Type -Path $env:CW_CAPTURE_WIZARD
      [CaptureCertificateWizard]::Import($env:CW_CAPTURE_CA_FILE)
    } catch {
      $cause = $_.Exception.GetBaseException()
      $code = $cause.HResult
      if ($cause -is [ComponentModel.Win32Exception]) {
        $code = $cause.NativeErrorCode
        if ($code -gt 0 -and $code -le 65535) { $code = $code -bor 0x80070000 }
      }
      [Console]::Error.WriteLine(('CW_CA_HRESULT=0x{0:X8}' -f $code))
      exit 1
    }`;
  try {
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
      // SW_HIDE also hides the wizard's first window, leaving the capture waiting for invisible input.
      signal, windowsHide: false, env: { ...process.env, CW_CAPTURE_CA_FILE: CA_CRT,
        CW_CAPTURE_WIZARD: path.join(import.meta.dirname, 'import-user-root.cs') },
    });
  } catch (error) {
    signal?.throwIfAborted();
    const code = /CW_CA_HRESULT=(0x[0-9A-F]+)/i.exec(error.stderr)?.[1] ?? error.code;
    if (code === '0x800704C7' || code === '0x80090036') throw trustError('Windows 证书信任确认已取消，请重试并在系统安全警告中选择“是”');
    if (code === '0x80070005') throw trustError('Windows 拒绝写入当前用户根证书库（0x80070005），请检查此设备的证书策略');
    throw trustError(`Windows 未能添加当前用户测试 CA（${code}）`);
  }
}

export async function installCa({ add = addToUserRoot, check = isInstalled, wait = sleep, signal } = {}) {
  signal?.throwIfAborted();
  await add(signal);
  for (let attempt = 0; attempt <= 15; attempt++) {
    if (check()) return true;
    if (attempt < 15) await wait(200, undefined, { signal });
  }
  await verifyRootView();
  const thumbprint = caThumbprint();
  const intermediate = process.platform === 'win32'
    && (storeContains('CA', thumbprint, true) || storeContains('CA', thumbprint, false));
  const detail = intermediate ? '在「中间证书颁发机构」找到了同一证书。' : '';
  throw trustError(`向导已结束，当前用户的「受信任的根证书颁发机构」仍没有指纹 ${thumbprint}。${detail}采集未启动。请记录向导最后一页的结果以排查 Windows 证书存储。`);
}

export function uninstallCa() {
  // Remove only this exact certificate; retain other certificates with the same CN.
  execFileSync('certutil', ['-user', '-delstore', 'Root', caThumbprint()], { stdio: 'inherit' });
  return isInstalled();
}

export function removeCaFiles() {
  if (path.basename(CA_DIR) !== 'certificates' || (CA_DIR !== DEFAULT_CA_DIR && !process.env.CW_CA_DIR)) {
    throw new Error('拒绝清理项目目录之外的证书文件');
  }
  fs.rmSync(CA_DIR, { recursive: true, force: true });
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'init') {
    console.log(initCa({ force: arg === '--force' }));
  } else if (cmd === 'leaf') {
    const result = leafFor(arg);
    console.log(`leaf for ${arg}: cached=${result.cached} ${result.key}`);
  } else if (cmd === 'install') {
    await verifyRootView();
    await installCa();
    console.log(`installed=${isInstalled()}\n${caFingerprint()}`);
  } else if (cmd === 'uninstall') {
    uninstallCa();
    removeCaFiles();
    console.log(`installed=${isInstalled()}`);
  } else if (cmd === 'clean') {
    removeCaFiles();
    console.log(`ca files removed: ${CA_DIR}`);
  } else if (cmd === 'status') {
    const shown = path.relative(process.cwd(), CA_CRT) || CA_CRT;
    console.log(`ca: ${shown} exists=${fs.existsSync(CA_CRT)}`);
    console.log(`trusted(current user): ${isInstalled()}`);
    await verifyRootView();
  } else {
    console.log('usage: mitm-ca.mjs init [--force] | leaf <host> | install | uninstall | clean | status');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
