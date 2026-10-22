// Dreams: pasted Trucksales / Carsales / Pickles pages -> listings; every D-Max and Isuzu curtainsider at
// auction matched, valued against the market and real results, with a max bid; pushes when one's a deal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kamrads-dreams-'));
process.env.DASH_USER = 'aaron'; process.env.DASH_PASS = 'a'; process.env.DASH_USERS = 'matthew:m';
process.env.PORT = '18791'; process.env.HOST = '127.0.0.1';
process.env.HOME_BASES = 'Canberra ACT:-35.281,149.129';

const { parsePaste, detectSource, whenFrom } = await import('../src/dreams/parse.js');
const { features, damageOf } = await import('../src/dreams/model.js');
const { fitRates, valueFrom, verdictOf } = await import('../src/dreams/value.js');
const { upsertLot, q, db } = await import('../src/db.js');
const dreams = await import('../src/dreams/index.js');
const settings = await import('../src/settings.js');
const { factsFromText, lotFromObject } = await import('../src/extract.js');

const seed = f => fs.readFileSync(new URL(`../seed/dreams/${f}`, import.meta.url), 'utf8');

test('parse: Trucksales results copied as plain text', () => {
  const r = parsePaste(seed('trucksales-isuzu-curtainsider-p1.txt'));
  assert.equal(r.source, 'trucksales');
  assert.equal(r.listings.length, 20, 'the repeated featured ads only count once');
  const first = r.listings[0];
  assert.deepEqual([first.title, first.year, first.price, first.km, first.body, first.seller, first.state, first.trans],
    ['1998 Isuzu Fvr 950', 1998, 17000, 705000, 'Curtainsider', 'private', 'NSW', 'Manual']);
  const nqr = r.listings.find(l => /Nqr 450/.test(l.title));
  assert.equal(nqr.gvm, 8700); assert.equal(nqr.seller, 'dealer'); assert.equal(nqr.condition, 'used');
  assert.equal(nqr.features.code, 'nqr'); assert.equal(nqr.features.cls, 'n75'); assert.equal(nqr.features.curtain, true);
});

test('parse: Trucksales markdown with links, "Enquire for price" and new trucks', () => {
  const r = parsePaste(seed('trucksales-isuzu-curtainsider-p7.txt'));
  assert.equal(r.listings.length, 8);
  const frr = r.listings.find(l => /2015 Isuzu FRR 500/.test(l.title));
  assert.equal(frr.priceNote, 'poa'); assert.equal(frr.price, null); assert.equal(frr.km, 340448);
  assert.equal(frr.url, 'https://www.trucksales.com.au/items/details/2015-isuzu-frr-500/OAG-AD-26035773/');
  assert.equal(frr.extId, 'OAG-AD-26035773');
  const fvl = r.listings.find(l => /FVL 260-300 Freightpack AT/.test(l.title));
  assert.equal(fvl.gvm, 26000); assert.equal(fvl.condition, 'new'); assert.equal(fvl.features.cls, 'f16');
});

test('parse: Pickles search page -> auction lots with body type, stock number and live-lane start time', () => {
  const now = Date.parse('2026-10-22T12:50:00Z');
  const r = parsePaste(seed('pickles-isuzu-p1.txt'), { now, tz: 'Australia/Perth' });
  assert.equal(r.source, 'pickles');
  const dmax = r.listings.filter(l => l.features.dmax);
  assert.ok(dmax.length >= 30);
  const one = r.listings.find(l => l.stock === '62444048');
  assert.equal(one.title, '2023 Isuzu D-MAX RG MY23 SX High Ride Cab Chassis Crew Cab 4dr Spts Auto 6sp 4x2 1175kg 3.0DT');
  assert.equal(one.km, 119470); assert.equal(one.state, 'VIC'); assert.equal(one.buyMethod, 'Pickles Live');
  assert.equal(one.url, 'https://www.pickles.com.au/used/details/cars/2023-isuzu-d-max/62444048');
  assert.equal(new Date(one.startsAt).toISOString(), '2026-10-28T23:00:00.000Z', '7:00 am Perth time');
  assert.deepEqual([one.features.drive, one.features.cab, one.features.gen, one.features.body], ['4x2', 'crew', 'RG', 'cab chassis']);
  const rel = r.listings.find(l => l.stock === '62429526');
  assert.equal(rel.startsAt, now + (10 * 60 + 8) * 60000, '"Starts in 10H 8M"'); assert.equal(rel.lotNo, '10');
  const curtain = r.listings.filter(l => l.features.curtain).map(l => l.stock);
  assert.ok(curtain.includes('62406517'));
  const fvl = r.listings.find(l => l.stock === '62406517');
  assert.equal(fvl.body, 'Curtainsider'); assert.equal(fvl.url, 'https://www.pickles.com.au/used/details/trucks/2021-isuzu-fvl-240-300/62406517');
  const buy = r.listings.find(l => l.stock === '62419721');
  assert.equal(buy.buyNow, 38990); assert.equal(buy.buyMethod, 'Buy Now');
  assert.ok(!r.listings.some(l => /generator/i.test(l.title)), 'non-vehicle cards need a year + make title');
});

