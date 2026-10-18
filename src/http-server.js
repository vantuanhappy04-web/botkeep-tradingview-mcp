import './env-loader.js';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createMcpServer } from './mcp-factory.js';
import {
  ensureHeadlessTradingView,
  getBrowserState,
  injectTradingViewCookies,
  startBrowserWatchdog,
} from './headless-browser.js';
import { getClient } from './connection.js';
import { healthCheck } from './core/health.js';
import { autoUpdate } from './auto-update.js';

const PORT = Number(
  process.env.PORT ||
  process.env.SERVER_PORT ||
  process.env.APP_PORT ||
  process.env.P_SERVER_PORT ||
  8000
);
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.MCP_API_KEY || '';

// Active stateful Streamable HTTP sessions: sessionId -> { transport, server, createdAt }
const httpSessions = new Map();
// Active SSE sessions: sessionId -> { transport, server, createdAt }
const sseSessions = new Map();

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Accept, Authorization, x-api-key, mcp-session-id, mcp-protocol-version, Last-Event-ID'
  );
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
}

function checkAuth(req, urlObj) {
  if (!API_KEY) return true;
  const authHeader = req.headers['authorization'] || '';
  const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
  const headerKey = req.headers['x-api-key'] || '';
  const queryKey = urlObj.searchParams.get('apiKey') || urlObj.searchParams.get('token') || '';
  return bearer === API_KEY || headerKey === API_KEY || queryKey === API_KEY;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 4 * 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function renderLiveViewerHtml() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>TradingView MCP — Xem & Điều Khiển Biểu Đồ Trực Tiếp</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0f172a; color: #e2e8f0; font-family: system-ui, -apple-system, sans-serif; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    header { background: #1e293b; border-bottom: 1px solid #334155; padding: 8px 14px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; }
    .brand { font-weight: 700; color: #38bdf8; margin-right: 8px; }
    .badge { background: #065f46; color: #6ee7b7; padding: 3px 8px; border-radius: 99px; font-size: 12px; }
    input, select, button { background: #0f172a; color: #f8fafc; border: 1px solid #475569; border-radius: 6px; padding: 5px 10px; font-size: 13px; }
    button { cursor: pointer; background: #2563eb; border-color: #3b82f6; font-weight: 500; }
    button:hover { background: #1d4ed8; }
    button.secondary { background: #334155; border-color: #475569; }
    .spacer { flex: 1; }
    #stage { flex: 1; display: flex; align-items: center; justify-content: center; overflow: auto; background: #020617; position: relative; }
    #screen { max-width: 100%; max-height: 100%; object-fit: contain; cursor: crosshair; box-shadow: 0 0 24px rgba(0,0,0,0.6); }
    #modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); align-items: center; justify-content: center; z-index: 50; }
    .modal-card { background: #1e293b; border: 1px solid #475569; border-radius: 10px; padding: 18px; width: 420px; max-width: 92vw; display: flex; flex-direction: column; gap: 10px; }
    .modal-card h3 { color: #38bdf8; }
    .modal-card label { font-size: 12px; color: #94a3b8; }
  </style>
</head>
<body>
  <header>
    <span class="brand">📈 TradingView MCP Live View</span>
    <span id="statusBadge" class="badge">Đang kết nối...</span>
    <label>Tốc độ làm mới:</label>
    <select id="fps">
      <option value="1000" selected>1 giây / lần</option>
      <option value="500">0.5 giây / lần (Nhanh)</option>
      <option value="2500">2.5 giây / lần (Tiết kiệm)</option>
      <option value="0">Tạm dừng</option>
    </select>
    <input id="textInput" type="text" placeholder="Gõ chữ/mã rồi Enter gửi vào chart..." style="width:220px;" />
    <button onclick="sendKey('Enter', 13)" class="secondary">Enter</button>
    <button onclick="sendKey('Escape', 27)" class="secondary">Esc</button>
    <div class="spacer"></div>
    <button onclick="openLogin()" class="secondary">🔑 Đăng nhập Cookie TV</button>
    <a href="/screenshot" target="_blank"><button class="secondary">📸 Mở ảnh gốc</button></a>
  </header>
  <div id="stage">
    <img id="screen" src="/screenshot" alt="TradingView Live Chart" />
  </div>

  <div id="modal">
    <div class="modal-card">
      <h3>Đăng nhập tài khoản TradingView</h3>
      <p style="font-size:12px;color:#cbd5e1;">Mở tradingview.com trên trình duyệt của bạn → F12 (Application → Cookies) → copy giá trị <b>sessionid</b> và <b>sessionid_sign</b> dán vào đây để đồng bộ biểu đồ & layout của bạn:</p>
      <label>Cookie sessionid:</label>
      <input id="sid" type="text" placeholder="Dán sessionid..." />
      <label>Cookie sessionid_sign:</label>
      <input id="sig" type="text" placeholder="Dán sessionid_sign..." />
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px;">
        <button class="secondary" onclick="closeLogin()">Đóng</button>
        <button onclick="submitLogin()">Lưu & Đăng nhập</button>
      </div>
    </div>
  </div>

  <script>
    const img = document.getElementById('screen');
    const badge = document.getElementById('statusBadge');
    const fpsSelect = document.getElementById('fps');
    const textInput = document.getElementById('textInput');
    const q = window.location.search || '';
    let loading = false;

    function refreshFrame() {
      if (loading) return;
      loading = true;
      const next = new Image();
      const sep = q ? q + '&' : '?';
      next.onload = () => {
        img.src = next.src;
        loading = false;
      };
      next.onerror = () => { loading = false; };
      next.src = '/screenshot' + sep + 't=' + Date.now();
    }

    let timer = setInterval(refreshFrame, 1000);
    fpsSelect.addEventListener('change', () => {
      clearInterval(timer);
      const ms = Number(fpsSelect.value);
      if (ms > 0) timer = setInterval(refreshFrame, ms);
    });

    async function pollHealth() {
      try {
        const r = await fetch('/health' + q);
        const d = await r.json();
        const tv = d.tradingview || {};
        badge.textContent = tv.api_available
          ? (tv.chart_symbol + ' (' + tv.chart_resolution + ') • Sẵn sàng')
          : ('Trạng thái: ' + (d.browser?.status || 'Đang tải chart...'));
      } catch {}
    }
    pollHealth();
    setInterval(pollHealth, 4000);

    img.addEventListener('click', async (e) => {
      const rect = img.getBoundingClientRect();
      const scaleX = (img.naturalWidth || 1920) / rect.width;
      const scaleY = (img.naturalHeight || 1080) / rect.height;
      const x = Math.round((e.clientX - rect.left) * scaleX);
      const y = Math.round((e.clientY - rect.top) * scaleY);
      await fetch('/view/input' + q, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'click', x, y })
      });
      setTimeout(refreshFrame, 250);
    });

    textInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && textInput.value) {
        const val = textInput.value;
        textInput.value = '';
        await fetch('/view/input' + q, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'text', text: val })
        });
        setTimeout(refreshFrame, 300);
      }
    });

    async function sendKey(key, keyCode) {
      await fetch('/view/input' + q, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'key', key, keyCode })
      });
      setTimeout(refreshFrame, 250);
    }

    function openLogin() { document.getElementById('modal').style.display = 'flex'; }
    function closeLogin() { document.getElementById('modal').style.display = 'none'; }
    async function submitLogin() {
      const sessionid = document.getElementById('sid').value.trim();
      const sessionid_sign = document.getElementById('sig').value.trim();
      if (!sessionid) return alert('Vui lòng nhập sessionid');
      const r = await fetch('/login' + q, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionid, sessionid_sign })
      });
      const d = await r.json();
      closeLogin();
      alert(d.injected ? 'Đã nạp cookie và tải lại biểu đồ!' : ('Lỗi: ' + (d.reason || 'unknown')));
      setTimeout(refreshFrame, 1500);
    }
  </script>
