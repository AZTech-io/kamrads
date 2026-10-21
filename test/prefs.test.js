// View settings follow the login; rough values from sold vehicles of the same type.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kamrads-prefs-'));
process.env.DASH_USER = 'aaron'; process.env.DASH_PASS = 'a'; process.env.DASH_USERS = 'matthew:m';
process.env.GEOCODE = 'false'; process.env.PORT = '18791'; process.env.HOST = '127.0.0.1';

const { startServer } = await import('../src/server.js');
const { upsertLot, q, db } = await import('../src/db.js');
const history = await import('../src/history.js');
const { estimateOf, estimateSource } = await import('../src/alerts.js');
startServer();
await new Promise(r => setTimeout(r, 300));
const base = 'http://127.0.0.1:18791';
test.after(() => setTimeout(() => process.exit(0), 50));   // the web server would keep the file running
const H = u => ({ authorization: 'Basic ' + Buffer.from(u).toString('base64'), 'content-type': 'application/json' });

test('view settings are kept with the login and come back in the page', async () => {
  const save = (u, body) => fetch(base + '/api/prefs', { method: 'POST', headers: H(u), body: JSON.stringify(body) });
  assert.equal((await save('aaron:a', { key: 'k2_view', value: 'deals' })).status, 200);
  assert.equal((await save('aaron:a', { all: { kf_heat: ['ultra', 'hot'], kf_plan: { a: 'Canberra', b: 'Sydney', d: 40 } } })).status, 200);
  assert.equal((await save('aaron:a', { key: 'evil', value: 1 })).status, 400);
  assert.equal((await save('aaron:a', { key: 'k2_more', value: 'x'.repeat(5000) })).status, 400);
  const page = await (await fetch(base + '/', { headers: H('aaron:a') })).text();
  const prefs = JSON.parse(/window\.__PREFS=(\{.*?\});<\/script>/.exec(page)[1]);
  assert.equal(prefs.k2_view, 'deals'); assert.deepEqual(prefs.kf_heat, ['ultra', 'hot']);
  const fr = await (await fetch(base + '/freight', { headers: H('aaron:a') })).text();
  assert.match(fr, /"kf_plan":\{"a":"Canberra"/);
  const mm = await (await fetch(base + '/', { headers: H('matthew:m') })).text();
  assert.match(mm, /window\.__PREFS=\{\};/, "Matthew's are his own");
  await save('aaron:a', { key: 'k2_view', value: null });
  assert.doesNotMatch(await (await fetch(base + '/', { headers: H('aaron:a') })).text(), /k2_view/);
  assert.match(await (await fetch(base + '/bought', { headers: H('aaron:a') })).text(), /window\.__PREFS=/);
});

test('rough value: not enough Caddys sold, so similar vans of the same age and km', () => {
  const now = Date.now();
  const sold = (id, title, price, km) => upsertLot({ site: 'manheim', ext_id: id, title, category: 'vans', odometer: km, bid: price, url: 'https://x/' + id, end_at: now - 3600000 });
  const vans = [['V1', '2009 Volkswagen Caddy Van', 5200, 300000], ['V2', '2011 Volkswagen Transporter Van', 9000, 350000], ['V3', '2010 Volkswagen Transporter Van', 7800, 310000],
    ['V4', '2012 Volkswagen Crafter Van', 8500, 280000], ['V5', '2010 Volkswagen Crafter Van', 7600, 330000], ['V6', '2009 Volkswagen Transporter Van', 6900, 360000],
    ['V7', '2011 Toyota HiAce Van', 15000, 300000], ['V8', '2010 Peugeot Partner Van', 1500, 260000]];
  for (const v of vans) sold(...v);
  // as if read right at the close
  db.exec(`UPDATE lots SET status = 'closed', final_bid = bid, final_seen_at = end_at WHERE site = 'manheim' AND ext_id LIKE 'V%'`);
  history.rebuild();
  upsertLot({ site: 'grays', ext_id: '0022-23502706', title: '2010 Volkswagen Caddy Petrol', category: 'commercial vehicles van', odometer: 332204, bid: 3000, end_at: now + 3600000,
    url: 'https://www.grays.com/lot/0022-23502706/commercial-vehicles/2010-volkswagen-caddy-petrol' });
  const caddy = q.lot.get('grays:0022-23502706');
  const sl = history.soldLike(caddy, { minN: 3 }); assert.equal(sl, null, 'only one Caddy sold: ' + JSON.stringify(sl && { label: sl.label, ex: sl.examples.map(e => e.title) }));
  const t = history.typeLike(caddy);
  assert.ok(t && t.rough && t.n >= 5, JSON.stringify(t));
  assert.ok(t.examples.every(e => /Volkswagen/.test(e.title)), 'same make only');
  assert.ok(t.median >= 4500 && t.median <= 8000, `${t.median}`);
  assert.match(t.label, /^rough: \d+ Volkswagen vans 2007–2013/);
  assert.equal(estimateSource(caddy), 'type'); assert.equal(estimateOf(caddy), t.median);
  // a car with no year gets nothing rather than a guess
  assert.equal(history.typeLike({ ...caddy, key: 'x:1', title: 'Volkswagen Caddy', year: null }), null);
});

test('rough values never mix salvage sales with retail; Grays "Going, going, gone" countdown read', async () => {
  const { marketOf } = history;
  assert.equal(marketOf({ site: 'pickles', title: '2015 Ford Kuga Ambiente', market: 'salvage' }), 'salvage', 'found through a salvage search');
  assert.equal(marketOf({ site: 'pickles', title: '2015 Ford Kuga Ambiente' }), 'retail', 'Pickles all-cars search');
  assert.equal(marketOf({ site: 'grays', title: '2015 Ford Kuga Ambiente Petrol', sale_name: 'WA Motor Vehicle Auction' }), 'retail');
  assert.equal(marketOf({ site: 'grays', title: '2012 Ford Territory TX Diesel (WOVR Inspected)' }), 'salvage');
  assert.equal(marketOf({ site: 'lloyds', title: '2014 Hyundai i30', wovr: 'WOVR N/A' }), 'retail');
  const now = Date.now();
  // nine salvage SUVs sold cheap at Pickles: a clean Grays Kuga gets no rough value from them
  for (let i = 0; i < 9; i++) upsertLot({ site: 'pickles', ext_id: `S${i}`, title: `201${4 + (i % 3)} Ford Escape`, category: 'cars', market: 'salvage', odometer: 120000, bid: 2000 + i * 50, url: `https://x/s${i}`, end_at: now - 3600000 });
  db.exec(`UPDATE lots SET status = 'closed', final_bid = bid, final_seen_at = end_at WHERE site = 'pickles' AND ext_id LIKE 'S%'`);
  history.rebuild();
  upsertLot({ site: 'grays', ext_id: '0036-1', title: '2015 Ford Kuga Ambiente Petrol', category: 'cars', odometer: 110000, bid: 4400, end_at: now + 3600000, url: 'https://www.grays.com/lot/0036-1/x' });
  assert.equal(history.typeLike(q.lot.get('grays:0036-1')), null, 'salvage prices are not a value for a clean car');
  const { factsFromText } = await import('../src/extract.js');
  const f = factsFromText('Going, going, gone: 4m 9s Current Bid (141 bids) $17,600', now);
  assert.ok(Math.abs(f.end_at - (now + 249000)) < 2000);
});

test('a Grays car is a car (not a motorbike), and a Grays price only counts if read after the close', async () => {
  const { sectorOf } = await import('../src/categories.js');
  assert.equal(sectorOf({ title: '2015 Ford Kuga Ambiente Petrol', url: 'https://www.grays.com/lot/0036-23502706/motor-vehicles-motor-cycles/2015-ford-kuga' }), 'cars');
  assert.equal(sectorOf({ title: '2019 Kawasaki Ninja 400', url: 'https://www.grays.com/lot/1-2/motor-vehicles-motor-cycles/2019-kawasaki-ninja' }), 'bikes');
  const now = Date.now();
  upsertLot({ site: 'grays', ext_id: '9-1', title: '2016 Ford Focus Trend Petrol', category: 'cars', bid: 1109, end_at: now - 7200000, url: 'https://www.grays.com/lot/9-1/x' });
  upsertLot({ site: 'grays', ext_id: '9-2', title: '2016 Ford Focus Trend Petrol', category: 'cars', bid: 9800, end_at: now - 7200000, url: 'https://www.grays.com/lot/9-2/x' });
  db.prepare(`UPDATE lots SET status = 'closed', final_bid = bid, final_seen_at = end_at - 600000 WHERE key = 'grays:9-1'`).run();   // seen 10 min before: soft close may have run on
  db.prepare(`UPDATE lots SET status = 'closed', final_bid = bid, final_seen_at = end_at + 60000 WHERE key = 'grays:9-2'`).run();    // read after the close
  const keys = q.historyRows.all(now - 864e5).map(r => r.key);
  assert.ok(keys.includes('grays:9-2')); assert.ok(!keys.includes('grays:9-1'));
});

test('odometer: Grays "Indicated Odometer Reading" (no unit), "Kms:", "85,000 km"', async () => {
  const { factsFromText } = await import('../src/extract.js');
  assert.equal(factsFromText('Indicated Odometer Reading: 332204 Registration Expiry').odometer, 332204);
  assert.equal(factsFromText('Kms: 120,500').odometer, 120500);
  assert.equal(factsFromText('2015 Hilux SR 98,000 km').odometer, 98000);
  assert.equal(factsFromText('Odometer reading 0').odometer, undefined);
});

test('titles: a photo caption ("- Image 1") is not part of the title', async () => {
  const { tidyTitle } = await import('../src/vehicle.js');
  assert.equal(tidyTitle('2023 Isuzu D-MAX 4x4 X-RIDER Dual Cab T/Diesel (Auto) - Image 1'), '2023 Isuzu D-MAX 4x4 X-RIDER Dual Cab T/Diesel (Auto)');
  upsertLot({ site: 'slattery', ext_id: '140852', title: '2023 Isuzu D-MAX X-RIDER - Image 1', url: 'https://slatteryauctions.com.au/assets/140852' });
  assert.equal(q.lot.get('slattery:140852').title, '2023 Isuzu D-MAX X-RIDER');
});
