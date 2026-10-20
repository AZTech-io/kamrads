// End-to-end: real headless Chromium against fake Pickles / Manheim pages served by request
// interception. Proves the browser, JSON capture, DOM fallback, merge and DB pipeline work.
// Skips automatically if no Chromium is available.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kamrads-e2e-'));
process.env.PICKLES_SEARCHES = 'https://www.pickles.com.au/used/search/trucks?contentkey=trucks';
process.env.PICKLES_MAX_PAGES = '1';
process.env.MANHEIM_SCROLLS = '1';
process.env.PAGE_TIMEOUT_MS = '15000';
if (!process.env.CHROME_PATH && fs.existsSync('/opt/google/chrome/chrome')) process.env.CHROME_PATH = '/opt/google/chrome/chrome';

const { getContext, closeBrowser } = await import('../src/browser.js');
const pickles = await import('../src/sites/pickles.js');
const manheim = await import('../src/sites/manheim.js');

const soon = new Date(Date.now() + 9 * 60000).toISOString();
const html = (body, script = '') => `<!doctype html><html><body>${body}<script>${script}</script></body></html>`;

const PICKLES = {
  '/used/search/trucks': html('<div id="results">Loading…</div>', `
    fetch('/api-website/search/products?page=1').then(r => r.json()).then(d => {
      document.getElementById('results').innerHTML = d.products.map(p =>
        '<div class="card"><a href="' + p.url + '"><h3>' + p.title + '</h3></a><p>Altona North, VIC</p><p>' + p.odometer + ' km</p></div>').join('')
        + '<div class="card"><a href="/used/details/cars/2014-mazda-3/62442387"><h3>2014 Mazda 3 Maxx</h3></a><p>Tullamarine, VIC</p><p>82,915 km</p><p>Statutory Write-Off</p><p>Current bid $650</p></div>';
    });`),
  '/api-website/search/products': JSON.stringify({ totalCount: 1, products: [{
    stockNumber: 62430579, title: '2011 Isuzu NPR 400 Medium', url: '/used/details/trucks/2011-isuzu-npr-400-medium/62430579',
    odometer: 288400, wovr: 'WOVR N/A', location: 'Altona North, VIC',
    auction: { currentBid: { amount: 2200 }, bidCount: 4, bidEndDate: soon, buyMethod: 'Pickles Online' } }] }),
  '/used/details/trucks/2011-isuzu-npr-400-medium/62430579': html('<h1>2011 Isuzu NPR 400 Medium</h1><div id="bid"></div>', `
    setTimeout(() => { document.getElementById('bid').innerText = 'Current Bid\\n$2,450\\n5 bids\\nEnds in 00:08:30'; }, 400);`),
};
const MANHEIM = {
  '/': html('<ul><li><a href="/events/statutory-write-off">Statutory Write off Vehicles</a> | (173) lots</li><li><a href="/events/classic-mercedes">Classic Mercedes Benz Auction</a> | (3) lots</li></ul>'),
  '/events/statutory-write-off': html('<div id="lots"></div>', `
    document.getElementById('lots').innerHTML = '<div class="lot"><a href="/damaged/vehicle-details/4471923"><h4>2019 Toyota Hilux SR</h4></a><span>143,200 km</span><span>Repairable Write-Off</span><span>Minto, NSW</span><span>Current bid $1,100</span></div>';`),
};

async function fakeSite(site, origin, pages) {
  const ctx = await getContext(site);
  await ctx.route(origin + '/**', route => {
    const u = new URL(route.request().url());
    const body = pages[u.pathname];
    if (body == null) return route.fulfill({ status: 404, body: 'nope' });
    route.fulfill({ status: 200, contentType: body.startsWith('{') ? 'application/json' : 'text/html', body });
  });
}

let chromeOk = true;
try { await getContext('probe'); } catch (e) { chromeOk = false; console.log('# no Chromium here, skipping e2e:', e.message.split('\n')[0]); }

test('Pickles: discovery merges JSON + DOM, refresh reads the live bid', { skip: !chromeOk }, async () => {
  await fakeSite('pickles', 'https://www.pickles.com.au', PICKLES);
  const lots = await pickles.discover();
  const isuzu = lots.find(l => l.ext_id === '62430579');
  const mazda = lots.find(l => l.ext_id === '62442387');
  assert.ok(isuzu, 'Isuzu found');
  assert.equal(isuzu.bid, 2200);
  assert.equal(isuzu.odometer, 288400);
  assert.equal(isuzu.category, 'trucks');
  assert.ok(Math.abs(isuzu.end_at - Date.parse(soon)) < 1000);
  assert.ok(mazda, 'DOM-only card found');
  assert.equal(mazda.bid, 650);
  assert.equal(mazda.wovr, 'Statutory Write-Off');
  assert.equal(mazda.url, 'https://www.pickles.com.au/used/details/cars/2014-mazda-3/62442387');

  const fresh = await pickles.refresh(isuzu);
  assert.equal(fresh.bid, 2450);
  assert.equal(fresh.bid_count, 5);
  assert.ok(Math.abs(fresh.end_at - (Date.now() + 510000)) < 15000);
});

test('Manheim: finds matching events and their lots', { skip: !chromeOk }, async () => {
  await fakeSite('manheim', 'https://www.manheim.com.au', MANHEIM);
  const lots = await manheim.discover();
  assert.equal(lots.length, 1);
  const [hilux] = lots;
  assert.equal(hilux.ext_id, '4471923');
  assert.equal(hilux.title, '2019 Toyota Hilux SR');
  assert.equal(hilux.bid, 1100);
  assert.equal(hilux.wovr, 'Repairable Write-Off');
  assert.equal(hilux.sale_name, 'Statutory Write off Vehicles');
});

test.after(() => closeBrowser());
