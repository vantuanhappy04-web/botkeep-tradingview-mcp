import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;
// Overridable via TV_CDP_HOST/TV_CDP_PORT (or CDP_HOST/CDP_PORT) env vars.
// Default is 127.0.0.1, not localhost: on some Windows machines localhost
// resolves to ::1 first, and Electron's --remote-debugging-port only listens on IPv4.
export const CDP_HOST = process.env.TV_CDP_HOST || process.env.CDP_HOST || '127.0.0.1';
export const CDP_PORT = Number(process.env.TV_CDP_PORT || process.env.CDP_PORT) || 9223;
let activeCdpPort = CDP_PORT;
const CANDIDATE_PORTS = [...new Set([CDP_PORT, 9223, 9222, 9224])];
const MAX_RETRIES = 5;
const BASE_DELAY = 500;

export function getActiveCdpPort() {
  return activeCdpPort;
}

export function setActiveCdpPort(port) {
  if (Number.isFinite(Number(port)) && Number(port) > 0) {
    activeCdpPort = Number(port);
  }
}

async function fetchTargetsFromPort(port) {
  const resp = await fetch(`http://${CDP_HOST}:${port}/json/list`, {
    signal: AbortSignal.timeout(2000),
  });
  const text = await resp.text();
  let targets;
  try {
    targets = JSON.parse(text);
  } catch {
    throw new Error(`Port ${port} is occupied by a non-CDP service`);
  }
  if (!Array.isArray(targets)) {
    throw new Error(`Port ${port} did not return a CDP target list`);
  }
  return targets;
}

async function resolveTargetsAcrossPorts() {
  const portsToTry = [...new Set([activeCdpPort, ...CANDIDATE_PORTS])];
  let lastErr = null;
  for (const port of portsToTry) {
    try {
      const targets = await fetchTargetsFromPort(port);
      const hasTv = targets.some(t => t.type === 'page' && /tradingview/i.test(t.url || ''));
      if (hasTv || targets.some(t => t.type === 'page')) {
        activeCdpPort = port;
        return { port, targets };
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('No CDP server responding on ports ' + portsToTry.join(', '));
}

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  // Phase 1: Strategy data — model().dataSources() → find strategy → .performance().value(), .ordersData(), .reportData()
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  // Phase 2: Layouts — getSavedCharts(cb), loadChartFromServer(id)
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  // Phase 5: Symbol search — searchSymbols(query) returns Promise
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

/**
 * Sanitize a string for safe interpolation into JavaScript code evaluated via CDP.
 * Uses JSON.stringify to produce a properly escaped JS string literal (with quotes).
 * Prevents injection via quotes, backticks, template literals, or control chars.
 */
export function safeString(str) {
  return JSON.stringify(String(str));
}

/**
 * Validate that a value is a finite number. Throws if NaN, Infinity, or non-numeric.
 * Prevents corrupt values from reaching TradingView APIs that persist to cloud state.
 */
export function requireFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got: ${value}`);
  return n;
}

export async function getClient() {
  if (client) {
    try {
      // Quick liveness check
      await client.Runtime.evaluate({ expression: '1', returnByValue: true });
      return client;
    } catch {
      client = null;
      targetInfo = null;
    }
  }
  return connect();
}

export async function connect(targetId = null) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = targetId ? await findTargetById(targetId) : await findChartTarget();
      if (!target) {
        throw new Error(targetId
          ? `CDP target ${targetId} not found — is the tab still open?`
          : 'No TradingView chart target found. Is TradingView open with a chart?');
      }
      targetInfo = target;
      client = await CDP({ host: CDP_HOST, port: activeCdpPort, target: target.id });

      // Enable required domains
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();
      try {
        const adblockScript = `(() => {
          const cleanGopro = () => {
            document.querySelectorAll('[data-dialog-name="gopro"]').forEach(el => {
              const parentWrap = el.closest('#overlap-manager-root > div');
              if (parentWrap) parentWrap.remove();
              else el.remove();
            });
          };
          const injectStyle = () => {
            if (document.getElementById('__tv_adblock_style')) return;
            const style = document.createElement('style');
            style.id = '__tv_adblock_style';
            style.textContent = \`
              #overlap-manager-root > div:has([data-dialog-name="gopro"]),
              [data-dialog-name="gopro"],
              div[data-dialog-name="gopro"] {
                display: none !important;
                opacity: 0 !important;
                pointer-events: none !important;
                visibility: hidden !important;
                z-index: -9999 !important;
              }
            \`;
            (document.head || document.documentElement).appendChild(style);
          };
          if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => { injectStyle(); cleanGopro(); });
          } else {
            injectStyle();
            cleanGopro();
          }
          if (!window.__tv_gopro_observer) {
            window.__tv_gopro_observer = new MutationObserver(cleanGopro);
            window.__tv_gopro_observer.observe(document.documentElement, { childList: true, subtree: true });
          }
        })()`;
        await client.Page.addScriptToEvaluateOnNewDocument({ source: adblockScript });
        await client.Runtime.evaluate({ expression: adblockScript, returnByValue: true });
      } catch {}

      return client;
    } catch (err) {
      lastError = err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

/**
 * Re-attach the cached CDP client to a specific target id.
 * Used by tab_switch so subsequent reads (chart_get_state, data_get_*,
 * quote_get, screenshots) follow the activated tab instead of staying
 * glued to the target picked at first connect.
 */
export async function reconnectTo(targetId) {
  if (client) {
    try { await client.close(); } catch { /* already gone */ }
    client = null;
    targetInfo = null;
  }
  return connect(targetId);
}

async function findChartTarget() {
  const { targets } = await resolveTargetsAcrossPorts();
  // Prefer targets with tradingview.com/chart in the URL
  return targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    || targets.find(t => t.type === 'page' && /tradingview/i.test(t.url))
    || null;
}

async function findTargetById(id) {
  const { targets } = await resolveTargetsAcrossPorts();
  return targets.find(t => t.id === id) || null;
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const result = await c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
    ...opts,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true });
}

export async function disconnect() {
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
  }
}

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar() {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars() {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
