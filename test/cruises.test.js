// Cruises: OzCruising's departure-port pages read into cruises, per-night pricing, red-hot deals flagged and pushed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kamrads-cruises-'));
process.env.DASH_USER = 'aaron'; process.env.DASH_PASS = 'a'; process.env.DASH_USERS = 'matthew:m';
process.env.GEOCODE = 'false'; process.env.PORT = '18795'; process.env.HOST = '127.0.0.1';
process.env.NTFY_URL = 'https://ntfy.test/shared';

const pushes = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://ntfy.test/')) { const h = opts.headers?.Title || ''; const m = /^=\?UTF-8\?B\?(.+)\?=$/.exec(h); pushes.push({ title: m ? Buffer.from(m[1], 'base64').toString() : h, body: opts.body, click: opts.headers?.Click }); return new Response('ok'); }
  return realFetch(url, opts);
};

const P = await import('../src/cruises/parse.js');
const { cz, upsertCruise } = await import('../src/cruises/store.js');
const V = await import('../src/cruises/view.js');
const L = await import('../src/cruises/loop.js');
const settings = await import('../src/settings.js');
const { startServer } = await import('../src/server.js');
startServer();
await new Promise(r => setTimeout(r, 300));
test.after(() => setTimeout(() => process.exit(0), 50));
const base = 'http://127.0.0.1:18795';
const H = u => ({ authorization: 'Basic ' + Buffer.from(u).toString('base64'), 'content-type': 'application/json' });
const api = async (m, p, body, u = 'aaron:a') => { const r = await realFetch(base + p, { method: m, headers: H(u), body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };

const NOW = Date.parse('2026-11-09T00:00:00Z');
const ymd = days => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
const longDate = days => new Date(Date.now() + days * 864e5).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

test('a cruise card: ship, line, port, nights, date, fares by occupancy', () => {
  const c = P.cardFromText(['Moreton Island', 'Pacific Adventure', "Australia's Favourite Cruise", 'Tuesday 3 September 2024', 'from Sydney', '4 nights', 'Discounted Fares', 'Twin From $1,130 pp', 'Quad From $380 pp', 'View Cruise'].join('\n'),
    { href: 'https://www.ozcruising.com.au/cruise/pa24-a123?x=1', now: NOW });
  assert.equal(c.code, 'pa24-a123'); assert.equal(c.title, 'Moreton Island'); assert.equal(c.ship, 'Pacific Adventure');
  assert.equal(c.line, 'Carnival'); assert.equal(c.port, 'syd'); assert.equal(c.nights, 4); assert.equal(c.depart, '2024-09-03');
  assert.equal(c.twin, 1130); assert.equal(c.quad, 380); assert.equal(c.badge, 'Discounted Fares');
  assert.deepEqual(P.nightly(c), { twin: 282.5, share: 95 });

  // a title that carries the ship; departs Fremantle; a cabin fare
  const p = P.cardFromText('17 Night Perth to Sydney Cruise on the Crown Princess. Cruise code: pc26-3618g.1\nDeparts Fremantle\nSat 14 Mar 2027\nInside from $2,499pp', { now: NOW });
  assert.equal(p.ship, 'Crown Princess'); assert.equal(p.line, 'Princess'); assert.equal(p.port, 'per'); assert.equal(p.nights, 17);
  assert.equal(p.depart, '2027-03-14'); assert.equal(p.twin, 2499); assert.equal(p.title, '17 Night Perth to Sydney Cruise on the Crown Princess');

  // lines from ship names and cruise codes
  assert.equal(P.lineOf({ ship: 'Ovation of the Seas' }), 'Royal Caribbean'); assert.equal(P.lineOf({ ship: 'Queen Elizabeth' }), 'Cunard');
  assert.equal(P.lineOf({ ship: 'Westerdam' }), 'Holland America'); assert.equal(P.lineOf({ ship: 'Celebrity Edge' }), 'Celebrity');
  assert.equal(P.lineOf({ code: 'cu24-q432' }), 'Cunard'); assert.equal(P.lineOf({ line: 'Royal Caribbean International' }), 'Royal Caribbean');
  // no nights or no fare: not a cruise
  assert.equal(P.cardFromText('Pacific Explorer\nTwin From $899 pp', { now: NOW }), null);
});

test('fares: savings, "was" prices, deposits and per-night figures are not fares; labels on the line above count', () => {
  const f = P.faresIn('Save $500\nTwin From $1,308 pp Save $200\nwas $2,000 now $1,500 pp\nBalcony\nFrom $2,199 pp\n$43 per night\n$200 deposit\nQuad\nfrom $654');
  assert.deepEqual(f.map(x => [x.amount, x.occ, x.cabin]), [[1308, 'twin', null], [1500, 'twin', null], [2199, 'twin', 'balcony'], [654, 'quad', null]]);
  assert.deepEqual(P.faresIn('Twin From $1,308 pp Quad From $654 pp').map(x => x.occ), ['twin', 'quad']);
  // dates without a year are the next one
  assert.equal(P.dateIn('Sat 3 Jan', NOW), '2027-01-03'); assert.equal(P.dateIn('Fri 20 Nov', NOW), '2026-11-20');
  assert.equal(P.dateIn('March 4, 2027'), '2027-03-04'); assert.equal(P.dateIn('04/03/2027'), '2027-03-04');
});

test('a "$99 per person deposit" special is not the fare (Sapphire Princess, PC27-H801)', () => {
  const card = ['Princess Cruises', '14 Nights WA Coast & Bali Cruise on the Sapphire Princess', 'PC27-H801', 'Sapphire Princess', '14 Nights', 'WA Coast & Bali',
    'Departing Fremantle (Perth)', 'Sun 19 Dec 2027', 'Special $99 Per Person Deposit', 'Price Includes: Meals, Entertainment,', 'Port Fees & Taxes', 'Interior from $3,331 pp', 'View Cruise'].join('\n');
  const c = P.cardFromText(card, { href: 'https://www.ozcruising.com.au/cruise/pc27-h801', now: NOW });
  assert.equal(c.twin, 3331); assert.equal(c.nights, 14); assert.equal(c.port, 'per'); assert.equal(c.depart, '2027-12-19');
  assert.equal(c.ship, 'Sapphire Princess'); assert.equal(c.line, 'Princess'); assert.equal(c.badge, '$99 deposit');
  assert.ok(Math.abs(P.nightly(c).twin - 237.93) < 0.01);
  // the deposit alone (no fare on the card): no price at all, rather than a wrong one
  assert.equal(P.cardFromText(card.replace('Interior from $3,331 pp\n', ''), { now: NOW }), null);
  // other promotions next to a price
  assert.deepEqual(P.faresIn('Twin from $1,299 pp\nUp to $500 onboard credit\n$200 per cabin to spend onboard\n$1 deposit\nReduced $49 deposit').map(f => f.amount), [1299]);
  assert.deepEqual(P.faresIn('Inside $899 pp plus $100 drinks package').map(f => f.amount), [899]);
});

test('an earlier bad read (a deposit taken as the fare) is cleared, so it is read again and never counts as a drop', async () => {
  const { db } = await import('../src/db.js');
  db.prepare(`INSERT INTO cruises (key, code, ship, port, nights, depart, twin, first_twin, low_twin, status, first_seen, last_seen) VALUES ('oz:zz-bad', 'zz-bad', 'Sapphire Princess', 'per', 14, ?, 99, 99, 99, 'open', 1, 1)`).run(ymd(400));
  db.prepare(`INSERT INTO cruise_alerts (user, key, at, per_night) VALUES ('aaron', 'oz:zz-bad', 1, 7.07)`).run();
  // what the store does on start-up
  const MIN = P.MIN_NIGHT;
  db.exec(`UPDATE cruises SET twin = NULL WHERE nights > 0 AND twin IS NOT NULL AND twin / nights < ${MIN}`);
  db.exec(`UPDATE cruises SET first_twin = NULL, low_twin = NULL, prev_twin = NULL WHERE nights > 0 AND (first_twin / nights < ${MIN} OR low_twin / nights < ${MIN} OR prev_twin / nights < ${MIN})`);
  db.exec(`DELETE FROM cruise_alerts WHERE per_night < ${MIN}`);
  assert.equal(cz.get.get('oz:zz-bad').twin, null);
  assert.equal(V.isRedHot(cz.get.get('oz:zz-bad'), V.defaultView()), false);
  const r = upsertCruise({ code: 'zz-bad', ship: 'Sapphire Princess', port: 'per', nights: 14, depart: ymd(400), twin: 3331, fares: [] });
  assert.equal(r.dropped, 0);
  const row = cz.get.get('oz:zz-bad');
  assert.equal(row.twin, 3331); assert.equal(row.first_twin, 3331); assert.equal(row.low_twin, 3331);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM cruise_alerts WHERE key = 'oz:zz-bad'`).get().n, 0);
});

test('a whole page of text (pasted): each cruise kept apart, whichever side of the nights its fares sit', () => {
  const page = ['Cruises from Sydney', 'Showing 3 of 212 cruises', 'Sort by',
    'Vanuatu & Fiji', 'Carnival Adventure', "Australia's Favourite Cruise", 'Tuesday 13 January 2027', 'from Sydney', '12 nights', 'Quad From $2,207 pp', 'View Cruise',
    'Sydney to Fremantle', 'Coral Princess', 'Premium Cruise Line', 'Monday 19 April 2027', 'from Sydney', '17 nights', 'Sale Fare', 'Twin From $6,934 pp', 'Triple From $5,253 pp', 'View Cruise',
    'Moreton Island', 'Carnival Encounter', 'Friday 4 December 2026', 'from Sydney', '3 nights', 'Discounted Fares', 'Twin From $129 pp', 'Quad From $99 pp', 'View Cruise',
    'Contact us 1300 000 000'].join('\n');
  const r = P.cardsFromPageText(page, { portKey: 'syd', now: NOW });
  assert.equal(r.length, 3);
  assert.deepEqual(r.map(c => [c.title, c.ship, c.nights, c.twin, c.triple, c.quad]), [
    ['Vanuatu & Fiji', 'Carnival Adventure', 12, null, null, 2207], ['Sydney to Fremantle', 'Coral Princess', 17, 6934, 5253, null], ['Moreton Island', 'Carnival Encounter', 3, 129, null, 99]]);
  const before = ['Header', 'Vanuatu', 'Ovation of the Seas', 'From $899 pp', 'Sat 3 Jan 2027', '7 nights', 'Fiji', 'Quantum of the Seas', 'Inside from $1,050pp', 'Sun 4 Jan 2027', '10 nights'].join('\n');
  assert.deepEqual(P.cardsFromPageText(before, { portKey: 'bne', now: NOW }).map(c => [c.title, c.ship, c.nights, c.twin, c.port]), [['Vanuatu', 'Ovation of the Seas', 7, 899, 'bne'], ['Fiji', 'Quantum of the Seas', 10, 1050, 'bne']]);
});

test('the data a page loads (JSON): cruise objects found and read', () => {
  const bodies = [{ url: 'https://www.ozcruising.com.au/api/search', body: { total: 2, results: [
    { cruiseCode: 'RC27-OV0105', title: 'South Pacific', ship: { name: 'Ovation of the Seas' }, cruiseLine: { name: 'Royal Caribbean' }, nights: 7, departureDate: '2027-01-05T00:00:00',
      departurePort: { name: 'Sydney (White Bay)' }, prices: [{ occupancy: 'Twin', cabin: 'Inside', price: 999 }, { occupancy: 'Quad', price: 620 }], wasPrice: 1499 },
    { code: 'pa27-x101', itineraryName: 'Moreton Island Getaway', shipName: 'Carnival Encounter', duration: '3', sailDate: '12 Feb 2027', fromPrice: '$189', url: '/cruise/pa27-x101' },
  ] } }, { url: 'https://www.ozcruising.com.au/api/menu', body: { items: [{ name: 'Deals', url: '/deals' }] } }];
  const r = P.cardsFromJson(bodies, { portKey: 'bne', now: NOW });
  assert.equal(r.length, 2);
  const [a, b] = r;
  assert.equal(a.code, 'rc27-ov0105'); assert.equal(a.ship, 'Ovation of the Seas'); assert.equal(a.line, 'Royal Caribbean'); assert.equal(a.port, 'syd');
  assert.equal(a.depart, '2027-01-05'); assert.equal(a.twin, 999); assert.equal(a.quad, 620); assert.equal(a.url, 'https://www.ozcruising.com.au/cruise/rc27-ov0105');
  assert.equal(b.code, 'pa27-x101'); assert.equal(b.line, 'Carnival'); assert.equal(b.nights, 3); assert.equal(b.twin, 189); assert.equal(b.port, 'bne');
  assert.equal(b.url, 'https://www.ozcruising.com.au/cruise/pa27-x101');
});

test('store: fare history, drops since first seen, sailed and stale cruises dropped', () => {
  const c = { code: 'zz-store1', ship: 'Carnival Splendor', line: 'Carnival', port: 'syd', nights: 5, depart: ymd(40), twin: 700, quad: 400, fares: [] };
  assert.equal(upsertCruise(c, NOW).isNew, true);
  assert.equal(upsertCruise({ ...c }, NOW + 1000).dropped, 0);
  const r = upsertCruise({ ...c, twin: 560 }, NOW + 2000);
  assert.equal(r.dropped, 140);
  const row = cz.get.get('oz:zz-store1');
  assert.equal(row.first_twin, 700); assert.equal(row.low_twin, 560); assert.equal(row.prev_twin, 700);
  assert.equal(cz.history.all('oz:zz-store1').length, 2);
  upsertCruise({ code: 'zz-sailed', ship: 'Old Ship', port: 'syd', nights: 3, depart: '2020-01-01', twin: 300, fares: [] }, NOW);
  cz.expire.run(NOW - 3600e3, L.todayYmd());
  assert.equal(cz.get.get('oz:zz-sailed').status, 'gone');
  assert.equal(cz.get.get('oz:zz-store1').status, 'open');
  cz.expire.run(NOW + 10 * 864e5, L.todayYmd());   // not seen since: off sale
  assert.equal(cz.get.get('oz:zz-store1').status, 'gone');
});

test('filters and red hot: per person per night on twin share; share fares only when asked', () => {
  const v = { ...V.defaultView(), hot: 50 };
  const cheap = { port: 'bne', line: 'Carnival', nights: 4, depart: ymd(20), twin: 180, quad: 120 };   // $45 twin
  const shareOnly = { port: 'syd', line: 'Carnival', nights: 12, depart: ymd(30), quad: 540 };  // $45 quad, no twin
  const dear = { port: 'per', line: 'Princess', nights: 14, depart: ymd(200), twin: 2800, triple: 1400 }; // $200 twin, $100 triple
  assert.equal(V.isRedHot(cheap, v), true); assert.equal(V.isRedHot(shareOnly, v), false); assert.equal(V.isRedHot(dear, v), false);
  assert.equal(V.isRedHot(shareOnly, { ...v, share: true }), true);
  assert.deepEqual(V.nightOf(dear, true), { night: 100, basis: 'share' });
  assert.equal(V.fits(cheap, { ...v, ports: ['syd', 'per'] }), false); assert.equal(V.fits(cheap, { ...v, ports: ['bne'] }), true);
  assert.equal(V.fits(dear, { ...v, len: 'week' }), false); assert.equal(V.fits(dear, { ...v, len: 'long' }), true);
  assert.equal(V.fits(dear, { ...v, within: 3 }), false); assert.equal(V.fits(cheap, { ...v, within: 1 }), true);
  assert.equal(V.fits(dear, { ...v, maxPrice: 2000 }), false); assert.equal(V.fits(dear, { ...v, maxPrice: 2000, share: true }), true);
  assert.equal(V.fits(cheap, { ...v, line: 'Princess' }), false); assert.equal(V.fits(dear, { ...v, maxNight: 120 }), false);
  const clean = V.cleanView({ ports: 'syd,bne,xxx', len: 'nope', hot: '2', sort: 'drop', maxPrice: '' });
  assert.deepEqual(clean.ports, ['syd', 'bne']); assert.equal(clean.len, ''); assert.equal(clean.hot, 5); assert.equal(clean.sort, 'drop'); assert.equal(clean.maxPrice, null);
});

test('page + API: first visit sets up quietly, red-hot deals push once, a drop into red hot pushes, pasted pages add cruises', async () => {
  // something red hot is already listed before Aaron first opens the page: on screen, not pushed
  upsertCruise({ code: 'zz-early', ship: 'Carnival Luminosa', port: 'bne', nights: 3, depart: ymd(25), twin: 120, fares: [] }, Date.now());
  const page = await realFetch(base + '/cruises', { headers: H('aaron:a') });
  const html = await page.text();
  assert.equal(page.status, 200); assert.match(html, /Red-hot deals|Red hot/); assert.match(html, /href="\/cruises" class="on"/);
  const first = await api('GET', '/api/cruises');
  assert.equal(first.status, 200);
  assert.ok(first.json.cruises.some(c => c.code === 'zz-early'));
  assert.deepEqual(first.json.ports.map(p => p.key).slice(0, 3), ['syd', 'bne', 'per']);
  assert.equal(first.json.view.hot, 50);
  pushes.length = 0;
  await L.runCruiseAlerts();
  assert.equal(pushes.length, 0, 'already on screen when the page was opened');

  // Aaron wants Brisbane and Sydney only, red hot at $60
  const sv = await api('POST', '/api/cruises/view', { ports: ['bne', 'syd'], hot: 60 });
  assert.deepEqual(sv.json.view.ports, ['bne', 'syd']); assert.equal(sv.json.view.hot, 60);
  // new ones: a red-hot Brisbane cruise ($55/night), a Perth one (not his port), a dear one
  upsertCruise({ code: 'zz-hot', url: 'https://www.ozcruising.com.au/cruise/zz-hot', ship: 'Carnival Encounter', line: 'Carnival', port: 'bne', nights: 4, depart: ymd(15), twin: 220, fares: [] }, Date.now());
  upsertCruise({ code: 'zz-perth', ship: 'Crown Princess', port: 'per', nights: 4, depart: ymd(15), twin: 100, fares: [] }, Date.now());
  upsertCruise({ code: 'zz-dear', ship: 'Coral Princess', port: 'syd', nights: 10, depart: ymd(60), twin: 1900, fares: [] }, Date.now());
  await L.runCruiseAlerts();
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].title, /Red-hot cruise: \$55\/night/); assert.match(pushes[0].body, /Carnival Encounter · 4 nights from Brisbane/);
  assert.equal(pushes[0].click, 'https://www.ozcruising.com.au/cruise/zz-hot');
  await L.runCruiseAlerts();
  assert.equal(pushes.length, 1, 'once each');
  // Matthew never opened the page: nothing for him
  assert.ok(!pushes.some(p => /\[matthew\]/.test(p.title)));
  // the dear one drops to $55/night: now red hot, pushed
  upsertCruise({ code: 'zz-dear', ship: 'Coral Princess', port: 'syd', nights: 10, depart: ymd(60), twin: 550, fares: [] }, Date.now());
  await L.runCruiseAlerts();
  assert.equal(pushes.length, 2); assert.match(pushes[1].body, /Coral Princess/);
  // alerts off: quiet
  await api('POST', '/api/cruises/view', { alerts: false });
  upsertCruise({ code: 'zz-hot2', ship: 'Carnival Splendor', port: 'syd', nights: 3, depart: ymd(9), twin: 99, fares: [] }, Date.now());
  await L.runCruiseAlerts();
  assert.equal(pushes.length, 2);

  // a page pasted in by hand
  const text = ['Vanuatu & Fiji', 'Carnival Adventure', "Australia's Favourite Cruise", longDate(70), 'from Sydney', '12 nights', 'Twin From $1,399 pp', 'Quad From $720 pp', 'View Cruise',
    'Moreton Island', 'Carnival Encounter', longDate(33), 'from Sydney', '3 nights', 'Twin From $149 pp', 'View Cruise'].join('\n');
  const bad = await api('POST', '/api/cruises/paste', { text: 'hello' });
  assert.equal(bad.status, 400);
  const ok = await api('POST', '/api/cruises/paste', { text, port: 'syd' });
  assert.equal(ok.status, 200); assert.equal(ok.json.read, 2); assert.equal(ok.json.fresh, 2);
  const after = await api('GET', '/api/cruises');
  const pasted = after.json.cruises.filter(c => c.pasted);
  assert.equal(pasted.length, 2);
  assert.ok(pasted.every(c => c.port === 'syd' && c.url === 'https://www.ozcruising.com.au/departing/sydney/cruises' && !c.direct));
  // sailed ones never show
  assert.ok(!after.json.cruises.some(c => c.code === 'zz-sailed'));
  const h = await api('GET', '/api/cruises/history/' + encodeURIComponent('oz:zz-dear'));
  assert.equal(h.json.history.length, 2);
});

test('saving a scan skips cruises that have sailed; every page links to Cruises', async () => {
  const n = L.saveCruises([{ code: 'zz-gone', ship: 'X', port: 'syd', nights: 3, depart: '2021-05-01', twin: 100, fares: [] }, { code: 'zz-future', ship: 'Y', port: 'syd', nights: 3, depart: ymd(5), twin: 300, fares: [] }]);
  assert.equal(n, 1); assert.equal(cz.get.get('oz:zz-gone'), undefined);
  for (const f of ['index.html', 'freight.html', 'finds.html', 'bought.html', 'dreams.html']) assert.match(fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8'), /href="\/cruises"/, f);
  assert.ok(settings.getUser('aaron', 'cruiseView'));
});
