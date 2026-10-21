// True cost, distance, own-history prices, rival bids, listing check, morning digest.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kamrads-feat-'));
process.env.DASH_USER = 'aaron';
process.env.DASH_PASS = 'a';
process.env.DASH_USERS = 'matthew:m';
process.env.NTFY_URL = 'https://ntfy.test/shared';
process.env.GEOCODE = 'false';

const pushes = [], claude = [];
let claudeReply = null;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://ntfy.test/')) { pushes.push({ url: u, title: opts.headers?.Title, body: opts.body }); return new Response('ok'); }
  if (u.startsWith('https://api.anthropic.com/')) { const body = JSON.parse(opts.body); claude.push(body); return claudeReply(body); }
  throw new Error('unexpected fetch ' + u);
};
const dec = t => { const m = /^=\?UTF-8\?B\?(.+)\?=$/.exec(t || ''); return m ? Buffer.from(m[1], 'base64').toString() : t; };

const { upsertLot, q, db } = await import('../src/db.js');
const geo = await import('../src/geo.js');
const { allIn } = await import('../src/costs.js');
const { factsFromText } = await import('../src/extract.js');
const history = await import('../src/history.js');
const { estimateOf, estimateSource } = await import('../src/alerts.js');
const users = await import('../src/users.js');
const { checkListing } = await import('../src/inspect.js');
const settings = await import('../src/settings.js');
const { buildDigest, digestTick } = await import('../src/digest.js');
const now = Date.now();
const karnup = geo.baseByName('Karnup WA'), canberra = geo.baseByName('Canberra ACT');

test('where a lot is: suburb and state from messy location text', () => {
  assert.deepEqual(geo.placeOf({ location: 'Yard 3/263 Connors Road, Paget, QLD, Australia' }), { key: 'paget, QLD', suburb: 'Paget', state: 'QLD' });
  assert.equal(geo.placeOf({ location: 'Fyshwick', state: 'ACT' }).key, 'fyshwick, ACT');
  assert.equal(geo.placeOf({ location: 'Altona North, VIC' }).suburb, 'Altona North');
  assert.equal(geo.placeOf({ location: 'Somewhere' }), null);
});

test('distance: cached suburb, else the state capital (approximate)', () => {
  geo._setCache({ 'fyshwick, ACT': { lat: -35.33, lon: 149.17 }, 'bibra lake, WA': { lat: -32.09, lon: 115.82 } });
  const d = geo.distanceKm({ location: 'Fyshwick', state: 'ACT' }, canberra);
  assert.ok(d.km < 15 && !d.approx);
  const far = geo.distanceKm({ location: 'Altona North, VIC' }, karnup);
  assert.ok(far.approx && far.km > 3000 && far.km < 4200, `Melbourne from Karnup ~${far.km} km`);
});

test("true cost: fee schedule by line, Lloyds 16.5% premium, +GST, transport only when switched on", async () => {
  const { feeLine, maxBidFor } = await import('../src/costs.js');
  const isuzu = { site: 'pickles', title: '2011 Isuzu NPR 400 Medium', category: 'trucks', location: 'Bibra Lake, WA', bid: 2200 };
  assert.equal(feeLine(isuzu), 'industrial');
  assert.equal(feeLine({ site: 'pickles', title: '2014 Mazda 3', category: 'cars', wovr: 'Statutory Write-Off' }), 'salvage');
  assert.equal(feeLine({ site: 'pickles', title: '2019 Toyota Corolla', category: 'cars' }), 'cars');
  assert.equal(feeLine({ site: 'pickles', title: 'Dulux paint 10L', category: 'general goods' }), 'general');
  const c = allIn(isuzu, karnup);
  assert.equal(c.transport, null, 'transport is off unless you turn it on');
  assert.equal(c.total, c.landed);
  assert.ok(c.km < 80, 'distance is still shown');
  assert.equal(allIn(isuzu, karnup, undefined, { transport: true }).transport, 0, 'Bibra Lake is a pick-up from Karnup');
  assert.ok(allIn(isuzu, canberra, undefined, { transport: true }).transport > 2000, 'a truck across the country is expensive');
  const volvo = { site: 'lloyds', title: '2004 Volvo FH12 Prime Mover', location: 'Paget, QLD', bid: 1650, gst_extra: 1 };
  const v = allIn(volvo, null);
  assert.equal(v.premium, 272);
  assert.equal(v.gst, 165);
  assert.equal(v.landed, 1650 + 272 + 165);
  const drill = { site: 'allbids', title: 'Makita drill', location: 'Fyshwick', state: 'ACT', bid: 40, buyer_premium: 10 };
  assert.equal(allIn(drill, canberra).premium, 4, "the lot's own premium wins over the site default");
  // "I can spend $5,000 all-in": the highest bid that stays within it
  const max = maxBidFor(volvo, null, 5000);
  assert.ok(allIn(volvo, null, max).total <= 5000 && allIn(volvo, null, max + 1).total > 5000);
});

