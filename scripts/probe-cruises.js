// Diagnose the cruise reader: npm run probe-cruises -- [port]   (default: sydney)
// Opens that port's OzCruising page the way the hourly read does, prints what it could read, and saves the page
// (screenshot, html, text, the data it loaded) to data/probe/ so the reader can be matched to it if the site changes.
import fs from 'node:fs';
import path from 'node:path';
import { withPage, closeBrowser, looksBlocked } from '../src/browser.js';
import { config } from '../src/config.js';
import { PORTS, portUrl, cardFromText, cardsFromJson, cardsFromPageText, nightly } from '../src/cruises/parse.js';

const slug = (process.argv[2] || 'sydney').toLowerCase();
if (!PORTS[slug]) { console.log(`Unknown port "${slug}". Ports: ${Object.keys(PORTS).join(', ')}`); process.exit(1); }
const portKey = PORTS[slug].key;
const out = path.join(config.dataDir, 'probe', `cruises-${slug}-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });

const r = await withPage('ozcruising', portUrl(slug), async page => {
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 3000); await page.waitForTimeout(800); }
  await page.screenshot({ path: path.join(out, 'page.png'), fullPage: false }).catch(() => {});
  return page.evaluate(() => {
    const rx = /\/cruise\/([a-z0-9][a-z0-9.-]{3,40})/i;
    const links = [...document.querySelectorAll('a[href]')].filter(a => rx.test(a.href));
    const buttons = [...document.querySelectorAll('button, a')].map(b => (b.innerText || '').trim()).filter(t => /more|next|sort|price/i.test(t) && t.length < 40);
    const selects = [...document.querySelectorAll('select')].map(s => [...s.options].map(o => o.text).join(' | '));
    const cards = links.slice(0, 6).map(a => { let b = a; for (let i = 0; i < 6 && b.parentElement && (b.innerText || '').length < 120; i++) b = b.parentElement; return { href: a.href, text: (b.innerText || '').trim() }; });
    return { linkCount: links.length, buttons: [...new Set(buttons)].slice(0, 20), selects, cards };
  });
}, { waitMs: 3000 });

fs.writeFileSync(path.join(out, 'page.html'), r.html || '');
fs.writeFileSync(path.join(out, 'page.txt'), r.text || '');
fs.writeFileSync(path.join(out, 'data.json'), JSON.stringify(r.json, null, 1).slice(0, 8e6));

console.log(`\nHTTP ${r.status} · ${r.finalUrl} · ${looksBlocked(r) ? 'LOOKS BLOCKED' : 'not blocked'}`);
console.log(`Links to cruise pages: ${r.result?.linkCount ?? 0}`);
console.log(`Sort / more / next controls: ${(r.result?.buttons || []).join(' · ') || 'none seen'}`);
for (const s of r.result?.selects || []) console.log(`  <select>: ${s.slice(0, 160)}`);
const fromJson = cardsFromJson(r.json, { portKey });
const fromCards = (r.result?.cards || []).map(c => cardFromText(c.text, { href: c.href, portKey })).filter(Boolean);
const fromText = cardsFromPageText(r.text, { portKey });
console.log(`\nRead from the page's data: ${fromJson.length} · from its cards: ${fromCards.length} (of the first 6) · from its text: ${fromText.length}`);
for (const c of (fromJson.length ? fromJson : fromCards.length ? fromCards : fromText).slice(0, 8)) {
  const n = nightly(c);
  console.log(`  ${c.depart || '????-??-??'} ${String(c.nights).padStart(2)}n  ${(c.ship || '?').padEnd(22)} ${(c.line || '?').padEnd(16)} twin ${c.twin ?? '-'}  share ${c.quad ?? c.triple ?? '-'}  ${n.twin ? '$' + n.twin.toFixed(0) + '/night' : ''}  ${c.title || ''}`);
}
console.log('\n--- First card as the page shows it ---');
console.log((r.result?.cards?.[0]?.text || '(no card found)').slice(0, 600));
console.log(`\nSaved to ${out}`);
await closeBrowser();
process.exit(0);