test('parse: Carsales results - spec line under the title, excl-govt price, demo cars; footers mention the other site', () => {
  const r = parsePaste(seed('carsales-dmax-xterrain-blade-2023-p1.txt'));
  assert.equal(r.source, 'carsales');
  assert.equal(r.listings.length, 22);
  const [a, b] = r.listings;
  assert.deepEqual([a.title, a.price, a.km, a.seller, a.state, a.body], ['2023 Isuzu D-MAX X-TERRAIN Auto 4x4 MY23', 48990, 117445, 'dealer', 'SA', 'Ute']);
  assert.deepEqual([b.price, b.driveAway], [45053, 46999], '"Drive away $45,053 Excl. Est. Govt. Charges" -> the excl-govt figure');
  assert.deepEqual([a.features.trim, a.features.drive, a.features.dmax], ['x-terrain', '4x4', true]);
  const demo = parsePaste(seed('carsales-dmax-xterrain-blade-2023-p6.txt')).listings.find(l => l.condition === 'demo');
  assert.ok(demo && demo.seller === 'dealer');
  assert.ok(parsePaste(seed('carsales-dmax-xterrain-blade-2023-p5.txt')).listings.some(l => l.features.trim === 'blade'));
  assert.equal(detectSource(seed('trucksales-isuzu-curtainsider-p1.txt')), 'trucksales');
});

test('parse: an auction result page (Grays): sold or referred, km, drive and cab, place from the postcode, what the listing says is wrong', () => {
  const sold = parsePaste(seed('grays-result-2019-dmax-lsm-jandakot.txt'));
  assert.equal(sold.source, 'result');
  const [l] = sold.listings;
  assert.deepEqual([l.site, l.extId, l.title, l.price, l.sold, l.km, l.location, l.state, l.bidCount, l.reserve],
    ['grays', '0040-23502706', '2019 Isuzu D-MAX LS-M Diesel', 17600, true, 81884, 'Jandakot, WA', 'WA', 141, 'met']);
  assert.equal(new Date(l.closedAt).toISOString(), '2026-10-21T11:30:00.000Z', '22:30 AEDT');
  assert.equal(l.url, 'https://www.grays.com/lot/0040-23502706/commercial-vehicles/2019-isuzu-d-max-ls-m-diesel');
  assert.deepEqual([l.features.trim, l.features.drive, l.features.cab], ['ls-m', '4x4', 'crew']);
  assert.equal(l.condition, 'engine runs rough, DPF warning, warning light on');
  const ute = parsePaste(seed('grays-result-2020-dmax-sx-dandenong.txt')).listings[0];
  assert.deepEqual([ute.price, ute.location, ute.spec, ute.condition, ute.reserve], [13900, 'Dandenong South, VIC', '4x2 space cab', null, 'none'], 'scratches and torn seats are not problems');
  const ref = parsePaste(seed('grays-result-2014-dmax-sx-pinkenba.txt')).listings[0];
  assert.deepEqual([ref.sold, ref.passed, ref.price, ref.reserve, ref.state, ref.spec], [false, true, 6000, 'not met', 'QLD', '4x4 crew cab']);
  assert.equal(ref.condition, 'transmission needs attention, major rust');
  assert.deepEqual(damageOf({ title: ref.title, condition: ref.condition }).kinds, ['mechanical', 'rust']);
});

test('extract: postcode -> state, "Referred" is passed in, drive type and condition read off lot pages', async () => {
  const { placeFromAddress, stateFromPostcode } = await import('../src/extract.js');
  assert.deepEqual(placeFromAddress('140-152 National Drive, Dandenong South, 3175'), { location: 'Dandenong South, VIC', state: 'VIC' });
  assert.deepEqual([stateFromPostcode('2609'), stateFromPostcode('2620'), stateFromPostcode('0870'), stateFromPostcode('6164')], ['ACT', 'NSW', 'NT', 'WA']);
  const f = factsFromText('Drive Type: Four Wheel Drive\nEngine Turns Over: No\nSpare Key: No\nKey: Yes\nThe auction has ended.\nReferred\nBids (53 bids)');
  assert.deepEqual([f.spec, f.condition, f.reserve, f.closed], ['4x4', 'no start', 'not met', true]);
  assert.equal(factsFromText('Key: No\nScratches And Dents Visible Around Vehicle, Seat Torn').condition, 'no keys');
});