test("fees read from a lot page", () => {
  const f = factsFromText("Current Bid: $1,650\nBuyer's Premium: 16.5% GST Inclusive\nPrice + GST");
  assert.equal(f.buyer_premium, 16.5);
  assert.equal(f.gst_extra, 1);
  assert.equal(factsFromText('Prices include GST').gst_extra, undefined);
});

test('own history: what similar vehicles sold for, used as the estimate', () => {
  const sold = (id, title, price, year, wovr = null) => {
    upsertLot({ site: 'pickles', ext_id: id, title, bid: price, year, wovr, category: 'cars', end_at: now - 86400000, url: `https://www.pickles.com.au/used/details/cars/x/${id}` });
    db.prepare('UPDATE lots SET last_checked = end_at - 30000 WHERE key = ?').run(`pickles:${id}`);
  };
  sold('80000001', '2016 Mercedes-Benz Sprinter 316 CDI LWB', 14000, 2016);
  sold('80000002', '2017 Mercedes Benz Sprinter 516', 16000, 2017);
  sold('80000003', '2015 Mercedes-Benz Sprinter 313', 12500, 2015);
  sold('80000004', '2016 Mercedes-Benz Sprinter 316', 3000, 2016, 'Statutory Write-Off');
  sold('80000005', '2004 Mercedes-Benz Sprinter 311', 4000, 2004);
  q.closeDue.all(now, now);
  history.rebuild();
  assert.deepEqual(history.identify({ title: '2018 Mercedes-Benz Sprinter 319' }), { make: 'mercedes', model: 'sprinter', year: 2018 });
  const live = { key: 'allbids:9', site: 'allbids', title: '2016 Mercedes-Benz Sprinter 316 Van', category: 'cars', bid: 5000 };
  const h = history.soldLike(live);
  assert.equal(h.n, 3, 'similar year, not the statutory one, not the 2004');
  assert.equal(h.median, 14000);
  assert.equal(estimateOf(live), 14000);
  assert.equal(estimateSource(live), 'history');
  assert.equal(estimateOf({ ...live, manual_estimate: 20000 }), 20000, 'your own estimate still wins');
  assert.equal(history.soldLike({ ...live, title: '2016 Toyota Hiace' }), null);
});

test('two of you bidding on the same lot: the other person is warned', async () => {
  upsertLot({ site: 'pickles', ext_id: '81000001', title: '2015 Toyota Hiace', bid: 9000, end_at: now + 3600000, url: 'https://x/h' });
  settings.setUser('matthew', { ntfyUrl: 'https://ntfy.test/matthew' });
  users.setMyBid('matthew', 'pickles:81000001', 11000);
  pushes.length = 0;
  const rivals = users.setMyBid('aaron', 'pickles:81000001', 12000);
  assert.deepEqual(rivals.map(r => ({ ...r })), [{ user: 'matthew', my_bid: 11000 }]);
  await users.warnRivals('aaron', 'pickles:81000001', 12000);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].url, 'https://ntfy.test/matthew');
  assert.match(dec(pushes[0].title), /aaron is bidding on this too \(max \$12,000\)/);
  assert.match(pushes[0].body, /Your max is \$11,000/);
});

