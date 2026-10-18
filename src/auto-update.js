import './env-loader.js';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFiles } from './env-loader.js';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_REPO = 'https://github.com/vantuanhappy04-web/botkeep-tradingview-mcp.git';

function sh(cmd, timeout = 30000) {
  return execSync(cmd, {
    cwd: REPO_ROOT,
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
}

export async function autoUpdate({ installDeps = true } = {}) {
  const repoUrl = process.env.TV_GIT_REPO || DEFAULT_REPO;
  const branch = process.env.TV_GIT_BRANCH || 'main';

  try {
    sh('git --version', 5000);
  } catch (err) {
    return { success: false, updated: false, error: `git not available: ${err.message}` };
  }

  try {
    if (!existsSync(join(REPO_ROOT, '.git'))) {
      console.log(`[auto-update] Initializing git repository connected to ${repoUrl}...`);
      sh(`git init -b ${branch}`);
      sh(`git remote add origin ${repoUrl}`);
      sh(`git fetch origin ${branch}`, 45000);
      sh(`git reset --hard origin/${branch}`);
      loadEnvFiles({ overrideFromConfig: true });
      const head = sh('git rev-parse --short HEAD');
      return {
        success: true,
        updated: true,
        initialized_git: true,
        to_commit: head,
      };
    }

    // Ensure remote origin points to the configured repo
    try {
      const currentOrigin = sh('git remote get-url origin');
      if (currentOrigin !== repoUrl) {
        sh(`git remote set-url origin ${repoUrl}`);
      }
    } catch {
      sh(`git remote add origin ${repoUrl}`);
    }

    const before = sh('git rev-parse HEAD');
    sh(`git fetch origin ${branch}`, 45000);
    const remote = sh(`git rev-parse origin/${branch}`);

    if (before === remote) {
      return {
        success: true,
        updated: false,
        status: 'up_to_date',
        commit: before.slice(0, 8),
      };
    }

    let pkgChanged = false;
    try {
      pkgChanged = sh(`git diff --name-only ${before} ${remote} -- package.json package-lock.json`) !== '';
    } catch {
      pkgChanged = true;
    }

    console.log(`[auto-update] New version found (${before.slice(0, 8)} -> ${remote.slice(0, 8)}). Updating...`);
    sh(`git reset --hard origin/${branch}`, 30000);
    loadEnvFiles({ overrideFromConfig: true });

    let depsInstalled = false;
    if (installDeps && pkgChanged) {
      console.log('[auto-update] package.json changed, running npm install...');
      sh('npm install --no-audit --no-fund', 180000);
      depsInstalled = true;
    }

    return {
      success: true,
      updated: true,
      from_commit: before.slice(0, 8),
      to_commit: remote.slice(0, 8),
      deps_installed: depsInstalled,
    };
  } catch (err) {
    console.warn('[auto-update] Update check failed:', err.message);
    return {
      success: false,
      updated: false,
      error: err.message,
    };
  }
}

// Allow running directly via `npm run update` or `node src/auto-update.js`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  autoUpdate().then((res) => {
    console.log(JSON.stringify(res, null, 2));
  });
}
