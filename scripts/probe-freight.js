// Diagnose a freight job board: npm run probe-freight -- [url]   (default: Truckit's job board)
// Prints what the page shows and loads so the job reader can be matched to it. Files go to data/probe/.
import fs from 'node:fs';
import path from 'node:path';
import { withPage, closeBrowser, looksBlocked } from '../src/browser.js';
import { config } from '../src/config.js';

const url = process.argv[2] || 'https://www.truckit.net/search-for-jobs';
const site = /airtasker/.test(url) ? 'airtasker' : 'truckit';
const out = path.join(config.dataDir, 'probe', `${site}-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });

const r = await withPage(site, url, async page => {
  await page.screenshot({ path: path.join(out, 'page.png'), fullPage: false }).catch(() => {});
  return page.evaluate(() => {
    const links = new Map();
    for (const a of document.querySelectorAll('a[href]')) {
      const h = a.href.split('#')[0];
      if (!links.has(h)) links.set(h, (a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 70));
    }
    // things that look clickable but aren't links (job cards are sometimes buttons / divs)
    const clicky = [...document.querySelectorAll('[onclick], [data-href], [data-url], [data-id], [data-job-id], [ng-click], [role="button"]')]
      .slice(0, 15).map(e => ({ tag: e.tagName, attrs: [...e.attributes].map(x => `${x.name}=${String(x.value).slice(0, 60)}`).join(' ').slice(0, 200), text: (e.innerText || '').replace(/\s+/g, ' ').slice(0, 90) }));
    return { links: [...links.entries()], clicky };
  });
}, { scrolls: 4, waitMs: 3000 });

console.log(`\nHTTP ${r.status} · final URL ${r.finalUrl} · ${looksBlocked(r) ? 'LOOKS BLOCKED' : 'not blocked'}`);
if (/log ?in|sign ?in/i.test(r.text.slice(0, 2000))) console.log('Page mentions logging in near the top.');

console.log('\n--- Page text (first 1500 characters) ---');
console.log(r.text.replace(/\n{2,}/g, '\n').slice(0, 1500));

const own = (r.result?.links || []).filter(([h]) => /truckit|airtasker/.test(h));
console.log(`\n--- Links on the site (${own.length}), grouped by pattern ---`);
const groups = new Map();
for (const [h, t] of own) {
  const pat = h.replace(/^https?:\/\/[^/]+/, '').replace(/\d{3,}/g, '{n}').replace(/[?].*$/, '?…');
  if (!groups.has(pat)) groups.set(pat, []);
  groups.get(pat).push([h, t]);
}
for (const [pat, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 25)) console.log(`  ${String(list.length).padStart(3)} × ${pat}   e.g. "${list[0][1]}"`);

console.log('\n--- Clickable non-link elements ---');
for (const c of r.result?.clicky || []) console.log(`  <${c.tag} ${c.attrs}> ${c.text}`);

const ownJson = r.json.filter(j => !/google|gstatic|doubleclick|facebook|hotjar|clarity|bing/.test(j.url));
console.log(`\n--- Data the page loaded (${ownJson.length} of ${r.json.length} responses) ---`);
ownJson.forEach(({ url: u, body }, i) => {
  const top = Array.isArray(body) ? `array[${body.length}] of ${body[0] && typeof body[0] === 'object' ? Object.keys(body[0]).slice(0, 12).join(',') : typeof body[0]}` : Object.keys(body).slice(0, 15).join(',');
  console.log(`  [${i}] ${u.slice(0, 120)}\n       keys: ${top}\n       ${JSON.stringify(body).slice(0, 300)}`);
  fs.writeFileSync(path.join(out, `json-${i}.json`), JSON.stringify({ url: u, body }, null, 1));
});
fs.writeFileSync(path.join(out, 'page.html'), r.html);
fs.writeFileSync(path.join(out, 'page.txt'), r.text);
console.log(`\nEverything saved in ${out}`);
await closeBrowser();
