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
import { healthCheck } from './core/health.js';

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
      // Allow Streamable HTTP GET on / if mcp-session-id is provided
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
            endpoints: {
              streamable_http: `${baseUrl}/mcp`,
              sse: `${baseUrl}/sse`,
              sse_messages: `${baseUrl}/messages`,
              health: `${baseUrl}/health`,
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
    res.end(JSON.stringify({ error: 'Not Found', hint: 'Use /mcp (Streamable HTTP) or /sse (SSE) for MCP connections.' }));
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
  console.log(`   • Streamable HTTP MCP : http://${HOST}:${PORT}/mcp (or /)`);
  console.log(`   • SSE MCP             : http://${HOST}:${PORT}/sse`);
  console.log(`   • Health & Status     : http://${HOST}:${PORT}/health`);
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
