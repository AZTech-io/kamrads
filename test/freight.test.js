// Freight board: reading job cards, route fitting (Canberra <-> Sydney), alerts, API.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kamrads-freight-'));
process.env.DASH_USER = 'aaron'; process.env.DASH_PASS = 'a'; process.env.DASH_USERS = 'matthew:m';
process.env.NTFY_URL = 'https://ntfy.test/shared'; process.env.GEOCODE = 'false';
process.env.PORT = '18788'; process.env.HOST = '127.0.0.1';

const pushes = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://ntfy.test/')) { const h = opts.headers?.Title || ''; const m = /^=\?UTF-8\?B\?(.+)\?=$/.exec(h); pushes.push({ url: String(url), title: m ? Buffer.from(m[1], 'base64').toString() : h, body: opts.body }); return new Response('ok'); }
  return realFetch(url, opts);
};

const { jobFromCard, parseAgo, placesIn, jobsFromJson, truckitJob, loadshiftJobsFromText } = await import('../src/freight/parse.js');
const { upsertJob, fq } = await import('../src/freight/store.js');
const { fit, runFreightAlerts } = await import('../src/freight/match.js');
const geo = await import('../src/geo.js');
const { startServer } = await import('../src/server.js');
startServer();
await new Promise(r => setTimeout(r, 300));
const base = 'http://127.0.0.1:18788';
const H = u => ({ authorization: 'Basic ' + Buffer.from(u).toString('base64'), 'content-type': 'application/json' });
const AARON = H('aaron:a');
const api = async (m, p, body) => { const r = await realFetch(base + p, { method: m, headers: AARON, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };

// suburbs used below, as if already looked up
geo._setCache({ 'q:fyshwick act 2609': { lat: -35.33, lon: 149.17, state: 'ACT' }, 'q:lyneham act 2602': { lat: -35.25, lon: 149.13, state: 'ACT' },
  'q:parramatta nsw 2150': { lat: -33.815, lon: 151.0, state: 'NSW' }, 'q:goulburn nsw 2580': { lat: -34.75, lon: 149.72, state: 'NSW' },
  'q:carlton vic 3053': { lat: -37.8, lon: 144.97, state: 'VIC' }, 'q:mittagong nsw 2575': { lat: -34.45, lon: 150.45, state: 'NSW' } });

const AT = { site: 'airtasker', idFromUrl: u => (/-(x0[0-9a-z]{20,})/.exec(u) || [])[1] };
const card = (id, title, price, from, to, ago = 'about 2 hours ago') => ({ href: `https://www.airtasker.com/tasks/${title.toLowerCase().replace(/\W+/g, '-')}-x01m${id.padEnd(22, '0')}`,
  heading: title, text: `${title}\n$${price}\n${from}\n${to ? to + '\n' : ''}Posted ${ago}\nOpen` });

test('reading cards: places, price, posted time; Truckit-style towns', () => {
  const j = jobFromCard(card('aa1', 'Collect couch from Fyshwick and deliver to Lyneham', 80, 'Fyshwick ACT 2609', 'Lyneham ACT 2602', 'about 17 hours ago'), AT);
  assert.equal(j.from_text, 'Fyshwick ACT 2609'); assert.equal(j.to_text, 'Lyneham ACT 2602'); assert.equal(j.price, 80);
  assert.ok(Math.abs(j.posted_at - (Date.now() - 17 * 3600000)) < 5000);
  assert.deepEqual(placesIn('From Matraville NSW 2036 to Newtown NSW 2042'), ['Matraville NSW 2036', 'Newtown NSW 2042']);
  assert.equal(parseAgo('less than a minute ago') > Date.now() - 1000, true);
  const t = jobFromCard({ href: 'https://www.truckit.net/job/55501', heading: '', text: 'Ebike\nMACKSVILLE to SOUTHPORT\nDistance 382km\nWinning Quote $200' }, { site: 'truckit', idFromUrl: u => (/(\d{4,})/.exec(u) || [])[1] });
  assert.equal(t.from_text, 'Macksville'); assert.equal(t.km, 382); assert.equal(t.status, 'taken', 'a won quote is history, not open work');
  const fromJson = jobsFromJson({ data: { jobs: [{ jobId: 991, title: '2 pallets', pickup: { suburb: 'Fyshwick', state: 'ACT', postcode: '2609' }, delivery: { suburb: 'Parramatta', state: 'NSW', postcode: '2150' }, budget: 450 }] } }, { site: 'truckit', urlFor: (o, id) => `https://www.truckit.net/job/${id}` });
  assert.equal(fromJson[0].from_text, 'Fyshwick ACT 2609'); assert.equal(fromJson[0].price, 450);
});

test('Truckit job feed records: places, dates, distance, quotes; stable id without a job number', () => {
  const rec = { status: 'active', category_label: 'Pallets', item_label: '1 x Pallet(s) - Light Fittings - Approx.  2.71m3', created_at: '1792526438',
    collection_date_view: 'Date Range', collection_date_earliest: '2026-12-01 00:00:00', collection_date_latest: '2026-12-05 00:00:00',
    delivery_date_earliest: '2026-12-02 00:00:00', delivery_date_latest: '2026-12-11 00:00:00',
    suburb1: 'SEVEN HILLS', state1: 'NSW', postcode1: '2147', suburb2: 'BOWEN HILLS', state2: 'QLD', postcode2: '4006',
    distance_estimate: '908', active_quotes: '2', min_quote: '793.00', max_quote: '853.00', user_max_price: null, book_now_value: null };
  const j = truckitJob(rec);
  assert.equal(j.from_text, 'Seven Hills NSW 2147'); assert.equal(j.to_text, 'Bowen Hills QLD 4006');
  assert.equal(j.km, 908); assert.equal(j.price, 793); assert.equal(j.price_kind, 'quotes $793–$853'); assert.equal(j.offers, 2);
  assert.equal(j.title, '1 x Pallet(s) - Light Fittings - Approx. 2.71m3'); assert.equal(j.category, 'Pallets');
  assert.equal(j.posted_at, 1792526438000);
  assert.equal(j.due_text, 'collect 1–5 Dec · deliver 2–11 Dec');
  assert.equal(truckitJob({ ...rec }).ext_id, j.ext_id, 'same job, same id on every scan');
  const ready = truckitJob({ ...rec, collection_date_view: 'Ready Now', collection_date_earliest: null, min_quote: null, max_quote: null, active_quotes: null });
  assert.match(ready.due_text, /^collect ready now/); assert.equal(ready.price, null);
});

test('Loadshift board text: id, cargo, title, places, weight, ready date, distance', () => {
  const t = 'Loads 1,803\nLoad ID 40778814\nMachinery\nTelehandler\nWeight\n8300 kg\nPickup\nMerredin, WA 6415\nDropoff\nWallumbilla, QLD 4428\nReady On\n27-Oct-26\nDistance\n3775 km\n'
    + 'Load ID 40778728\nTruck or Prime Mover\nKenworth T409 Prime Mover - 8m L (9.5T)\nWeight 9500 kg\nPickup Freemans Reach, NSW 2756\nDropoff Perth, WA 6000\nReady On 20-Oct-26';
  const [a, b] = loadshiftJobsFromText(t, { 40778814: 'https://www.loadshift.com.au/loads/40778814' });
  assert.equal(a.ext_id, '40778814'); assert.equal(a.category, 'Machinery'); assert.equal(a.title, 'Telehandler');
  assert.equal(a.from_text, 'Merredin WA 6415'); assert.equal(a.to_text, 'Wallumbilla QLD 4428'); assert.equal(a.km, 3775);
  assert.equal(a.due_text, '8300 kg · ready 27 Oct'); assert.equal(a.url, 'https://www.loadshift.com.au/loads/40778814'); assert.equal(a.price, null);
  assert.equal(b.category, 'Truck or Prime Mover'); assert.equal(b.title, 'Kenworth T409 Prime Mover - 8m L (9.5T)');
  assert.equal(b.to_text, 'Perth WA 6000'); assert.equal(b.url, 'https://www.loadshift.com.au/search/loads', 'no link found: the board');
});

const route = { kind: 'route', a_lat: -35.2809, a_lon: 149.13, b_lat: -33.8688, b_lon: 151.2093, radius_km: 30, both_ways: 1, min_price: null };
const job = (from, to, price = 200) => ({ from_text: from, to_text: to, price });

test('fitting a Canberra ⇄ Sydney run', () => {
  assert.equal(fit(job('Fyshwick ACT 2609', 'Parramatta NSW 2150'), route).how, 'out', 'Canberra to Sydney: outbound');
  assert.equal(fit(job('Parramatta NSW 2150', 'Lyneham ACT 2602'), route).how, 'back', 'Sydney to Canberra: return load');
  assert.equal(fit(job('Goulburn NSW 2580', 'Parramatta NSW 2150'), route).how, 'out', 'Goulburn is on the way');
  assert.ok(fit(job('Mittagong NSW 2575', 'Parramatta NSW 2150'), route).extra <= 30);
  assert.equal(fit(job('Fyshwick ACT 2609', 'Carlton VIC 3053'), route), null, 'Melbourne is the wrong way');
  assert.equal(fit(job('Fyshwick ACT 2609', 'Lyneham ACT 2602'), route), null, 'a job across Canberra is local work, not part of the run');
  assert.equal(fit(job('Parramatta NSW 2150', 'Lyneham ACT 2602'), { ...route, both_ways: 0 }), null, 'no return leg unless asked');
  assert.equal(fit(job('Fyshwick ACT 2609', 'Parramatta NSW 2150', 50), { ...route, min_price: 100 }), null, 'below the minimum price');
  const area = { kind: 'area', a_lat: -35.2809, a_lon: 149.13, radius_km: 40 };
  assert.equal(fit(job('Fyshwick ACT 2609', 'Lyneham ACT 2602'), area).how, 'local');
  assert.equal(fit(job('Parramatta NSW 2150', 'Fyshwick ACT 2609'), area).how, 'dropoff');
  assert.equal(fit(job('Somewhere Unknown NSW', 'Parramatta NSW 2150'), area), null, "a place we can't pin down never matches");
});

test('alerts: one push per scan for new jobs that fit; existing jobs recorded quietly', async () => {
  upsertJob(jobFromCard(card('bb1', 'Bike transported from Canberra to Sydney', 100, 'Fyshwick ACT 2609', 'Parramatta NSW 2150'), AT));
  const r = await api('POST', '/api/freight/alerts', { a: 'Canberra', b: 'Sydney', radius: 30, bothWays: true, name: 'Sydney run' });
  assert.equal(r.status, 200);
  assert.equal((await api('POST', '/api/freight/alerts', { a: 'Nowhereville Zzz' })).status, 400);
  pushes.length = 0;
  await runFreightAlerts();
  assert.equal(pushes.length, 0, 'the job was there before the alert');
  await new Promise(r => setTimeout(r, 5));
  upsertJob(jobFromCard(card('bb2', 'Return a fridge to Canberra', 250, 'Parramatta NSW 2150', 'Lyneham ACT 2602'), AT));
  upsertJob(jobFromCard(card('bb3', 'Couch to Melbourne', 900, 'Fyshwick ACT 2609', 'Carlton VIC 3053'), AT));
  await runFreightAlerts(); await runFreightAlerts();
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].title, /1 new freight job: Sydney run/);
  assert.match(pushes[0].body, /Return a fridge to Canberra — \$250 · Parramatta NSW 2150 → Lyneham ACT 2602 \(return leg\)/);
  assert.match(pushes[0].title, /^\[aaron\]/);
});

test('API: jobs with fits, plan a run, alerts list', async () => {
  const all = (await api('GET', '/api/freight/jobs')).json;
  assert.equal(all.jobs.length, 3);
  const fridge = all.jobs.find(j => /fridge/.test(j.title));
  assert.deepEqual(fridge.fits.map(f => f.how), ['back']);
  assert.ok(fridge.km > 200 && fridge.perKm > 0);
  const planned = (await api('GET', '/api/freight/jobs?a=Canberra&d=40')).json;
  assert.equal(planned.jobs.filter(j => j.plan).length, 3, 'all three touch Canberra');
  const bad = (await api('GET', '/api/freight/jobs?a=Zzzqx')).json;
  assert.match(bad.planErr, /Couldn't find/);
  const al = (await api('GET', '/api/freight/alerts')).json;
  assert.equal(al[0].matches, 2);
  const mm = await realFetch(base + '/api/freight/alerts', { headers: H('matthew:m') });
  assert.deepEqual(await mm.json(), [], "Matthew doesn't see Aaron's routes");
  const page = await realFetch(base + '/freight', { headers: AARON });
  assert.match(await page.text(), /Freight board/);
});

test.after(() => setTimeout(() => process.exit(0), 50));
