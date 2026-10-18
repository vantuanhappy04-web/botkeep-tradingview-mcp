import {
  existsSync,
  mkdirSync,
  chmodSync,
  copyFileSync,
  unlinkSync,
  statfsSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir, totalmem, freemem } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, execSync, execFileSync } from 'node:child_process';
import { brotliDecompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
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
  const candidates = [
    process.env.TV_RUNTIME_DIR,
    '/tmp/tv-chromium',
    join(process.cwd(), '.tv-chromium'),
    process.env.HOME ? join(process.env.HOME, '.cache', 'tv-chromium') : null,
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
  const fallback = join(tmpdir(), 'tv-chromium');
  mkdirSync(fallback, { recursive: true });
  return fallback;
}

async function resolveSparticuzChromium() {
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
  const { inflate, setupLambdaEnvironment } = await import('@sparticuz/chromium');

  console.log(`[tv-browser] Extracting headless Chromium into ${runtimeDir} ...`);
  const [chromiumPath, fontsOutPath, , al2023Path] = await Promise.all([
    inflate(join(binDir, 'chromium.br')),
    inflate(join(binDir, 'fonts.tar.br')),
    inflate(join(binDir, 'swiftshader.tar.br')),
    inflate(join(binDir, 'al2023.tar.br')),
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
      console.log(`[tv-browser] Installed bundled libsqlite3.so.0 (${Math.round(rawSqlite.length / 1024)} KB) into ${al2023Lib}`);
    } catch (e) {
      console.warn('[tv-browser] Failed extracting vendor/libsqlite3.so.0.br:', e.message);
    }
  }

  setupLambdaEnvironment(al2023Lib);

  // 2. Fix fonts.conf! @sparticuz/chromium hardcodes /tmp/fonts inside fonts.conf.
  // When runtimeDir is /home/container/.tv-chromium, Fontconfig finds 0 fonts and Blink hits CHECK(last_resort_font) -> SIGTRAP on first page text!
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
    al2023Lib,
    runtimeDir,
    '/usr/lib/x86_64-linux-gnu',
    '/lib/x86_64-linux-gnu',
    '/usr/lib64',
    '/lib64',
    ...(process.env.LD_LIBRARY_PATH ? process.env.LD_LIBRARY_PATH.split(':') : []),
  ].filter(Boolean);
  process.env.LD_LIBRARY_PATH = [...new Set(ldParts)].join(':');

  // 4. Quick container diagnostics (RAM, cgroup limit, limits, missing .so check)
  try {
    let cgroupMem = 'unknown';
    for (const cgPath of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
      if (existsSync(cgPath)) {
        cgroupMem = readFileSync(cgPath, 'utf8').trim();
        break;
      }
    }
    let cgroupPids = 'unknown';
    for (const pidPath of ['/sys/fs/cgroup/pids.max', '/sys/fs/cgroup/pids/pids.max']) {
      if (existsSync(pidPath)) {
        cgroupPids = readFileSync(pidPath, 'utf8').trim();
        break;
      }
    }
    let vmemLimit = 'unknown';
    if (existsSync('/proc/self/limits')) {
      const lim = readFileSync('/proc/self/limits', 'utf8');
      const m = lim.split('\n').find((l) => l.startsWith('Max address space'));
      if (m) vmemLimit = m.replace(/\s+/g, ' ').trim();
    }
    console.log(
      `[tv-browser] Host RAM free=${Math.round(freemem() / 1048576)}MB/${Math.round(totalmem() / 1048576)}MB, cgroup.mem=${cgroupMem}, pids.max=${cgroupPids}, sqlite3=${existsSync(targetSqliteSo)}, ${vmemLimit}`
    );
    const lddChr = execFileSync('ldd', [chromiumPath], { env: process.env, encoding: 'utf8' });
    const missChr = lddChr.split('\n').filter((l) => l.includes('not found'));
    if (missChr.length) console.warn('[tv-browser] Missing libs (chromium):', missChr.join(' | '));
    const lddSoft = execFileSync('ldd', [join(al2023Lib, 'libsoftokn3.so')], { env: process.env, encoding: 'utf8' });
    const missSoft = lddSoft.split('\n').filter((l) => l.includes('not found'));
    if (missSoft.length) console.warn('[tv-browser] Missing libs (libsoftokn3.so):', missSoft.join(' | '));
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
  const baseCommon = [
    isSparticuz ? '--headless=shell' : '--headless=new',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-seccomp-filter-sandbox',
    '--disable-namespace-sandbox',
    '--disable-dev-shm-usage',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--enable-logging=stderr',
    '--log-level=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-pings',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--disable-translate',
    '--disable-domain-reliability',
    '--disable-print-preview',
    '--metrics-recording-only',
    '--mute-audio',
    '--ash-no-nudges',
    '--disk-cache-size=33554432',
    '--font-render-hinting=none',
    '--allow-running-insecure-content',
    '--disable-site-isolation-trials',
    '--disable-web-security',
    '--window-size=1920,1080',
    '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    `--remote-debugging-port=${cdpPort}`,
    '--remote-debugging-address=127.0.0.1',
  ];

  const disableFeatures = [
    'AudioServiceOutOfProcess',
    'AudioServiceSandbox',
    'IsolateOrigins',
    'site-per-process',
    'WebAssemblyTrapHandler',
    'WebAssemblyTiering',
    'WebAssemblyDynamicTiering',
    'WebAssemblyLazyCompilation',
    'BackForwardCache',
  ].join(',');

  const enableFeatures = ['NetworkServiceInProcess2', 'TracingServiceInProcess'].join(',');

  return [
    {
      name: 'single-process-2d-nowasmtrap',
      args: [
        ...baseCommon,
        '--no-zygote',
        '--single-process',
        '--in-process-gpu',
        '--disable-gpu',
        '--disable-webgl',
        '--disable-3d-apis',
        '--disable-gpu-compositing',
        '--disable-accelerated-2d-canvas',
        `--disable-features=${disableFeatures},Vulkan`,
        `--enable-features=${enableFeatures}`,
        '--num-raster-threads=1',
        '--js-flags=--no-wasm-tier-up --no-wasm-dynamic-tiering --no-wasm-lazy-compilation',
        `--user-data-dir=${join(profileDir, 'p1')}`,
        'about:blank',
      ],
    },
    {
      name: 'single-process-swiftshader-nowasmtrap',
      args: [
        ...baseCommon,
        '--no-zygote',
        '--single-process',
        '--in-process-gpu',
        '--ignore-gpu-blocklist',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        `--disable-features=${disableFeatures}`,
        `--enable-features=${enableFeatures}`,
        '--num-raster-threads=1',
        '--js-flags=--no-wasm-tier-up --no-wasm-dynamic-tiering --no-wasm-lazy-compilation',
        `--user-data-dir=${join(profileDir, 'p2')}`,
        'about:blank',
      ],
    },
    {
      name: 'multiprocess-inproc-net',
      args: [
        ...baseCommon,
        '--in-process-gpu',
        '--disable-gpu',
        '--disable-webgl',
        '--disable-3d-apis',
        '--disable-gpu-compositing',
        '--renderer-process-limit=1',
        '--num-raster-threads=1',
        `--disable-features=${disableFeatures},Vulkan,UseDisplayCompositor`,
        `--enable-features=${enableFeatures}`,
        '--js-flags=--no-wasm-tier-up --no-wasm-dynamic-tiering --no-wasm-lazy-compilation',
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