test('parse: CSV and source detection', () => {
  const r = parsePaste('title,price,km,state,seller\n"2021 Isuzu D-Max SX 4x4 Crew Cab","$39,990",85000,NSW,Dealer\n2019 Isuzu D-Max LS-U 4x4,31500,140000,QLD,private\n');
  assert.equal(r.source, 'csv');
  assert.deepEqual(r.listings.map(l => [l.year, l.price, l.km, l.state, l.seller]), [[2021, 39990, 85000, 'NSW', 'dealer'], [2019, 31500, 140000, 'QLD', 'private']]);
  assert.equal(detectSource('2021 Isuzu D-MAX\n$39,990\nExcl. Govt. Charges\n'), 'carsales');
  assert.equal(whenFrom('Ends in 2D 3H', { now: 0 }), (2 * 24 + 3) * 3600000);
});

test('features: Isuzu truck classes, D-Max spec, MU-X is not a D-Max', () => {
  assert.equal(features('2015 Isuzu NLR 45-150 2 Pallet Tautliner and Lift').cls, 'n45');
  assert.equal(features('2015 Isuzu NLR 45-150 2 Pallet Tautliner and Lift').curtain, true);
  assert.equal(features('2026 Isuzu F Series FRR 110-240 AM D50 Freightpack').code, 'frr');
  assert.equal(features('2019 Isuzu FYJ 300-350 Table Top Day Cab').cls, 'f6x4');
  assert.equal(features('2005 Isuzu F Series 22,500 kg').cls, 'f6x4', 'no model code: class from GVM');
  assert.equal(features('2017 Isuzu FSD 140-260 Pantech Day Cab').body, 'pantech');
  const d = features('2022 Isuzu D-MAX RG MY22 SX Cab Chassis Space Cab 4dr Spts Auto 6sp 4x4 1240kg 3.0DT');
  assert.deepEqual([d.dmax, d.drive, d.cab, d.engine, d.truck], [true, '4x4', 'space', '3.0', false]);
  assert.equal(features('2023 Isuzu MU-X LS-T 4x2').dmax, false);
  assert.equal(features('2022 Isuzu D-MAX RG MY22 LS-U+ Utility Crew Cab').trim, 'ls-u+');
  assert.equal(features('2025 Isuzu D-MAX BLADE Auto 4x4 MY25.5').trim, 'blade');
});

test('valuation: a D-Max is valued against its own trim; another trim is re-priced and marked rough', () => {
  const xt = [40000, 60000, 80000].map((km, i) => ({ key: `x${i}`, title: '2024 Isuzu D-MAX X-TERRAIN Auto 4x4', year: 2024, km, price: 58000 - i * 2000, f: features('2024 Isuzu D-MAX X-TERRAIN Auto 4x4 Ute') }));
  const sx = [40000, 60000, 80000].map((km, i) => ({ key: `s${i}`, title: '2024 Isuzu D-MAX SX Crew Cab Chassis 4x4', year: 2024, km, price: 46000 - i * 2000, f: features('2024 Isuzu D-MAX SX Crew Cab Chassis 4x4') }));
  const rates = { year: 0.08, km: 0.11 };
  const item = { year: 2024, km: 60000, f: features('2024 Isuzu D-MAX RG MY24 X-TERRAIN Utility Crew Cab 4x4') };
  const both = valueFrom(item, [...xt, ...sx], { kind: 'dmax', rates, k: 3 });
  assert.ok(both.comps.every(c => c.key.startsWith('x')), 'same trim first');
  assert.ok(Math.abs(both.value - 56000) < 1500, String(both.value));
  const onlySx = valueFrom(item, sx, { kind: 'dmax', rates, k: 3 });
  assert.equal(onlySx.confidence, 'rough'); assert.equal(onlySx.otherTrim, 3);
  assert.ok(onlySx.value > 52000 && onlySx.value < 60000, `SX re-priced up to X-Terrain: ${onlySx.value}`);
});

