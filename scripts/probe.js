// Diagnose one page: what JSON it loads, what lots we extract, and whether we look blocked.
// Usage: npm run probe -- <url> [pickles|manheim]
// Writes everything to data/probe/ so it can be sent to the developer if a site changes.
import fs from 'node:fs';
import path from 'node:path';
import { withPage, closeBrowser, looksBlocked } from '../src/browser.js';
import { lotsFromJson, jsonBlobsFromHtml, factsFromText } from '../src/extract.js';
import { domCards } from '../src/sites/common.js';
import { config } from '../src/config.js';

const url = process.argv[2];
const site = process.argv[3] || (/manheim/.test(url || '') ? 'manheim' : 'pickles');
if (!url) { console.log('Usage: npm run probe -- <url> [pickles|manheim]'); process.exit(1); }

const out = path.join(config.dataDir, 'probe', `${site}-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const t0 = Date.now();
const r = await withPage(site, url, async page => {
  await page.screenshot({ path: path.join(out, 'page.png') }).catch(() => {});
  return domCards(page, /\/(used\/details|lot|item|vehicle|asset|detail|stock|listing)[^?#]*\d{5,}/);
}, { scrolls: 3 });

console.log(`\nHTTP ${r.status} · ${Math.round((Date.now() - t0) / 1000)}s · final URL ${r.finalUrl}`);
console.log(looksBlocked(r) ? '!! LOOKS BLOCKED - try PROXY_URL with an Australian proxy' : 'Not blocked.');
console.log(`\nJSON responses captured: ${r.json.length}`);
r.json.forEach(({ url: u, body }, i) => {
  const lots = lotsFromJson(body);
  console.log(`  [${i}] ${u.slice(0, 140)}  -> ${lots.length} lot-shaped objects`);
  fs.writeFileSync(path.join(out, `json-${i}.json`), JSON.stringify({ url: u, body }, null, 1));
});
const blobs = jsonBlobsFromHtml(r.html);
console.log(`Embedded JSON blobs in HTML: ${blobs.length}`);
blobs.forEach((b, i) => fs.writeFileSync(path.join(out, `blob-${i}.json`), JSON.stringify(b, null, 1)));
fs.writeFileSync(path.join(out, 'page.html'), r.html);
fs.writeFileSync(path.join(out, 'page.txt'), r.text);

const lots = [...r.json.flatMap(j => lotsFromJson(j.body)), ...blobs.flatMap(b => lotsFromJson(b))];
console.log(`\nLots extracted from JSON: ${lots.length}`);
for (const l of lots.slice(0, 8)) console.log('  ', JSON.stringify(l));
console.log(`\nLot links found in page: ${(r.result || []).length}`);
for (const c of (r.result || []).slice(0, 5)) console.log('  ', c.href, '|', c.text.replace(/\s+/g, ' ').slice(0, 120));
console.log('\nFacts read from visible text:', JSON.stringify(factsFromText(r.text)));
console.log(`\nEverything saved in ${out}`);
await closeBrowser();
