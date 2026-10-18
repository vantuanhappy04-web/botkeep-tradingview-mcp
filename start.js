import './src/env-loader.js';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoUpdate } from './src/auto-update.js';
import { loadEnvFiles } from './src/env-loader.js';

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(REPO_ROOT, 'src', 'http-server.js');

let child = null;
let restarting = false;

function startServerProcess() {
  loadEnvFiles({ overrideFromConfig: true });
  console.log('[supervisor] Starting TradingView MCP HTTP/SSE server (84 tools)...');
  child = spawn(process.execPath, [SERVER_SCRIPT], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env },
  });

  child.on('exit', (code, signal) => {
    console.warn(`[supervisor] Server process exited (code=${code}, signal=${signal})`);
    child = null;
    if (!restarting) {
      // Auto-restart after 2s on crash or exit code 75 (update-restart requested)
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

async function main() {
  if (process.env.TV_AUTO_UPDATE !== 'false') {
    console.log('[supervisor] Checking for updates from GitHub before startup...');
    const res = await autoUpdate();
    if (res.updated) {
      console.log(`[supervisor] Updated to commit ${res.to_commit}`);
    } else if (res.commit) {
      console.log(`[supervisor] Already up-to-date (${res.commit})`);
    }
  }

  startServerProcess();

  const intervalMin = Number(process.env.TV_UPDATE_INTERVAL_MINUTES) || 15;
  if (process.env.TV_AUTO_UPDATE !== 'false' && intervalMin > 0) {
    setInterval(async () => {
      const res = await autoUpdate();
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