test('damage: write-off class, kinds, stigma and avoid', () => {
  assert.equal(damageOf({ wovr: 'Statutory Write-Off' }).avoid, true);
  const rep = damageOf({ wovr: 'Repairable Write-Off', title: '2021 Isuzu D-Max hail damaged' }, { stigma: 0.22 });
  assert.deepEqual([rep.level, rep.kinds, rep.allowancePct, rep.stigmaPct], ['repairable', ['hail'], 0.08, 0.22]);
  assert.equal(damageOf({ title: '2020 Isuzu NPR flood damaged' }).avoid, true);
  assert.equal(damageOf({ title: '2020 Isuzu NPR 75-190', wovr: 'WOVR N/A' }).level, 'clean');
});

test('valuation: depreciation learned from listings, comparables re-priced to this year and km', () => {
  const pool = [];
  for (let y = 2010; y <= 2022; y += 2) for (const km of [100000, 300000, 500000]) {
    const price = Math.round(100000 * Math.exp(0.08 * (y - 2022)) * Math.exp(-0.1 * km / 100000));
    pool.push({ key: `${y}-${km}`, title: `${y} Isuzu FRR 500`, year: y, km, price, f: features(`${y} Isuzu FRR 500 curtainsider`) });
  }
  const rates = fitRates(pool, 'curtainsider');
  assert.equal(rates.fitted, true);
  assert.ok(Math.abs(rates.year - 0.077) < 0.01, `year rate ${rates.year}`);
  assert.ok(Math.abs(rates.km - 0.09) < 0.015, `km rate ${rates.km}`);
  const v = valueFrom({ year: 2016, km: 200000, f: features('2016 Isuzu FRR 500') }, pool, { kind: 'curtainsider', rates });
  const truth = 100000 * Math.exp(0.08 * -6) * Math.exp(-0.1 * 2);
  assert.ok(Math.abs(v.value - truth) / truth < 0.05, `${v.value} vs ${Math.round(truth)}`);
  assert.notEqual(v.confidence, 'rough');
  assert.equal(verdictOf(0.3, 0.25), 'diamond'); assert.equal(verdictOf(0.16, 0.25), 'good'); assert.equal(verdictOf(0.02, 0.25), 'market');
});

