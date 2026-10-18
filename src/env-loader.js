import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INITIAL_PANEL_ENV_KEYS = new Set(Object.keys(process.env));

function parseEnvContent(content) {
  const result = {};
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) result[key] = val;
  }
  return result;
}

export function loadEnvFiles({ overrideFromConfig = false } = {}) {
  const files = [join(REPO_ROOT, 'config.env'), join(REPO_ROOT, '.env')];
  const loaded = {};

  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const parsed = parseEnvContent(readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(parsed)) {
        // Panel-provided environment variables always take precedence if non-empty
        if (INITIAL_PANEL_ENV_KEYS.has(k) && process.env[k] !== undefined && process.env[k] !== '') {
          continue;
        }
        if (overrideFromConfig || process.env[k] === undefined || process.env[k] === '') {
          process.env[k] = v;
          loaded[k] = v;
        }
      }
    } catch (err) {
      console.warn(`[env-loader] Failed to read ${file}:`, err.message);
    }
  }
  return loaded;
}

// Auto-load on import
loadEnvFiles();