</body>
</html>`;
}

async function handleMcpStreamableHttp(req, res) {
  const sessionId = req.headers['mcp-session-id'];

  if (sessionId && httpSessions.has(sessionId)) {
    const session = httpSessions.get(sessionId);
    await session.transport.handleRequest(req, res);
    return;
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    const isInit = Array.isArray(body)
      ? body.some((m) => m && m.method === 'initialize')
      : Boolean(body && body.method === 'initialize');

    if (isInit) {
      const server = createMcpServer();
      let transport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          httpSessions.set(sid, { transport, server, createdAt: Date.now() });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          httpSessions.delete(transport.sessionId);
        }
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    // Stateless fallback so clients that send tools/list or tools/call directly without session still work
    const statelessServer = createMcpServer();
    const statelessTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on('close', () => {
      statelessTransport.close().catch(() => {});
      statelessServer.close().catch(() => {});
    });
    await statelessServer.connect(statelessTransport);
    await statelessTransport.handleRequest(req, res, body);
    return;
  }

  if (req.method === 'GET' || req.method === 'DELETE') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid mcp-session-id header' }));
    return;
  }

  res.writeHead(405, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Method not allowed' }));
}

async function handleSseConnect(req, res, urlObj) {
  const apiKeyParam = urlObj.searchParams.get('apiKey') || urlObj.searchParams.get('token');
  const postEndpoint = apiKeyParam ? `/messages?apiKey=${encodeURIComponent(apiKeyParam)}` : '/messages';

  const transport = new SSEServerTransport(postEndpoint, res);
  const server = createMcpServer();
  const sid = transport.sessionId;
  sseSessions.set(sid, { transport, server, createdAt: Date.now() });

  res.on('close', () => {
    sseSessions.delete(sid);
    server.close().catch(() => {});
  });

  await server.connect(transport);
}

async function handleSseMessage(req, res, urlObj) {
  const sid = urlObj.searchParams.get('sessionId');
  let session = sid ? sseSessions.get(sid) : null;
  if (!session && sseSessions.size === 1) {
    session = [...sseSessions.values()][0];
  }
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'SSE session not found. Connect to GET /sse first.' }));
    return;
  }
  await session.transport.handlePostMessage(req, res);
}

const httpServer = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  try {
    // Public status / health endpoints for Botkeep
    if ((pathname === '/' || pathname === '/health') && req.method === 'GET') {
      if (pathname === '/' && req.headers['mcp-session-id']) {
        if (!checkAuth(req, urlObj)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        await handleMcpStreamableHttp(req, res);
        return;
      }

      const bState = getBrowserState();
      let tvHealth = null;
      if (bState.status === 'ready' || bState.status === 'cdp_up_chart_loading') {
        try {
          tvHealth = await healthCheck();
        } catch (e) {
          tvHealth = { cdp_connected: false, error: e.message };
        }
      }

      const proto = req.headers['x-forwarded-proto'] || 'http';
      const host = req.headers['host'] || `localhost:${PORT}`;
      const baseUrl = `${proto}://${host}`;

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify(
          {
            service: 'tradingview-mcp-remote',
            version: '2.0.0',
            tools_count: 84,
            status: 'ok',
            auth_enabled: Boolean(API_KEY),
            auto_update_enabled: process.env.TV_AUTO_UPDATE !== 'false',
            endpoints: {
              live_chart_viewer: `${baseUrl}/view`,
              live_screenshot: `${baseUrl}/screenshot`,
              streamable_http: `${baseUrl}/mcp`,
              sse: `${baseUrl}/sse`,
              sse_messages: `${baseUrl}/messages`,
              health: `${baseUrl}/health`,
              update: `${baseUrl}/update`,
              login_cookies: `${baseUrl}/login`,
              restart_browser: `${baseUrl}/restart-browser`,
            },
            active_sessions: {
              streamable_http: httpSessions.size,
              sse: sseSessions.size,
            },
            browser: bState,
            tradingview: tvHealth,
          },
          null,
          2
        )
      );
      return;
    }

    if (!checkAuth(req, urlObj)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing MCP_API_KEY' }));
      return;
    }

    // Live interactive browser viewer so the user can watch & click the headless chart in real time
    if ((pathname === '/view' || pathname === '/live') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderLiveViewerHtml());
      return;
    }

    // Live PNG screenshot from headless Chromium
    if (pathname === '/screenshot' && req.method === 'GET') {
      const c = await getClient();
      const { data } = await c.Page.captureScreenshot({ format: 'png' });
      const buf = Buffer.from(data, 'base64');
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      res.end(buf);
      return;
    }

    // Forward mouse/keyboard interactions from /view into headless Chromium
    if (pathname === '/view/input' && req.method === 'POST') {
      const body = (await readJsonBody(req)) || {};
      const c = await getClient();
      if (body.type === 'click') {
        const x = Number(body.x) || 0;
        const y = Number(body.y) || 0;
        await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y, button: 'left' });
        await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      } else if (body.type === 'text' && body.text) {
        await c.Input.insertText({ text: String(body.text) });
        await c.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Enter', windowsVirtualKeyCode: 13 });
        await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 });
      } else if (body.type === 'key' && body.key) {
        const vk = Number(body.keyCode) || 0;
        await c.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: String(body.key), windowsVirtualKeyCode: vk });
        await c.Input.dispatchKeyEvent({ type: 'keyUp', key: String(body.key), windowsVirtualKeyCode: vk });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Also allow POST / to act as Streamable HTTP MCP endpoint so users can pass base URL directly
    if (pathname === '/mcp' || (pathname === '/' && req.method === 'POST')) {
      await handleMcpStreamableHttp(req, res);
      return;
    }

    if (pathname === '/sse' && req.method === 'GET') {
      await handleSseConnect(req, res, urlObj);
      return;
    }

    if (pathname === '/messages' && req.method === 'POST') {
      await handleSseMessage(req, res, urlObj);
      return;
    }

    if (pathname === '/update' && (req.method === 'POST' || req.method === 'GET')) {
      const result = await autoUpdate();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result, null, 2));
      if (result.updated) {
        setTimeout(() => process.exit(75), 500);
      }
      return;
    }

    if (pathname === '/login' && req.method === 'POST') {
      const body = (await readJsonBody(req)) || {};
      const result = await injectTradingViewCookies({
        sessionid: body.sessionid,
        sessionid_sign: body.sessionid_sign,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...result }));
      return;
    }

    if (pathname === '/restart-browser' && req.method === 'POST') {
      const result = await ensureHeadlessTradingView({ forceRestart: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found', hint: 'Use /view to watch chart, /mcp (Streamable HTTP) or /sse (SSE) for MCP connections.' }));
  } catch (err) {
    console.error('[http-server] Request error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Internal Server Error' }));
    }
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(`=============================================================`);
  console.log(`🚀 TradingView MCP Remote Server listening on http://${HOST}:${PORT}`);
  console.log(`   • Live Chart Viewer   : http://${HOST}:${PORT}/view`);
  console.log(`   • Live Screenshot     : http://${HOST}:${PORT}/screenshot`);
  console.log(`   • Streamable HTTP MCP : http://${HOST}:${PORT}/mcp (or /)`);
  console.log(`   • SSE MCP             : http://${HOST}:${PORT}/sse`);
  console.log(`   • Health & Status     : http://${HOST}:${PORT}/health`);
  console.log(`   • Auto-Update Trigger : http://${HOST}:${PORT}/update`);
  console.log(`   • Tools registered    : 84 tools (full tradingview-mcp)`);
  console.log(`=============================================================`);

  if (process.env.TV_AUTO_LAUNCH !== 'false') {
    ensureHeadlessTradingView()
      .then(() => {
        startBrowserWatchdog(30000);
      })
      .catch((err) => {
        console.error('[startup] Initial headless TradingView launch failed:', err.message);
        startBrowserWatchdog(30000);
      });
  }
});