const H = u => ({ authorization: 'Basic ' + Buffer.from(u).toString('base64'), 'content-type': 'application/json' });
const api = async (m, p, body, who = 'aaron:a') => {
  const r = await fetch('http://127.0.0.1:18791' + p, { method: m, headers: H(who), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};

test('seed + API: two dreams, retail listings and Pickles lots in; every curtainsider valued with a max bid', async () => {
  const { startServer } = await import('../src/server.js');
  startServer();
  await new Promise(r => setTimeout(r, 300));
  dreams.seed();
  dreams.seed();   // runs once only
  await dreams.runDreams({ quiet: true });
  const list = (await api('GET', '/api/dreams')).json;
  assert.deepEqual(list.dreams.map(d => [d.kind, d.status]), [['dmax', 'hunting'], ['curtainsider', 'hunting']]);
  assert.ok(list.marketListings >= 120);
  const curtain = list.dreams.find(d => d.kind === 'curtainsider');
  const v = (await api('GET', `/api/dreams/${curtain.id}`)).json;
  // only Pickles lots that haven't sold yet are on the board (depends on today's date vs the paste)
  for (const l of v.lots) {
    assert.ok(l.item.isuzu && l.item.curtain, l.title);
    assert.ok(l.retail?.value > 0, `${l.title} valued`);
    assert.ok(l.maxBid >= 0);
    assert.ok(l.atExpected.total > l.atExpected.price, 'all-in includes fees and on-road costs');
  }
  assert.ok(v.market.length >= 100 && v.market.every(m => /isuzu/i.test(m.title)), 'non-Isuzu listings are left out');
  assert.equal(v.model.rates.fitted, true);
  const dmax = (await api('GET', `/api/dreams/${list.dreams[0].id}`)).json;
  assert.ok(dmax.model.retailN >= 150, 'Carsales X-Terrain / Blade pages seeded');
  const st = dmax.dream.settings;
  assert.deepEqual([st.trims, st.yearMin, st.kmMax, st.budget], [[], null, 100000, 20000], 'under 100k km, under $20k, any trim');
  assert.ok(dmax.lots.every(l => l.item.dmax && !l.item.mux));
  for (const l of dmax.lots) {
    if (l.km > 100000) assert.ok(!l.inCriteria && /over 100k km/.test(l.misses.join()), l.title);
    if (l.farOverBudget) assert.ok(l.retail.confidence !== 'rough' && l.atExpected.onRoadTotal > 30000, `${l.title}: left out of pushes only on a solid valuation`);
    if (l.maxBid) assert.ok(l.maxBid < 20000, 'max bid inside the $20k budget');
  }
  // the three Grays results pasted on 23 Oct: two sales on the Sold tab, the referred one apart and never a price
  assert.ok(dmax.sold.some(x => x.key === 'grays:0040-23502706' && x.price === 17600 && x.condition === 'engine runs rough, DPF warning, warning light on'));
  assert.ok(dmax.sold.some(x => x.key === 'grays:0051-23502676' && x.price === 13900 && x.damage.level === 'clean'));
  assert.ok(!dmax.sold.some(x => x.key === 'grays:0027-23502644'));
  assert.deepEqual(dmax.passed.map(x => [x.key, x.topBid]), [['grays:0027-23502644', 6000]]);
  assert.ok(!q.historyRows.all(0).some(r => r.key === 'grays:0027-23502644'), 'passed in: not a price for valuations');
  assert.ok(q.historyRows.all(0).some(r => r.key === 'grays:0040-23502706'));
});

test('import endpoint: a pasted Carsales page values the D-Maxes; re-pasting updates, not duplicates', async () => {
  const now = Date.now();
  upsertLot({ site: 'grays', ext_id: 'g1', url: 'https://www.grays.com/lot/g1', title: '2021 Isuzu D-Max SX Crew Cab Chassis 4x4 3.0DT Auto', year: 2021, odometer: 90000,
    bid: 18000, end_at: now + 6 * 60000, state: 'ACT', location: 'Fyshwick, ACT', category: 'motor-vehicles' });
  const page = ['carsales', '2021 Isuzu D-MAX SX Cab Chassis Crew Cab 4x4', '$42,990', 'Excl. Govt. Charges', '88,000 km', 'Dealer used • ACT',
    '2021 Isuzu D-MAX SX Cab Chassis Crew Cab 4x4', '$41,500', 'Excl. Govt. Charges', '102,000 km', 'Private Seller • NSW',
    '2022 Isuzu D-MAX SX Cab Chassis Crew Cab 4x4', '$46,990', 'Excl. Govt. Charges', '60,000 km', 'Dealer used • NSW',
    '2020 Isuzu D-MAX SX Cab Chassis Crew Cab 4x4', '$37,990', 'Excl. Govt. Charges', '120,000 km', 'Dealer used • QLD',
    '2021 Isuzu D-MAX LS-U Utility Crew Cab 4x4', '$47,990', 'Excl. Govt. Charges', '70,000 km', 'Dealer used • VIC'].join('\n');
  const r = await api('POST', '/api/dreams-import', { text: page, tz: 'Australia/Perth' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.source, r.json.found, r.json.added, r.json.dmax], ['carsales', 5, 5, 5]);
  const again = await api('POST', '/api/dreams-import', { text: page.replace('$42,990', '$40,990') });
  assert.deepEqual([again.json.added, again.json.updated], [0, 5]);
  assert.equal((await api('POST', '/api/dreams-import', { text: 'hello' })).status, 400);
  const id = (await api('GET', '/api/dreams')).json.dreams.find(d => d.kind === 'dmax').id;
  await api('PATCH', `/api/dreams/${id}`, { budget: '' });   // valuation without the $20k cap first
  const v = (await api('GET', `/api/dreams/${id}`)).json;
  assert.ok(v.model.retailN >= 155);
  const m = v.market.find(x => x.price === 40990);
  assert.equal(m.prevPrice, 42990, 'price drop kept');
  const g = v.lots.find(l => l.key === 'grays:g1');
  assert.ok(g.retail.value > 38000 && g.retail.value < 46000, `worth ${g.retail.value}`);
  assert.equal(g.verdictNow, 'diamond', '$18k bid on a ~$42k ute');
  assert.ok(g.maxBid > 18000 && g.maxBid < g.effective * 0.75);
  // budget caps the max bid
  await api('PATCH', `/api/dreams/${id}`, { budget: '25,000' });
  const capped = (await api('GET', `/api/dreams/${id}`)).json.lots.find(l => l.key === 'grays:g1');
  assert.ok(capped.maxBid < 25000 - 750 - capped.now.fees + 1, `max bid ${capped.maxBid} inside the $25k budget`);
  await api('PATCH', `/api/dreams/${id}`, { budget: '' });
  // your own repair estimate replaces the allowance
  await api('POST', `/api/dreams-note/${encodeURIComponent('grays:g1')}`, { repair: '2,500', note: 'needs tyres' });
  const noted = (await api('GET', `/api/dreams/${id}`)).json.lots.find(l => l.key === 'grays:g1');
  assert.deepEqual([noted.damage.repair, noted.damage.repairFrom, noted.damage.note], [2500, 'yours', 'needs tyres']);
  assert.equal((await api('PATCH', `/api/dreams/${id}`, { target: '150' })).status, 400);
});

test('alerts: new dream lot pushed once; final minutes push at a deal price; dream lots always re-read', async () => {
  const pushes = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('https://ntfy.example')) { const t = opts.headers.Title, m = /^=\?UTF-8\?B\?(.*)\?=$/.exec(t);
      pushes.push({ title: m ? Buffer.from(m[1], 'base64').toString() : t, body: opts.body }); return { ok: true, status: 200 }; }
    return realFetch(url, opts);
  };
  settings.set({ ntfyUrl: 'https://ntfy.example/kamrads-test' });
  try {
    const now = Date.now();
    upsertLot({ site: 'lloyds', ext_id: 'L77', url: 'https://www.lloydsonline.com.au/LotDetails.aspx?lid=L77', title: '2024 Isuzu D-MAX X-TERRAIN Utility Crew Cab 4x4 3.0DT',
      year: 2024, odometer: 50000, bid: 26000, end_at: now + 3 * 3600000, state: 'NSW', location: 'Penrith, NSW' });
    await dreams.runDreams();
    assert.equal(pushes.filter(p => /new .*D-Max/.test(p.title)).length, 1);
    await dreams.runDreams();
    assert.equal(pushes.filter(p => /new .*D-Max/.test(p.title)).length, 1, 'only once');
    assert.ok(dreams.isDreamKey('lloyds:L77'));
    // expensive lots on slow sites are normally skipped near the close - not dream lots
    const { dueForRefresh } = await import('../src/scheduler.js');
    upsertLot({ site: 'lloyds', ext_id: 'L77', bid: 30000, end_at: now + 12 * 60000 });
    db.prepare('UPDATE lots SET last_checked = ? WHERE key = ?').run(now - 10 * 60000, 'lloyds:L77');
    assert.ok(dueForRefresh(now).some(l => l.key === 'lloyds:L77'), 'dream lot over HOT_MAX_BID still re-read');
    // final minutes, fresh price, still a deal
    upsertLot({ site: 'lloyds', ext_id: 'L77', bid: 34000, end_at: now + 5 * 60000 }, { checked: true });
    await dreams.dreamFinalAlert(q.lot.get('lloyds:L77'), now);
    await dreams.dreamFinalAlert(q.lot.get('lloyds:L77'), now);
    const fin = pushes.filter(p => /DREAM/.test(p.title));
    assert.equal(fin.length, 1, JSON.stringify(pushes.map(p => p.title)));
    assert.match(fin[0].title, /min left · \$34,000/);
    assert.match(fin[0].body, /Bid up to \$/);
    // live lanes (most Pickles D-Maxes): one push a few hours before the lane starts, with the max bid
    upsertLot({ site: 'pickles', ext_id: '62999999', url: 'https://www.pickles.com.au/used/details/cars/2021-isuzu-d-max/62999999', title: '2023 Isuzu D-MAX RG MY23 X-TERRAIN Utility Crew Cab 4x4 3.0DT',
      year: 2023, odometer: 95000, buy_method: 'Pickles Live', opens_at: now + 2 * 3600000, end_at: now + 12 * 3600000, state: 'NSW', location: 'Gateshead, NSW' });
    await dreams.runDreams({ quiet: true });
    await dreams.dreamLiveAlerts(now);
    await dreams.dreamLiveAlerts(now);
    const live = pushes.filter(p => /live lanes soon/.test(p.title));
    assert.equal(live.length, 1);
    assert.match(live[0].body, /2023 Isuzu D-MAX.*bid up to \$[\d,]+/);
    // found it: alerts stop
    const id = (await api('GET', '/api/dreams')).json.dreams.find(d => d.kind === 'dmax').id;
    await api('PATCH', `/api/dreams/${id}`, { status: 'found', foundKey: 'lloyds:L77' });
    const v = (await api('GET', `/api/dreams/${id}`)).json;
    assert.equal(v.dream.status, 'found'); assert.equal(v.found.key, 'lloyds:L77');
  } finally { globalThis.fetch = realFetch; }
});

