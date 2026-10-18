import { existsSync, mkdirSync, chmodSync, copyFileSync, unlinkSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, execSync } from 'node:child_process';
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
  process.env.VERCEL = '1';

  const binDir = join(__dirname, '..', 'node_modules', '@sparticuz', 'chromium', 'bin');
  const { inflate, setupLambdaEnvironment } = await import('@sparticuz/chromium');

  console.log(`[tv-browser] Extracting headless Chromium into ${runtimeDir} ...`);
  const [chromiumPath, , , al2023Path] = await Promise.all([
    inflate(join(binDir, 'chromium.br')),
    inflate(join(binDir, 'fonts.tar.br')),
    inflate(join(binDir, 'swiftshader.tar.br')),
    inflate(join(binDir, 'al2023.tar.br')),
  ]);

  chmodSync(chromiumPath, 0o755);
  const al2023Lib = join(al2023Path, 'lib');
  setupLambdaEnvironment(al2023Lib);

  const ldParts = [
    al2023Lib,
    runtimeDir,
    ...(process.env.LD_LIBRARY_PATH ? process.env.LD_LIBRARY_PATH.split(':') : []),
  ].filter(Boolean);
  process.env.LD_LIBRARY_PATH = [...new Set(ldParts)].join(':');
  process.env.FONTCONFIG_PATH = join(runtimeDir, 'fonts');

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

function buildFlags({ profileDir, cdpPort, isSparticuz, singleProcess }) {
  const common = [
    isSparticuz ? '--headless=shell' : '--headless=new',
    '--no-sandbox',
    '--no-zygote',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--in-process-gpu',
    '--ignore-gpu-blocklist',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--disable-translate',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-pings',
    '--disk-cache-size=33554432',
    '--font-render-hinting=none',
    '--allow-running-insecure-content',
    '--disable-site-isolation-trials',
    '--disable-web-security',
    '--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process',
    '--enable-features=SharedArrayBuffer',
    '--window-size=1920,1080',
    '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) TradingView/2.9.0 Chrome/131.0.0.0 Electron/33.0.0 Safari/537.36',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${cdpPort}`,
    '--remote-debugging-address=127.0.0.1',
  ];
  if (singleProcess) {
    common.push('--single-process');
  }
  common.push(CHART_URL);
  return common;
}

async function spawnAndWaitCdp({ binary, args, cdpPort, timeoutMs = 15000 }) {
  const child = spawn(binary, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  let stderrTail = '';
  child.stderr?.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-1500);
  });

  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });
  child.on('error', (err) => {
    exited = { error: err.message };
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) {
      return { ok: false, child, error: `Process exited (${JSON.stringify(exited)}): ${stderrTail.trim()}` };
    }
    const ver = await probeCdpVersion(cdpPort);
    if (ver) {
      return { ok: true, child, version: ver };
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  try { child.kill('SIGKILL'); } catch {}
  return { ok: false, child, error: `Timeout waiting for CDP on port ${cdpPort}. Stderr: ${stderrTail.trim()}` };
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

async function ensureChartReady(port = CDP_PORT, waitMs = 25000) {
  let targets = await listCdpTargets(port);
  let chartTarget = targets.find((t) => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    || targets.find((t) => t.type === 'page' && /tradingview/i.test(t.url));

  if (!chartTarget) {
    try {
      await fetch(`http://${CDP_HOST}:${port}/json/new?${encodeURIComponent(CHART_URL)}`, { method: 'PUT', signal: AbortSignal.timeout(5000) });
    } catch {
      try {
        await fetch(`http://${CDP_HOST}:${port}/json/new?${encodeURIComponent(CHART_URL)}`, { signal: AbortSignal.timeout(5000) });
      } catch {}
    }
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    targets = await listCdpTargets(port);
    chartTarget = targets.find((t) => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
      || targets.find((t) => t.type === 'page' && /tradingview/i.test(t.url));

    if (chartTarget) {
      let c = null;
      try {
        c = await CDP({ host: CDP_HOST, port, target: chartTarget.id });
        const { result } = await c.Runtime.evaluate({
          expression: `Boolean(window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV && window.TradingViewApi._activeChartWidgetWV.value())`,
          returnByValue: true,
        });
        await c.close();
        if (result?.value === true) {
          return { ready: true, target: chartTarget };
        }
      } catch {
        try { if (c) await c.close(); } catch {}
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  return { ready: false, target: chartTarget || null };
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
          const check = await ensureChartReady(port, 5000);
          if (check.ready) {
            browserState.status = 'ready';
            browserState.cdpPort = port;
            return {
              success: true,
              reused: true,
              cdp_port: port,
              cdp_url: `http://${CDP_HOST}:${port}`,
              browser: existingVer.Browser,
              target_url: check.target?.url,
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

      // Try standard container multi-process headless first, then fallback to --single-process if restricted
      let attempt = await spawnAndWaitCdp({
        binary,
        args: buildFlags({ profileDir, cdpPort: port, isSparticuz, singleProcess: false }),
        cdpPort: port,
        timeoutMs: 15000,
      });
      let mode = 'multi-process';

      if (!attempt.ok) {
        console.warn(`[tv-browser] Multi-process launch failed (${attempt.error}). Retrying with --single-process...`);
        attempt = await spawnAndWaitCdp({
          binary,
          args: buildFlags({ profileDir, cdpPort: port, isSparticuz, singleProcess: true }),
          cdpPort: port,
          timeoutMs: 15000,
        });
        mode = 'single-process';
      }

      if (!attempt.ok) {
        browserState.status = 'error';
        browserState.lastError = attempt.error;
        throw new Error(`Failed to launch headless Chromium: ${attempt.error}`);
      }

      browserProcess = attempt.child;
      browserState.pid = browserProcess.pid;
      browserState.binary = binary;
      browserState.mode = mode;
      browserState.startedAt = new Date().toISOString();

      browserProcess.on('exit', (code, signal) => {
        console.warn(`[tv-browser] Chromium process exited (code=${code}, signal=${signal})`);
        if (browserProcess?.pid === attempt.child.pid) {
          browserProcess = null;
          browserState.status = 'exited';
        }
      });

      if (process.env.TV_SESSIONID) {
        try {
          console.log('[tv-browser] Injecting TV_SESSIONID cookie...');
          await injectTradingViewCookies({ port });
        } catch (e) {
          console.warn('[tv-browser] Cookie injection warning:', e.message);
        }
      }

      console.log('[tv-browser] Waiting for TradingView chart widget to finish initializing...');
      const readyInfo = await ensureChartReady(port, 30000);
      browserState.status = readyInfo.ready ? 'ready' : 'cdp_up_chart_loading';
      console.log(`[tv-browser] Status: ${browserState.status} (${readyInfo.target?.url || CHART_URL})`);

      return {
        success: true,
        platform: process.platform,
        binary,
        mode,
        pid: browserState.pid,
        cdp_port: port,
        cdp_url: `http://${CDP_HOST}:${port}`,
        chart_ready: readyInfo.ready,
        browser: attempt.version?.Browser,
        user_agent: attempt.version?.['User-Agent'],
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
