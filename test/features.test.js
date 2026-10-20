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

test("true cost: Pickles flat fee, Lloyds 16.5% premium, +GST, transport home", () => {
  const isuzu = { site: 'pickles', title: '2011 Isuzu NPR 400 Medium', category: 'trucks', location: 'Bibra Lake, WA', bid: 2200 };
  const c = allIn(isuzu, karnup);
  assert.equal(c.fee, 275);
  assert.equal(c.transport, 0, 'Bibra Lake is a pick-up from Karnup');
  assert.equal(c.total, 2475);
  const toCbr = allIn(isuzu, canberra);
  assert.ok(toCbr.transport > 2000, 'a truck across the country is expensive');
  const volvo = { site: 'lloyds', title: '2004 Volvo FH12 Prime Mover', location: 'Paget, QLD', bid: 1650, gst_extra: 1 };
  const v = allIn(volvo, null);
  assert.equal(v.premium, 272);
  assert.equal(v.gst, 165);
  assert.equal(v.landed, 1650 + 272 + 165);
  const drill = { site: 'allbids', title: 'Makita drill', location: 'Fyshwick', state: 'ACT', bid: 40, buyer_premium: 10 };
  assert.equal(allIn(drill, canberra).premium, 4, "the lot's own premium wins over the site default");
  assert.equal(allIn(drill, canberra).transport, 0);
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