test('custom dream from search words; maybe-bodies; body type read from lot pages and JSON', async () => {
  const now = Date.now();
  upsertLot({ site: 'grays', ext_id: 'h1', url: 'https://www.grays.com/lot/h1', title: '2019 Toyota HiAce LWB Van', year: 2019, odometer: 150000, bid: 9000, end_at: now + 864e5 });
  const r = await api('POST', '/api/dreams', { kind: 'custom', name: 'HiAce', terms: 'toyota hiace -crash' });
  assert.equal(r.status, 200);
  const v = (await api('GET', `/api/dreams/${r.json.id}`)).json;
  assert.deepEqual(v.lots.map(l => l.key), ['grays:h1']);
  assert.equal((await api('POST', '/api/dreams', { kind: 'custom', terms: '  ' })).status, 400);
  assert.equal((await api('DELETE', `/api/dreams/${r.json.id}`)).status, 200);
  // an Isuzu truck with no body stated is a maybe; once its page says Pantech it drops off
  upsertLot({ site: 'pickles', ext_id: '61111111', url: 'https://www.pickles.com.au/used/details/trucks/2016-isuzu-frr-500/61111111', title: '2016 Isuzu FRR 500 Long', year: 2016, odometer: 300000, end_at: now + 864e5, category: 'trucks' });
  await dreams.runDreams({ quiet: true });
  const cid = (await api('GET', '/api/dreams')).json.dreams.find(d => d.kind === 'curtainsider').id;
  assert.ok((await api('GET', `/api/dreams/${cid}`)).json.maybes.some(l => l.key === 'pickles:61111111'));
  upsertLot({ site: 'pickles', ext_id: '61111111', ...factsFromText('Make Isuzu\nBody Type\nPantech\nOdometer 300,000 km') });
  await dreams.runDreams({ quiet: true });
  const after = (await api('GET', `/api/dreams/${cid}`)).json;
  assert.ok(!after.maybes.some(l => l.key === 'pickles:61111111') && !after.lots.some(l => l.key === 'pickles:61111111'));
  // the background read finds the body on the lot page: maybe -> board
  upsertLot({ site: 'pickles', ext_id: '61222222', url: 'https://www.pickles.com.au/used/details/trucks/2017-isuzu-frr-110-260/61222222', title: '2017 Isuzu FRR 110-260', year: 2017, odometer: 250000, end_at: now + 864e5, category: 'trucks' });
  await dreams.runDreams({ quiet: true });
  const read = [];
  assert.equal(await dreams.readMaybeBodies({ read: async l => { read.push(l.key); return { text: 'Make Isuzu\nBody Type: Curtainsider\nGVM 11,000 kg' }; } }), 1);
  assert.deepEqual(read, ['pickles:61222222'], 'the pantech is not read again; each maybe gets one try');
  assert.equal(await dreams.readMaybeBodies({ read: async () => { throw new Error('read twice'); } }), 0);
  const moved = (await api('GET', `/api/dreams/${cid}`)).json;
  assert.ok(moved.lots.some(l => l.key === 'pickles:61222222') && !moved.maybes.some(l => l.key === 'pickles:61222222'));
  assert.equal(lotFromObject({ stockNumber: 62406517, title: '2021 Isuzu FVL 240-300', bodyType: 'Curtainsider', odometer: 160906 }).body, 'Curtainsider');
});

