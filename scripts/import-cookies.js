// Fallback when automatic login fails (captcha / 2FA):
// 1. Log in to Pickles or Manheim in Chrome on your own computer.
// 2. Use the free "Cookie-Editor" extension -> Export -> JSON, save as e.g. pickles-cookies.json
// 3. Copy it to the server and run: npm run import-cookies -- pickles pickles-cookies.json
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';

const [site, file] = process.argv.slice(2);
if (!['pickles', 'manheim'].includes(site) || !file) {
  console.log('Usage: npm run import-cookies -- <pickles|manheim> <cookies.json>');
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const list = Array.isArray(raw) ? raw : raw.cookies || [];
const sameSite = v => ({ no_restriction: 'None', none: 'None', lax: 'Lax', strict: 'Strict' }[String(v || '').toLowerCase()] || 'Lax');
const cookies = list.map(c => ({
  name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
  expires: c.expirationDate ? Math.floor(c.expirationDate) : (c.expires > 0 ? c.expires : -1),
  httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: sameSite(c.sameSite),
}));
fs.mkdirSync(config.dataDir, { recursive: true });
const dest = path.join(config.dataDir, `state-${site}.json`);
fs.writeFileSync(dest, JSON.stringify({ cookies, origins: [] }));
console.log(`Saved ${cookies.length} cookies to ${dest}. Restart the monitor to use them.`);
