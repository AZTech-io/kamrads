// The three screens, sent with the person's own saved view settings (filters, sort, tab, run planner...)
// already in them, so they're the same on every phone and computer and survive a cleared browser.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as settings from './settings.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const cache = new Map();
const read = name => {
  const file = path.join(dir, name);
  const m = fs.statSync(file).mtimeMs;
  const c = cache.get(name);
  if (c && c.m === m) return c.html;
  const html = fs.readFileSync(file, 'utf8');
  cache.set(name, { m, html });
  return html;
};

export const prefsOf = user => settings.getUser(user, 'prefs') || {};
export function sendPage(res, name, user) {
  const json = JSON.stringify(prefsOf(user)).replace(/</g, '\\u003c');
  res.type('html').set('cache-control', 'no-store').send(read(name).replace('</head>', `<script>window.__PREFS=${json};</script>\n</head>`));
}

const KEY = /^k[2fb]_[A-Za-z]{1,24}$/;
const MAX_ONE = 4000, MAX_ALL = 40000;
/** Save (or with value null, forget) one setting for this person. */
export function savePref(user, key, value) {
  if (!KEY.test(String(key || ''))) throw new Error('Unknown setting');
  const prefs = { ...prefsOf(user) };
  if (value === null || value === undefined) delete prefs[key];
  else {
    const s = JSON.stringify(value);
    if (s.length > MAX_ONE) throw new Error('Setting too large');
    prefs[key] = value;
  }
  if (JSON.stringify(prefs).length > MAX_ALL) throw new Error('Too many settings');
  settings.setUser(user, { prefs });
}