test.after(() => setTimeout(() => process.exit(0), 50));

test('budget: a likely price over budget stays on the board (they go cheap); final-minutes push only while the all-in is inside it', async () => {
  const pushes = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('https://ntfy.example')) { pushes.push(opts.body); return { ok: true, status: 200 }; }
    return realFetch(url, opts);
  };
  try {
    const id = (await api('GET', '/api/dreams')).json.dreams.find(d => d.kind === 'dmax').id;
    await api('PATCH', `/api/dreams/${id}`, { status: 'hunting', budget: 20000, kmMax: 100000 });
    const now = Date.now();
    upsertLot({ site: 'lloyds', ext_id: 'B1', url: 'https://www.lloydsonline.com.au/LotDetails.aspx?lid=B1', title: '2023 Isuzu D-MAX X-TERRAIN Utility Crew Cab 4x4 3.0DT',
      year: 2023, odometer: 60000, bid: 12000, end_at: now + 5 * 60000, state: 'WA', location: 'Welshpool, WA' }, { checked: true });
    await dreams.runDreams({ quiet: true });
    let l = (await api('GET', `/api/dreams/${id}`)).json.lots.find(x => x.key === 'lloyds:B1');
    assert.ok(l.overBudget, 'likely ~$40k+ against a $20k budget');
    assert.ok(l.inCriteria && l.farOverBudget, 'more than 1.5x over on a solid valuation: still listed, left out of pushes');
    await api('PATCH', `/api/dreams/${id}`, { budget: 35000 });
    l = (await api('GET', `/api/dreams/${id}`)).json.lots.find(x => x.key === 'lloyds:B1');
    assert.ok(l.inCriteria && l.overBudget && !l.farOverBudget, 'within 1.5x: in, flagged');
    assert.ok(l.maxBid > 0 && l.maxBid < 35000);
    await dreams.dreamFinalAlert(q.lot.get('lloyds:B1'), now);
    assert.equal(pushes.length, 1, '$12k bid, inside the budget, well under worth');
    upsertLot({ site: 'lloyds', ext_id: 'B2', url: 'https://www.lloydsonline.com.au/LotDetails.aspx?lid=B2', title: '2023 Isuzu D-MAX X-TERRAIN Utility Crew Cab 4x4 3.0DT',
      year: 2023, odometer: 60000, bid: 33000, end_at: now + 5 * 60000, state: 'WA' }, { checked: true });
    await dreams.runDreams({ quiet: true });
    await dreams.dreamFinalAlert(q.lot.get('lloyds:B2'), now);
    const b2 = (await api('GET', `/api/dreams/${id}`)).json.lots.find(x => x.key === 'lloyds:B2');
    assert.ok(b2.now.onRoadTotal > 35000 && b2.verdictNow !== 'market', `on the road ${b2.now.onRoadTotal}, still under worth`);
    assert.equal(pushes.length, 1, 'all-in over the budget: no push even though it is under worth');
    await api('PATCH', `/api/dreams/${id}`, { budget: '' });
  } finally { globalThis.fetch = realFetch; }
});

