import {
  existsSync,
  mkdirSync,
  chmodSync,
  copyFileSync,
  unlinkSync,
  statfsSync,
  statSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  createReadStream,
  createWriteStream,
} from 'node:fs';
import { tmpdir, totalmem, freemem } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { spawn, execSync, execFileSync } from 'node:child_process';
import { brotliDecompressSync, createBrotliDecompress, createUnzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { extract } from 'tar-fs';
import CDP from 'chrome-remote-interface';
import { CDP_HOST, CDP_PORT, disconnect } from './connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHART_URL = process.env.TV_CHART_URL || 'https://www.tradingview.com/chart/';

let browserProcess = null;
let browserState = {
  status: 'idle',
  pid: null,
  binary: null,
  mode: null,
  cdpPort: CDP_PORT,
  lastError: null,
  startedAt: null,
  loggedInCookieInjected: false,
};
let launchPromise = null;

export function getBrowserState() {
  return { ...browserState };
}

async function probeCdpVersion(port = CDP_PORT) {
  try {
    const res = await fetch(`http://${CDP_HOST}:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function listCdpTargets(port = CDP_PORT) {
  try {
    const res = await fetch(`http://${CDP_HOST}:${port}/json/list`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

function canExecuteInDir(dir) {
  if (process.platform === 'win32') return true;
  try {
    mkdirSync(dir, { recursive: true });
    const src = existsSync('/bin/true') ? '/bin/true' : (existsSync('/usr/bin/true') ? '/usr/bin/true' : null);
    if (!src) return true;
    const testBin = join(dir, `.exec-test-${process.pid}`);
    copyFileSync(src, testBin);
    chmodSync(testBin, 0o755);
    execSync(testBin, { stdio: 'ignore', timeout: 2000 });
    unlinkSync(testBin);
    return true;
  } catch {
    try { unlinkSync(join(dir, `.exec-test-${process.pid}`)); } catch {}
    return false;
  }
}

function getFreeMb(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    if (typeof statfsSync === 'function') {
      const s = statfsSync(dir);
      return Math.floor((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
    }
  } catch {}
  return 1024;
}

function pickRuntimeDir() {
  // Clean up old .tv-chromium directory that cached broken 153.0.0 binaries (318KB libGLESv2.so stub)
  for (const staleDir of ['/tmp/tv-chromium', join(process.cwd(), '.tv-chromium')]) {
    try {
      if (existsSync(staleDir)) {
        rmSync(staleDir, { recursive: true, force: true });
      }
    } catch {}
  }

  const candidates = [
    process.env.TV_RUNTIME_DIR,
    '/tmp/tv-chromium-131',
    join(process.cwd(), '.tv-chromium-131'),
    process.env.HOME ? join(process.env.HOME, '.cache', 'tv-chromium-131') : null,
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      const freeMb = getFreeMb(dir);
      if (freeMb >= 250 && canExecuteInDir(dir)) {
        return dir;
      }
    } catch {}
  }
  const fallback = join(tmpdir(), 'tv-chromium-131');
  mkdirSync(fallback, { recursive: true });
  return fallback;
}

function inflateArchive(filePath, baseDir) {
  const isSwiftshader = filePath.includes('swiftshader');
  const outName = basename(filePath).replace(/\.(?:t(?:ar(?:\.(?:br|gz))?|br|gz)|br|gz)$/i, '');
  const output = isSwiftshader ? baseDir : join(baseDir, outName);

  return new Promise((resolve, reject) => {
    if (isSwiftshader) {
      const glesPath = join(output, 'libGLESv2.so');
      // Only reuse cached swiftshader if libGLESv2.so is the real ~8MB ANGLE library (not 153.0.0's 318KB stub)
      if (existsSync(glesPath) && statSync(glesPath).size > 4000000) {
        return resolve(output);
      }
    } else if (existsSync(output)) {
      return resolve(output);
    }

    const isTar = /\.t(?:ar(?:\.(?:br|gz))?|br|gz)$/i.test(filePath);
    const isBrotli = /br$/i.test(filePath);
    const isGzip = /gz$/i.test(filePath);

    const source = createReadStream(filePath, { highWaterMark: 2 ** 22 });
    const target = isTar ? extract(output) : createWriteStream(output, { mode: 0o755 });

    source.once('error', reject);
    target.once('error', reject);
    if (isTar) {
      target.once('finish', () => resolve(output));
    } else {
      target.once('close', () => resolve(output));
    }

    if (isBrotli || isGzip) {
      const decompressor = isBrotli
        ? createBrotliDecompress({ chunkSize: 2 ** 21 })
        : createUnzip({ chunkSize: 2 ** 21 });
      decompressor.once('error', reject);
      source.pipe(decompressor).pipe(target);
    } else {
      source.pipe(target);
    }
  });
}

function ensureSparticuz131Installed() {
  const repoRoot = join(__dirname, '..');
  const pkgPath = join(repoRoot, 'node_modules', '@sparticuz', 'chromium', 'package.json');
  let ver = 'none';
  try {
    if (existsSync(pkgPath)) {
      ver = JSON.parse(readFileSync(pkgPath, 'utf8')).version || 'unknown';
    }
  } catch {}

  if (ver !== '131.0.1') {
    console.log(`[tv-browser] Replacing @sparticuz/chromium@${ver} with stable 131.0.1 (fixes broken 318KB libGLESv2.so in 153.0.0)...`);
    try {
      execSync('npm install @sparticuz/chromium@131.0.1 --no-save --no-audit --no-fund', {
        cwd: repoRoot,
        stdio: 'inherit',
        timeout: 180000,
      });
      ver = '131.0.1';
    } catch (e) {
      console.warn('[tv-browser] npm install @sparticuz/chromium@131.0.1 warning:', e.message);
    }
  }
  return ver;
}

async function resolveSparticuzChromium() {
  const sparticuzVer = ensureSparticuz131Installed();
  const runtimeDir = pickRuntimeDir();
  process.env.TMPDIR = runtimeDir;
  process.env.TMP = runtimeDir;
  process.env.TEMP = runtimeDir;
  process.env.HOME = runtimeDir;
  process.env.XDG_CACHE_HOME = join(runtimeDir, 'cache');
  process.env.XDG_CONFIG_HOME = join(runtimeDir, 'config');
  process.env.NSS_SDB_USE_CACHE = 'yes';
  mkdirSync(process.env.XDG_CACHE_HOME, { recursive: true });
  mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
  mkdirSync(join(runtimeDir, '.pki', 'nssdb'), { recursive: true });

  const binDir = join(__dirname, '..', 'node_modules', '@sparticuz', 'chromium', 'bin');

  console.log(`[tv-browser] Extracting headless Chromium (@sparticuz/chromium@${sparticuzVer}) into ${runtimeDir} ...`);
  const [chromiumPath, fontsOutPath, , al2023Path] = await Promise.all([
    inflateArchive(join(binDir, 'chromium.br'), runtimeDir),
    inflateArchive(join(binDir, 'fonts.tar.br'), runtimeDir),
    inflateArchive(join(binDir, 'swiftshader.tar.br'), runtimeDir),
    inflateArchive(join(binDir, 'al2023.tar.br'), runtimeDir),
  ]);

  chmodSync(chromiumPath, 0o755);
  const al2023Lib = join(al2023Path, 'lib');
  mkdirSync(al2023Lib, { recursive: true });

  // 1. Extract bundled libsqlite3.so.0 into al2023/lib so libsoftokn3.so (NSS HTTPS/TLS) never fails dlopen on Debian Slim containers
  const bundledSqliteBr = join(__dirname, '..', 'vendor', 'libsqlite3.so.0.br');
  const targetSqliteSo = join(al2023Lib, 'libsqlite3.so.0');
  if (existsSync(bundledSqliteBr) && !existsSync(targetSqliteSo)) {
    try {
      const rawSqlite = brotliDecompressSync(readFileSync(bundledSqliteBr));
      writeFileSync(targetSqliteSo, rawSqlite, { mode: 0o755 });
    } catch (e) {
      console.warn('[tv-browser] Failed extracting vendor/libsqlite3.so.0.br:', e.message);
    }
  }

  // 2. Fix fonts.conf! @sparticuz/chromium hardcodes /tmp/fonts inside fonts.conf.
  const fontsDir = fontsOutPath || join(runtimeDir, 'fonts');
  const fontsCacheDir = join(runtimeDir, 'fonts-cache');
  mkdirSync(fontsCacheDir, { recursive: true });
  try {
    if (!existsSync('/tmp/fonts')) {
      symlinkSync(fontsDir, '/tmp/fonts');
    }
    mkdirSync('/tmp/fonts-cache', { recursive: true });
  } catch {}

  const fontsConfPath = join(fontsDir, 'fonts.conf');
  const fontsSubDir = join(fontsDir, 'fonts');
  const openSansDir = join(fontsSubDir, 'Open_Sans');
  const fixedFontsConf = `<?xml version="1.0" ?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontsDir}</dir>
  <dir>${fontsSubDir}</dir>
  <dir>${openSansDir}</dir>
  <dir>/tmp/fonts</dir>
  <dir>/usr/share/fonts</dir>
  <dir>/usr/local/share/fonts</dir>
  <cachedir>${fontsCacheDir}</cachedir>
  <config></config>
</fontconfig>
`;
  try {
    writeFileSync(fontsConfPath, fixedFontsConf, 'utf8');
  } catch (e) {
    console.warn('[tv-browser] Could not rewrite fonts.conf:', e.message);
  }
  process.env.FONTCONFIG_PATH = fontsDir;
  process.env.FONTCONFIG_FILE = fontsConfPath;

  // 3. Fix vk_swiftshader_icd.json to point to absolute path of libvk_swiftshader.so
  const icdPath = join(runtimeDir, 'vk_swiftshader_icd.json');
  const vkLibPath = join(runtimeDir, 'libvk_swiftshader.so');
  try {
    writeFileSync(
      icdPath,
      JSON.stringify({
        file_format_version: '1.0.0',
        ICD: { library_path: vkLibPath, api_version: '1.0.5' },
      })
    );
    process.env.VK_ICD_FILENAMES = icdPath;
    process.env.VK_DRIVER_FILES = icdPath;
  } catch {}

  const ldParts = [
    runtimeDir,
    al2023Lib,
    '/usr/lib/x86_64-linux-gnu',
    '/lib/x86_64-linux-gnu',
    '/usr/lib64',
    '/lib64',
    ...(process.env.LD_LIBRARY_PATH ? process.env.LD_LIBRARY_PATH.split(':') : []),
  ].filter(Boolean);
  process.env.LD_LIBRARY_PATH = [...new Set(ldParts)].join(':');

  // 4. Quick container diagnostics
  try {
    const glesSizeKb = existsSync(join(runtimeDir, 'libGLESv2.so'))
      ? Math.round(statSync(join(runtimeDir, 'libGLESv2.so')).size / 1024)
      : 0;
    console.log(
      `[tv-browser] Diagnostics: sparticuz=${sparticuzVer}, libGLESv2=${glesSizeKb}KB, sqlite3=${existsSync(targetSqliteSo)}, RAM=${Math.round(freemem() / 1048576)}MB`
    );
  } catch {}

  return { binary: chromiumPath, runtimeDir, isSparticuz: true };
}

async function findBrowserBinary() {
  const envBin = process.env.TV_BROWSER_PATH || process.env.CHROME_PATH;
  if (envBin && existsSync(envBin)) {
    return { binary: envBin, runtimeDir: pickRuntimeDir(), isSparticuz: false };
  }

  if (process.platform === 'win32') {
    const winCandidates = [
      `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ];
    for (const p of winCandidates) {
      if (p && existsSync(p)) return { binary: p, runtimeDir: pickRuntimeDir(), isSparticuz: false };
    }
  } else if (process.platform === 'darwin') {
    const macCandidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/TradingView.app/Contents/MacOS/TradingView',
    ];
    for (const p of macCandidates) {
      if (existsSync(p)) return { binary: p, runtimeDir: pickRuntimeDir(), isSparticuz: false };
    }
  } else {
    const linuxCandidates = [
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/snap/tradingview/current/tradingview',
      '/opt/TradingView/tradingview',
    ];
    for (const p of linuxCandidates) {
      if (existsSync(p)) return { binary: p, runtimeDir: pickRuntimeDir(), isSparticuz: false };
    }
    return await resolveSparticuzChromium();
  }

  throw new Error('No Chromium/Chrome binary found.');
}

function getLaunchProfiles({ profileDir, cdpPort, isSparticuz }) {
  // Exact @sparticuz/chromium@131.0.1 tested flags (SwiftShader ANGLE must be enabled; see Sparticuz/chromium#247)
  const baseCommon = [
    isSparticuz ? '--headless=shell' : '--headless=new',
    '--allow-pre-commit-input',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-client-side-phishing-detection',
    '--disable-component-extensions-with-background-pages',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-hang-monitor',
    '--disable-ipc-flooding-protection',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-renderer-backgrounding',
    '--disable-sync',
    '--enable-automation',
    '--enable-blink-features=IdleDetection',
    '--export-tagged-pdf',
    '--force-color-profile=srgb',
    '--metrics-recording-only',
    '--no-first-run',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-domain-reliability',
    '--disable-print-preview',
    '--disable-speech-api',
    '--disk-cache-size=33554432',
    '--mute-audio',
    '--no-default-browser-check',
    '--no-pings',
    '--font-render-hinting=none',
    '--hide-scrollbars',
    '--ignore-gpu-blocklist',
    '--in-process-gpu',
    '--window-size=1920,1080',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--allow-running-insecure-content',
    '--disable-setuid-sandbox',
    '--disable-site-isolation-trials',
    '--disable-web-security',
    '--no-sandbox',
    '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    `--remote-debugging-port=${cdpPort}`,
    '--remote-debugging-address=127.0.0.1',
  ];

  const stdDisable = [
    'Translate',
    'BackForwardCache',
    'AcceptCHFrame',
    'MediaRouter',
    'OptimizationHints',
    'AudioServiceOutOfProcess',
    'IsolateOrigins',
    'site-per-process',
  ];

  return [
    {
      name: 'sparticuz-131-official',
      args: [
        ...baseCommon,
        '--single-process',
        '--no-zygote',
        `--disable-features=${stdDisable.join(',')}`,
        '--enable-features=NetworkServiceInProcess2,SharedArrayBuffer',
        `--user-data-dir=${join(profileDir, 'p1')}`,
        'about:blank',
      ],
    },
    {
      name: 'sparticuz-131-nowasmtrap',
      args: [
        ...baseCommon,
        '--single-process',
        '--no-zygote',
        `--disable-features=${[...stdDisable, 'WebAssemblyTrapHandler', 'WebAssemblyTiering', 'WebAssemblyLazyCompilation'].join(',')}`,
        '--enable-features=NetworkServiceInProcess2',
        `--user-data-dir=${join(profileDir, 'p2')}`,
        'about:blank',
      ],
    },
    {
      name: 'sparticuz-131-multiprocess',
      args: [
        ...baseCommon,
        `--disable-features=${[...stdDisable, 'WebAssemblyTrapHandler'].join(',')}`,
        '--enable-features=NetworkServiceInProcess2',
        `--user-data-dir=${join(profileDir, 'p3')}`,
        'about:blank',
      ],
    },
  ];
}

export async function injectTradingViewCookies({ sessionid, sessionid_sign, port = CDP_PORT } = {}) {
  const sid = sessionid || process.env.TV_SESSIONID;
  const sig = sessionid_sign || process.env.TV_SESSIONID_SIGN;
  if (!sid) return { injected: false, reason: 'no_sessionid_provided' };

  const targets = await listCdpTargets(port);
  const chartTarget = targets.find((t) => t.type === 'page' && /tradingview/i.test(t.url)) || targets.find((t) => t.type === 'page');
  if (!chartTarget) return { injected: false, reason: 'no_page_target' };

  const c = await CDP({ host: CDP_HOST, port, target: chartTarget.id });
  try {
    await c.Network.enable();
    await c.Network.setCookie({
      name: 'sessionid',
      value: sid,
      domain: '.tradingview.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    });
    if (sig) {
      await c.Network.setCookie({
        name: 'sessionid_sign',
        value: sig,
        domain: '.tradingview.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      });
    }
    await c.Page.enable();
    await c.Page.navigate({ url: CHART_URL });
    browserState.loggedInCookieInjected = true;
    return { injected: true };
  } finally {
    try { await c.close(); } catch {}
  }
}

async function tryLaunchProfile({ binary, profile, cdpPort }) {
  console.log(`[tv-browser] Trying profile "${profile.name}"...`);
  const child = spawn(binary, profile.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  let stderrTail = '';
  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString();
    stderrTail = (stderrTail + text).slice(-1500);
  });

  let exitInfo = null;
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
  });
  child.on('error', (err) => {
    exitInfo = { error: err.message };
  });

  // 1. Wait up to 12s for CDP port to listen on about:blank
  let version = null;
  const cdpDeadline = Date.now() + 12000;
  while (Date.now() < cdpDeadline) {
    if (exitInfo) {
      return {
        ok: false,
        error: `Exited before CDP ready (${JSON.stringify(exitInfo)}): ${stderrTail.trim().slice(-400)}`,
      };
    }
    version = await probeCdpVersion(cdpPort);
    if (version) break;
    await new Promise((r) => setTimeout(r, 350));
  }

  if (!version) {
    try { child.kill('SIGKILL'); } catch {}
    return { ok: false, error: `CDP timeout (${stderrTail.trim().slice(-400)})` };
  }

  // 2. Staged probe & navigation with live telemetry
  let stage = '0:cdp-connected';
  let lastReq = 'none';
  let lastTargetEvt = 'none';
  let cdpClient = null;

  try {
    const targets = await listCdpTargets(cdpPort);
    const pageTarget = targets.find((t) => t.type === 'page');
    if (pageTarget) {
      cdpClient = await CDP({ host: CDP_HOST, port: cdpPort, target: pageTarget.id });
      cdpClient.on('Network.requestWillBeSent', (params) => {
        if (params?.request?.url && !params.request.url.startsWith('data:')) {
          lastReq = `${params.type || 'req'}:${params.request.url.slice(0, 90)}`;
        }
      });
      cdpClient.on('Target.targetCreated', (params) => {
        if (params?.targetInfo) {
          lastTargetEvt = `${params.targetInfo.type}:${(params.targetInfo.url || '').slice(0, 60)}`;
        }
      });
      await cdpClient.Page.enable();
      await cdpClient.Network.enable();
      try {
        await cdpClient.Target.setDiscoverTargets({ discover: true });
      } catch {}

      // Stage 1: Verify HTML + Font rendering locally via data: URL
      stage = '1:data-html';
      await cdpClient.Page.navigate({ url: 'data:text/html,<html><body><h1>TV Ready Check</h1></body></html>' });
      await new Promise((r) => setTimeout(r, 250));
      if (exitInfo) throw new Error('Crashed at 1:data-html');

      // Stage 2: Verify HTTPS + NSS via tiny robots.txt on tradingview.com
      stage = '2:https-robots';
      await cdpClient.Page.navigate({ url: 'https://www.tradingview.com/robots.txt' });
      await new Promise((r) => setTimeout(r, 600));
      if (exitInfo) throw new Error('Crashed at 2:https-robots');

      if (process.env.TV_SESSIONID) {
        await cdpClient.Network.setCookie({
          name: 'sessionid',
          value: process.env.TV_SESSIONID,
          domain: '.tradingview.com',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'Lax',
        });
        if (process.env.TV_SESSIONID_SIGN) {
          await cdpClient.Network.setCookie({
            name: 'sessionid_sign',
            value: process.env.TV_SESSIONID_SIGN,
            domain: '.tradingview.com',
            path: '/',
            secure: true,
            httpOnly: true,
            sameSite: 'Lax',
          });
        }
        browserState.loggedInCookieInjected = true;
      }

      // Stage 3: Navigate to full TradingView chart
      stage = '3:chart-nav';
      console.log(`[tv-browser] [${profile.name}] Probes 1(html) & 2(https) passed! Opening chart...`);
      await cdpClient.Page.navigate({ url: CHART_URL });
    }
  } catch (e) {
    console.warn(`[tv-browser] Stage warning (${profile.name} @ ${stage}, lastReq=${lastReq}, lastTarget=${lastTargetEvt}):`, e.message);
  }

  // 3. Wait up to 25s for window.TradingViewApi._activeChartWidgetWV.value() AND verify child hasn't crashed!
  const chartDeadline = Date.now() + 25000;
  let lastTarget = null;
  while (Date.now() < chartDeadline) {
    if (exitInfo) {
      try { if (cdpClient) await cdpClient.close(); } catch {}
      return {
        ok: false,
        error: `Crashed at [${stage}] (lastReq=${lastReq}, lastTarget=${lastTargetEvt}, exit=${JSON.stringify(exitInfo)}): ${stderrTail.trim().slice(-300)}`,
      };
    }

    try {
      if (cdpClient) {
        const { result } = await cdpClient.Runtime.evaluate({
          expression: `Boolean(window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV && window.TradingViewApi._activeChartWidgetWV.value())`,
          returnByValue: true,
        });
        if (result?.value === true) {
          try { await cdpClient.close(); } catch {}
          const targets = await listCdpTargets(cdpPort);
          const chartTarget = targets.find((t) => t.type === 'page' && /tradingview/i.test(t.url)) || targets.find((t) => t.type === 'page');
          return {
            ok: true,
            child,
            version,
            target: chartTarget,
            chartReady: true,
          };
        }
      }
    } catch {}

    await new Promise((r) => setTimeout(r, 1000));
  }

  try { if (cdpClient) await cdpClient.close(); } catch {}

  if (!exitInfo) {
    const targets = await listCdpTargets(cdpPort);
    lastTarget = targets.find((t) => t.type === 'page');
    return {
      ok: true,
      child,
      version,
      target: lastTarget,
      chartReady: false,
    };
  }

  try { child.kill('SIGKILL'); } catch {}
  return {
    ok: false,
    error: `Failed chart init at [${stage}] (lastReq=${lastReq}, exit=${JSON.stringify(exitInfo)}): ${stderrTail.trim().slice(-300)}`,
  };
}

export async function ensureHeadlessTradingView({ port = CDP_PORT, forceRestart = false } = {}) {
  if (launchPromise && !forceRestart) {
    return launchPromise;
  }

  launchPromise = (async () => {
    try {
      if (!forceRestart) {
        const existingVer = await probeCdpVersion(port);
        if (existingVer) {
          const targets = await listCdpTargets(port);
          const chartTarget = targets.find((t) => t.type === 'page' && /tradingview/i.test(t.url));
          if (chartTarget) {
            browserState.status = 'ready';
            browserState.cdpPort = port;
            return {
              success: true,
              reused: true,
              cdp_port: port,
              cdp_url: `http://${CDP_HOST}:${port}`,
              browser: existingVer.Browser,
              target_url: chartTarget.url,
            };
          }
        }
      }

      if (browserProcess) {
        try { browserProcess.kill('SIGKILL'); } catch {}
        browserProcess = null;
      }
      await disconnect();

      browserState.status = 'starting';
      browserState.lastError = null;

      const { binary, runtimeDir, isSparticuz } = await findBrowserBinary();
      const profileDir = join(runtimeDir, 'tv-profile');
      mkdirSync(profileDir, { recursive: true });

      console.log(`[tv-browser] Launching ${binary} on CDP port ${port}...`);

      const profiles = getLaunchProfiles({ profileDir, cdpPort: port, isSparticuz });
      let winner = null;
      let winnerProfile = null;
      const errors = [];

      for (const profile of profiles) {
        const res = await tryLaunchProfile({ binary, profile, cdpPort: port });
        if (res.ok) {
          winner = res;
          winnerProfile = profile;
          break;
        }
        console.warn(`[tv-browser] Profile "${profile.name}" failed: ${res.error}`);
        errors.push(`${profile.name}: ${res.error}`);
      }

      if (!winner) {
        browserState.status = 'error';
        browserState.lastError = errors.join(' | ');
        throw new Error(`All Chromium profiles failed: ${browserState.lastError}`);
      }

      browserProcess = winner.child;
      browserState.pid = browserProcess.pid;
      browserState.binary = binary;
      browserState.mode = winnerProfile.name;
      browserState.startedAt = new Date().toISOString();
      browserState.status = winner.chartReady ? 'ready' : 'cdp_up_chart_loading';

      browserProcess.on('exit', (code, signal) => {
        console.warn(`[tv-browser] Chromium process exited (code=${code}, signal=${signal})`);
        if (browserProcess?.pid === winner.child.pid) {
          browserProcess = null;
          browserState.status = 'exited';
        }
      });

      console.log(`[tv-browser] ✅ Active profile: "${winnerProfile.name}", status: ${browserState.status} (${winner.target?.url || CHART_URL})`);

      return {
        success: true,
        platform: process.platform,
        binary,
        mode: winnerProfile.name,
        pid: browserState.pid,
        cdp_port: port,
        cdp_url: `http://${CDP_HOST}:${port}`,
        chart_ready: winner.chartReady,
        browser: winner.version?.Browser,
        user_agent: winner.version?.['User-Agent'],
      };
    } catch (err) {
      browserState.status = 'error';
      browserState.lastError = err.message;
      console.error('[tv-browser] Error launching headless TradingView:', err.message);
      throw err;
    } finally {
      launchPromise = null;
    }
  })();

  return launchPromise;
}

export function startBrowserWatchdog(intervalMs = 30000) {
  setInterval(async () => {
    if (launchPromise || browserState.status === 'starting') return;
    const ver = await probeCdpVersion(CDP_PORT);
    if (!ver) {
      console.warn('[tv-browser] Watchdog detected CDP down — restarting headless TradingView...');
      try {
        await ensureHeadlessTradingView({ forceRestart: true });
      } catch (e) {
        console.error('[tv-browser] Watchdog restart failed:', e.message);
      }
    }
  }, intervalMs).unref();
}
