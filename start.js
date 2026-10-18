import './src/env-loader.js';
import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoUpdate } from './src/auto-update.js';
import { loadEnvFiles } from './src/env-loader.js';

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(REPO_ROOT, 'src', 'http-server.js');

let child = null;
let restarting = false;

function ensureDependencies() {
  const mcpDir = join(REPO_ROOT, 'node_modules', '@modelcontextprotocol', 'sdk');
  const chrDir = join(REPO_ROOT, 'node_modules', '@sparticuz', 'chromium');
  const cdpDir = join(REPO_ROOT, 'node_modules', 'chrome-remote-interface');
  if (!existsSync(mcpDir) || !existsSync(chrDir) || !existsSync(cdpDir)) {
    console.log('[supervisor] Missing node_modules — running npm install automatically...');
    execSync('npm install --no-audit --no-fund', {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      timeout: 300000,
    });
  }
}

function startServerProcess() {
  loadEnvFiles({ overrideFromConfig: true });
  ensureDependencies();
  console.log('[supervisor] Starting TradingView MCP HTTP/SSE server (84 tools)...');
  child = spawn(process.execPath, [SERVER_SCRIPT], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { ...process.env },
  });

  child.on('exit', (code, signal) => {
    console.warn(`[supervisor] Server process exited (code=${code}, signal=${signal})`);
    child = null;
    if (!restarting) {
      setTimeout(() => {
        startServerProcess();
      }, code === 75 ? 500 : 2000);
    }
  });
}

async function restartServerProcess() {
  if (restarting) return;
  restarting = true;
  if (child) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child?.kill('SIGKILL'); } catch {}
        resolve();
      }, 4000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try { child.kill('SIGTERM'); } catch { resolve(); }
    });
  }
  restarting = false;
  startServerProcess();
}

// Listen for Botkeep console commands ("update", "restart", "login <sid> <sig>", "status")
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  const line = chunk.trim();
  if (!line) return;
  const cmd = line.split(/\s+/)[0].toLowerCase();
  if (cmd === 'update' || cmd === 'pull') {
    console.log('[console] Đang kiểm tra và kéo bản cập nhật mới từ GitHub...');
    const res = await autoUpdate({ installDeps: true });
    console.log('[console] Kết quả update:', JSON.stringify(res));
    await restartServerProcess();
  } else if (cmd === 'restart') {
    console.log('[console] Đang khởi động lại server...');
    await restartServerProcess();
  } else if (child && child.stdin) {
    child.stdin.write(line + '\n');
  }
});

async function main() {
  if (process.env.TV_AUTO_UPDATE !== 'false') {
    console.log('[supervisor] Checking for updates from GitHub before startup...');
    const res = await autoUpdate({ installDeps: false });
    if (res.updated) {
      console.log(`[supervisor] Updated to commit ${res.to_commit}`);
    } else if (res.commit) {
      console.log(`[supervisor] Already up-to-date (${res.commit})`);
    }
  }

  ensureDependencies();
  startServerProcess();

  const intervalMin = Number(process.env.TV_UPDATE_INTERVAL_MINUTES) || 15;
  if (process.env.TV_AUTO_UPDATE !== 'false' && intervalMin > 0) {
    setInterval(async () => {
      const res = await autoUpdate({ installDeps: true });
      if (res.updated) {
        console.log(`[supervisor] New update applied (${res.from_commit} -> ${res.to_commit}). Reloading server...`);
        await restartServerProcess();
      }
    }, intervalMin * 60 * 1000).unref();
  }
}

main().catch((err) => {
  console.error('[supervisor] Fatal startup error:', err);
  startServerProcess();
});