test('spec update: the X-Terrain/Blade guess becomes under 100k km / $20k; settings someone changed are left alone', async () => {
  const { dq } = await import('../src/dreams/store.js');
  const t = Date.now();
  const guess = dq.add.get('Isuzu D-Max — Katara 3 upgrade', 'dmax', 'aaron', 'hunting', JSON.stringify({ ...dreams.defaults('dmax'), trims: ['x-terrain', 'blade'], yearMin: 2023 }), t, t).id;
  const mine = dq.add.get('Isuzu D-Max — Katara 3 upgrade', 'dmax', 'aaron', 'hunting', JSON.stringify({ ...dreams.defaults('dmax'), trims: ['x-terrain', 'blade'], yearMin: 2023, kmMax: 150000 }), t, t).id;
  dq.setMeta.run('dmax-spec-2', '');
  dreams.seed();
  const a = dreams.settingsOf(dq.one.get(guess)), b = dreams.settingsOf(dq.one.get(mine));
  assert.deepEqual([a.trims, a.yearMin, a.kmMax, a.budget], [[], null, 100000, 20000]);
  assert.deepEqual([b.trims, b.yearMin, b.kmMax, b.budget], [['x-terrain', 'blade'], 2023, 150000, null]);
  dreams.deleteDream(guess); dreams.deleteDream(mine);
});

test('the Jandakot LS-M (sold $17,600): on a rough value it is still pushed, and at $17,600 it is inside a $20k on-road budget', async () => {
  const { dq } = await import('../src/dreams/store.js');
  const { analyze } = await import('../src/dreams/value.js');
  const d = dreams.allDreams().find(x => x.kind === 'dmax');
  // (from Karnup, Jandakot is a pick-up: no transport. This test's only home base is Canberra, so leave transport out.)
  dreams.updateDream(d.id, { budget: 20000, kmMax: 100000, trims: [], yearMin: '', transport: false });
  const lot = q.lot.get('grays:0040-23502706');
  const live = { ...lot, status: 'open', bid: 17600, last_checked: lot.end_at - 600000 };
  const a = analyze(live, dreams.context(dq.one.get(d.id)));
  assert.ok(a.inCriteria && !a.farOverBudget, a.misses.join() || 'far over on a rough value');
  assert.ok(a.withinBudgetNow, `on the road ${a.now.onRoadTotal}`);
  assert.ok(a.maxBid >= 17000 && a.maxBid < 20000, `bid up to ${a.maxBid}`);
  assert.ok(a.damage.repair > 0 && /mechanical/.test(a.damage.label), 'DPF / rough idle: repair allowance in the deal maths');
  dreams.updateDream(d.id, { transport: true });
});
