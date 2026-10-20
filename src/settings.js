// Settings saved from the dashboard (data/settings.json, never in git). They override .env.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const file = path.join(config.dataDir, 'settings.json');
let saved = {};
try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }

const DEFAULTS = () => ({
  anthropicKey: config.anthropicKey,
  ntfyUrl: config.ntfyUrl,
  researchPerDay: config.researchPerDay,
  researchEnabled: true,
});

export function get(k) {
  const v = saved[k];
  return v !== undefined && v !== '' && v !== null ? v : DEFAULTS()[k];
}

export function set(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS())) continue;
    if (v === undefined) continue;
    saved[k] = typeof v === 'string' ? v.trim() : v;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(saved, null, 1), { mode: 0o600 });
}

const mask = s => (s ? `${s.slice(0, 7)}…${s.slice(-4)}` : '');

/** What the dashboard may see: never the full key. */
export function publicView() {
  const key = get('anthropicKey');
  return {
    anthropicKeySet: !!key,
    anthropicKeyMasked: mask(key),
    anthropicKeyFrom: saved.anthropicKey ? 'dashboard' : key ? '.env' : null,
    ntfyUrl: get('ntfyUrl') || '',
    researchPerDay: Number(get('researchPerDay')),
    researchEnabled: !!get('researchEnabled'),
  };
}