test('listing check: Claude reads text + photos, verdict stored; photo-blocked sites fall back to text', async () => {
  settings.set({ anthropicKey: 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' });
  const lot = q.lot.get('pickles:81000001');
  const read = async () => ({ text: 'Sold as is. Vehicle does not start. Keys: Yes. Flood damaged interior.', images: ['https://img.example/1.jpg', 'https://img.example/2.jpg'] });
  let first = true;
  claudeReply = body => {
    if (first && body.messages[0].content.some(c => c.type === 'image')) { first = false; return new Response('{"error":{"message":"Unable to download the file at url"}}', { status: 400 }); }
    return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"verdict":"avoid","summary":"Flood damaged and does not start","flags":["flood damage","does not start"],"starts":"no","keys":"yes"}' }] }));
  };
  const r = await checkListing(lot, { read });
  assert.equal(r.verdict, 'avoid');
  assert.deepEqual(r.flags, ['flood damage', 'does not start']);
  assert.equal(claude.length, 2, 'retried without photos');
  assert.ok(!claude[1].messages[0].content.some(c => c.type === 'image'));
  assert.match(claude[1].messages[0].content.at(-1).text, /Vehicle does not start/);
  const row = q.lot.get('pickles:81000001');
  assert.equal(row.check_verdict, 'avoid');
  assert.equal(JSON.parse(row.check_note).starts, 'no');
});

test('morning digest: matches, deals, watchlist, missed - sent once at the chosen hour', async () => {
  upsertLot({ site: 'lloyds', ext_id: '82000001', title: '2017 Renault Master Van', bid: 3000, end_at: now + 5 * 3600000, url: 'https://x/m' });
  upsertLot({ site: 'pickles', ext_id: '82000002', title: '2014 Hyundai i30', bid: 1500, end_at: now + 3 * 3600000, url: 'https://x/i' });
  q.manualEstimate.run(9000, 'pickles:82000002');
  q.addSearch.get('aaron', 'renault master', 5000, null, now);
  const text = buildDigest('aaron', now);
  assert.match(text, /1 of your alert matches close in the next 24 h/);
  assert.match(text, /2017 Renault Master Van — \$3,000/);
  assert.match(text, /Best deals right now:\n• 2014 Hyundai i30 — \$1,500 \(est \$9,000\)/);
  assert.match(text, /on your watchlist close in the next 24 h — you're outbid on some|on your watchlist close/);
  // hour check: pick the current hour in Sydney so it fires now
  const hour = Number(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  settings.setUser('aaron', { digestHour: hour, ntfyUrl: 'https://ntfy.test/aaron' });
  settings.setUser('matthew', { digestHour: (hour + 3) % 24 });
  pushes.length = 0;
  await digestTick();
  await digestTick();
  assert.equal(pushes.length, 1, 'once a day, only for the person whose hour it is');
  assert.equal(pushes[0].url, 'https://ntfy.test/aaron');
  assert.equal(dec(pushes[0].title), 'KAMRADS morning digest');
});

test('sectors: vehicles by type, freight/business gear, paint stays in general goods', async () => {
  const { sectorOf } = await import('../src/categories.js');
  const cases = [['2011 Isuzu NPR 400 Medium Tipper', 'trucks', 'trucks'], ['2017 Renault Master Van LWB', null, 'vans'], ['Crown Electric Pallet Truck', null, 'warehouse'],
    ['Toyota 8FG25 Forklift', null, 'warehouse'], ['8x5 Box Trailer', null, 'trailers'], ['Dulux Wash & Wear Paint 10L', null, 'general'],
    ['Speed Queen Commercial Washer', null, 'hospitality'], ['Snack Vending Machine with coin mech', null, 'vending'], ['Dell Latitude 5420 Laptop', null, 'it'],
    ['Pallet of Makita power tools', null, 'tools'], ['2015 Jayco Starcraft Caravan', null, 'marine']];
  for (const [title, category, want] of cases) assert.equal(sectorOf({ title, category }), want, title);
});

test('Grays lot page: labelled close/open times win, reserve read, "(0 bids)" bid read', async () => {
  const { grays } = await import('../src/sites/extra.js');
  const { factsFromText } = await import('../src/extract.js');
  const now = Date.parse('2026-10-20T19:07:00Z');
  const text = 'Opens: 22 October 18:00 AEDT\nCloses: (27 October 20:00 AEDT)\nCurrent Bid (0 bids)\n$1\nReserve not met\nOnce the reserve is met, it will be green';
  assert.equal(grays.timesFromLotPage, true);
  const { tierFee } = await import('../src/costs.js');
  assert.equal(tierFee('2000:495,5000:650,10000:710,30000:7%,40000:6%,*:5%', 1500), 495);
  assert.equal(tierFee('2000:495,5000:650,10000:710,30000:7%,40000:6%,*:5%', 20000), 1400);
  const f = factsFromText(text, now);
  assert.equal(f.bid, 1);
  assert.equal(f.reserve, 'not met');
  const { parseDayMonthTime } = await import('../src/extract.js');
  assert.equal(new Date(parseDayMonthTime('27 October 20:00 AEDT', now)).toISOString(), '2026-10-27T09:00:00.000Z');
  assert.equal(new Date(parseDayMonthTime('3 January 9:00 AEDT', Date.parse('2026-12-20T00:00:00Z'))).toISOString(), '2027-01-02T22:00:00.000Z', 'next year');
});

test('board: lots without a close time only show in the 7-day view', () => {
  const t = Date.now();
  upsertLot({ site: 'grays', ext_id: '0016-23502700', title: '2006 Audi TT Petrol', bid: 1, url: 'https://www.grays.com/lot/0016-23502700/x/2006-audi-tt-petrol' });
  const keys = all => q.dashboard.all(t - 60000, t + 3 * 3600000, all, 4000).map(l => l.key);
  assert.ok(!keys(0).includes('grays:0016-23502700'));
  assert.ok(keys(1).includes('grays:0016-23502700'));
});

test('own history uses kilometres: a low-km van is valued against low-km results', () => {
  const t = Date.now();
  const sold = (id, title, price, year, km) => {
    upsertLot({ site: 'pickles', ext_id: id, title, bid: price, year, odometer: km, category: 'vans', end_at: t - 86400000, url: `https://www.pickles.com.au/used/details/vans/x/${id}` });
    db.prepare('UPDATE lots SET last_checked = end_at - 30000 WHERE key = ?').run(`pickles:${id}`);
  };
  // high-km fleet HiAces go cheap, low-km ones don't
  sold('83000001', '2018 Toyota HiAce LWB Van', 18000, 2018, 320000);
  sold('83000002', '2018 Toyota HiAce LWB Van', 17500, 2018, 350000);
  sold('83000003', '2019 Toyota HiAce LWB Van', 19000, 2019, 300000);
  sold('83000004', '2018 Toyota HiAce LWB Van', 31000, 2018, 85000);
  sold('83000005', '2019 Toyota HiAce LWB Van', 33000, 2019, 70000);
  sold('83000006', '2018 Toyota HiAce LWB Van', 30500, 2018, 95000);
  q.closeDue.all(t, t);
  history.rebuild();
  const low = history.soldLike({ key: 'x:1', site: 'allbids', title: '2018 Toyota HiAce Van', category: 'vans', odometer: 90000 }, { k: 3 });
  const high = history.soldLike({ key: 'x:2', site: 'allbids', title: '2018 Toyota HiAce Van', category: 'vans', odometer: 330000 }, { k: 3 });
  assert.ok(low.median >= 30000, `low km ~$31k, got ${low.median}`);
  assert.ok(high.median <= 19000, `high km ~$18k, got ${high.median}`);
  assert.match(low.label, /toyota hiace 2016–2020, 70–95k km/);
  // stored as clean columns
  const row = q.lot.get('pickles:83000004');
  assert.equal(row.make, 'toyota'); assert.equal(row.model, 'hiace'); assert.equal(row.year, 2018);
});


test('Grays: the lot page gives the place and its own buyer premium; accessories are goods, not vehicles', async () => {
  const { grays } = await import('../src/sites/extra.js');
  const { isVehicle } = await import('../src/extract.js');
  const text = 'Truck Tool Box\nCurrent Bid\n$9\n0 bids\nReserve met\nCloses: (22 October 20:00 AEDT)\nLocation\n140 National Drive Dandenong South VIC 3125\nBuyers premium\nVariable\nFinal Bid Price\nBuyers Premium\nANY\n20%\nAn Administration fee is payable on this lot';
  const f = grays.pageFacts(text);
  assert.equal(f.location, 'Dandenong South, VIC'); assert.equal(f.state, 'VIC'); assert.equal(f.buyer_premium, 20);
  assert.equal(grays.pageFacts('Location: Unit 3/12 Smith St, Fyshwick ACT 2609').location, 'Fyshwick, ACT');
  const box = { site: 'grays', title: 'Truck Tool Box', category: null, url: 'https://www.grays.com/lot/0036-23502559/auto-accessories/truck-tool-box' };
  assert.equal(isVehicle(box), false, 'a tool box is not a truck');
  assert.equal(isVehicle({ site: 'grays', title: '2016 Isuzu NPR 400 Truck', url: 'https://www.grays.com/lot/1-2/trucks/2016-isuzu-npr-400' }), true);
  const c = allIn({ ...box, buyer_premium: 20 }, null, 9);
  assert.equal(c.fee, 0, 'no $495 vehicle fee'); assert.equal(c.landed, 11);
  assert.ok(allIn(box, null, 9).landed < 15, 'goods premium even before its page is read');
});

test('Lloyds: the sale address when a lot has no location; row titles without lot number, price or countdown', async () => {
  const { factsFromLotPage, cleanRowTitle, rowToLot } = await import('../src/sites/lloyds.js');
  const html = '<div>Cork &amp; Barrel - Lot 52</div><div>Auction Address:</div><div>148 Main Street Beverley SA 5009</div><p>This Auction is ONLINE VIEWING and SHIPPING ONLY</p><div>Buyer\'s Premium: 19.75% GST Inclusive</div><div>Auction Date: 21-Oct-2026 19:00</div>';
  const f = factsFromLotPage(html);
  assert.equal(f.location, 'Beverley, SA · ships only'); assert.equal(f.state, 'SA'); assert.equal(f.buyer_premium, 19.75);
  const g = factsFromLotPage('<div>Location of item: Villawood, NSW, Australia</div><div>Auction Address: 1 Smith St Yatala QLD 4207</div>');
  assert.equal(g.location, 'Villawood, NSW', 'the item location wins over the sale address');
  assert.equal(cleanRowTitle('52 Happy Campers, Albert Park Estate, 2013 Heathcote... $1 01:32:42', '52'), 'Happy Campers, Albert Park Estate, 2013 Heathcote');
  assert.equal(cleanRowTitle('670 2016 Sol Invictus Mercury - Silver - 6,209km -... $52 1d 5h 06m', '670'), '2016 Sol Invictus Mercury - Silver - 6,209km -');
  assert.equal(cleanRowTitle('2004 Volvo FH12 Prime Mover', null), '2004 Volvo FH12 Prime Mover');
  const l = rowToLot({ href: 'https://www.lloydsonline.com.au/LotDetails.aspx?smode=0&aid=74642&lid=6107422', heading: '52 Happy Campers, Albert Park Estate, 2013 Heathcote... $1 01:32:42', text: '52 Happy Campers, Albert Park Estate, 2013 Heathcote... $1 01:32:42' }, { aid: '74642' });
  assert.equal(l.title, 'Happy Campers, Albert Park Estate, 2013 Heathcote'); assert.equal(l.lot_no, '52'); assert.equal(l.bid, 1);
});
