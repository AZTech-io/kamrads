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

const { jobFromCard, parseAgo, placesIn, jobsFromJson, truckitJob, loadshiftJobsFromText, loadshiftRowsFromText } = await import('../src/freight/parse.js');
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

test('Loadshift board as the page text reads (real layout, Oct 2026)', () => {
  const text = ['Showing 1-100 of 1797', 'Sort by: Latest', 'Load ID', 'Freight', 'Qty.', 'Title', 'Weight', 'Pickup and Dropoff', 'Distance', 'Ready On',
    '40778994', 'Machinery', '1', 'Yanmar ViO80-1 Excavator - 6m L (9T)', '9000 kg', 'MacMasters Beach, NSW 2251', 'Kyogle, NSW 2474', '685 km', 'No date yet',
    '40720315', 'Machinery', '1', 'Komatsu PC300 Excavator - 3.19m W (Oversize)', '-', 'Garbutt, QLD 4814', 'Charters Towers City, QLD 4820', '137 km', '20-Oct-26'].join('\n\n');
  const [y, k] = loadshiftRowsFromText(text);
  assert.equal(y.ext_id, '40778994'); assert.equal(y.title, 'Yanmar ViO80-1 Excavator - 6m L (9T)'); assert.equal(y.km, 685);
  assert.equal(y.due_text, '9000 kg · ready: no date yet'); assert.equal(y.to_text, 'Kyogle NSW 2474');
  assert.equal(k.title, 'Komatsu PC300 Excavator - 3.19m W (Oversize)'); assert.equal(k.due_text, 'ready 20 Oct');
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

// ---- heat tiers, dates, old jobs, contacting shippers ----
const heat = await import('../src/freight/heat.js');
const loop = await import('../src/freight/loop.js');
const { config } = await import('../src/config.js');
const { db } = await import('../src/db.js');

test('heat tiers by age: Ultra Hot 24 h, Hot 3 days, Warm a week, Luke Warm 2 weeks, Cold older', () => {
  const now = Date.UTC(2026, 9, 21), h = 3600000;
  const t = age => heat.tierOf({ site: 'truckit', posted_at: now - age, first_seen: now }, now);
  assert.equal(t(2 * h), 'ultra'); assert.equal(t(30 * h), 'hot'); assert.equal(t(5 * 24 * h), 'warm');
  assert.equal(t(10 * 24 * h), 'luke'); assert.equal(t(29 * 24 * h), 'cold');
  assert.equal(heat.tierOf({ site: 'loadshift', posted_at: null, first_seen: now }, now), 'unknown', 'Loadshift with no date: not mistaken for new');
  assert.equal(heat.dateFlag({ date_by: now - 3 * 24 * h }, now), 'passed');
  assert.equal(heat.dateFlag({ date_by: now + 24 * h, flexible: 0 }, now), null);
  assert.equal(heat.dateFlag({ flexible: 1 }, now), 'flexible');
});

test('job dates: Truckit windows, Loadshift ready/no date, Airtasker "Before ..." and flexible', () => {
  const rec = { status: 'active', item_label: 'Pallet', created_at: '1792526438', collection_date_view: 'Date Range', collection_date_earliest: '2026-12-01 00:00:00',
    collection_date_latest: '2026-12-05 00:00:00', delivery_date_latest: '2026-12-11 00:00:00', suburb1: 'FYSHWICK', state1: 'ACT', postcode1: '2609', suburb2: 'PARRAMATTA', state2: 'NSW', postcode2: '2150' };
  const j = truckitJob(rec);
  assert.equal(new Date(j.date_by).toISOString(), '2026-12-10T14:00:00.000Z', '11 Dec, Sydney time');
  assert.equal(j.flexible, false);
  assert.equal(truckitJob({ ...rec, collection_date_view: 'Flexible', collection_date_earliest: null, collection_date_latest: null, delivery_date_latest: null }).flexible, true);
  const [y, k] = loadshiftRowsFromText(['40778994', 'Machinery', '1', 'Excavator', '9000 kg', 'MacMasters Beach, NSW 2251', 'Kyogle, NSW 2474', '685 km', 'No date yet',
    '40720315', 'Machinery', '1', 'Komatsu', '-', 'Garbutt, QLD 4814', 'Charters Towers City, QLD 4820', '137 km', '20-Oct-26'].join('\n'));
  assert.equal(y.flexible, true); assert.equal(y.date_from, null);
  assert.equal(new Date(k.date_from).toISOString(), '2026-10-19T14:00:00.000Z'); assert.equal(k.flexible, false);
  const now = Date.UTC(2026, 9, 21);
  const a = jobFromCard(card('dd1', 'Move a fridge', 90, 'Fyshwick ACT 2609', 'Lyneham ACT 2602'), { ...AT, now });
  const b = jobFromCard({ ...card('dd2', 'Move a bed', 90, 'Fyshwick ACT 2609', 'Lyneham ACT 2602'), text: 'Move a bed\n$90\nFyshwick ACT 2609\nBefore Fri, 31 Oct\nPosted 2 days ago' }, { ...AT, now });
  assert.equal(b.due_text, 'to be done before 31 Oct'); assert.equal(new Date(b.date_by).toISOString(), '2026-10-30T14:00:00.000Z');
  assert.equal(a.date_by, null);
});

test('Loadshift post dates worked out from load numbers we watched appear', () => {
  const H = 3600000, t0 = Date.UTC(2026, 9, 20);
  // 40 loads an hour; we watched loads 40800000.. appear over 10 hours
  const pts = Array.from({ length: 30 }, (_, i) => ({ id: 40800000 + i * 13, t: t0 + (i * 13 / 40) * H }));
  pts.push({ id: 40800050, t: t0 + 9 * H }); // an odd one
  const line = heat.fitIdTime(pts);
  assert.ok(line);
  assert.ok(Math.abs(line.at(40800000 - 40 * 24 * 10) - (t0 - 10 * 24 * H)) < 6 * H, 'a load 9,600 numbers older is ~10 days old');
  assert.equal(heat.fitIdTime(pts.slice(0, 3)), null, 'too few to tell');

  // in the store: watched (fresh) loads anchor the line, the rest get estimated
  const now = t0 + 12 * H;
  for (let i = 0; i < 10; i++) upsertJob({ site: 'loadshift', ext_id: String(40800000 + i * 40), title: 'Load', status: 'open' }, t0 + i * H, { fresh: true });
  upsertJob({ site: 'loadshift', ext_id: '40790400', title: 'Old load', status: 'open' }, now);          // seen first in a full read
  assert.equal(fq.job.get('loadshift:40790400').posted_at, null);
  assert.equal(fq.job.get('loadshift:40800040').age_basis, 'seen');
  loop.datePosts(now);
  const old = fq.job.get('loadshift:40790400');
  assert.equal(old.age_basis, 'est');
  assert.ok(Math.abs(old.posted_at - (t0 - 240 * H)) < 12 * H, `~10 days old (${(now - old.posted_at) / 864e5} d)`);
  assert.equal(heat.tierOf(old, now), 'luke', '10.5 days: Luke Warm');
  // a later scan without a date keeps the estimate
  upsertJob({ site: 'loadshift', ext_id: '40790400', title: 'Old load', status: 'open' }, now + H);
  assert.equal(fq.job.get('loadshift:40790400').age_basis, 'est');
});

test('old jobs: swept boards keep them while listed; a complete full read retires the missing ones', async () => {
  const H = 3600000, now = Date.now();
  upsertJob({ site: 'truckit', ext_id: 'old1', title: 'Old pallet', posted_at: now - 20 * 24 * H, status: 'open' }, now - 30 * H);
  upsertJob({ site: 'airtasker', ext_id: 'x0old', title: 'Old couch', posted_at: now - 3 * 24 * H, status: 'open' }, now - 40 * H);
  loop.expireJobs(now);
  assert.equal(fq.job.get('truckit:old1').status, 'open', 'Truckit job seen 30 h ago stays: it is read in full nightly');
  assert.equal(fq.job.get('airtasker:x0old').status, 'gone', 'Airtasker job off the lists 40 h: gone');

  const { truckit, loadshift } = await import('../src/freight/sites.js');
  const real = truckit.sweep, realL = loadshift.sweep;
  truckit.sweep = async () => ({ jobs: [{ site: 'truckit', ext_id: 'keep1', title: 'Still listed', posted_at: now - 10 * 24 * H, status: 'open' }], complete: false, listed: 2000 });
  loadshift.sweep = async () => ({ jobs: [], complete: false, listed: null });
  try {
    await loop.sweepFreight({ force: true });
    assert.equal(fq.job.get('truckit:old1').status, 'open', 'an incomplete read marks nothing gone');
    truckit.sweep = async () => ({ jobs: [{ site: 'truckit', ext_id: 'keep1', title: 'Still listed', posted_at: now - 10 * 24 * H, status: 'open' }], complete: true, listed: 1 });
    await loop.sweepFreight({ force: true });
    assert.equal(fq.job.get('truckit:old1').status, 'gone', 'missing from a complete read: taken');
    assert.equal(fq.job.get('truckit:keep1').status, 'open');
    assert.equal(loop.sweepDue('truckit'), false, 'not again until tomorrow night');
  } finally { truckit.sweep = real; loadshift.sweep = realL; }
});

test('API: heat filter and counts; contacting a shipper (details, log, done) shared between logins', async () => {
  const all = (await api('GET', '/api/freight/jobs')).json;
  assert.ok(all.heat.luke >= 1 && all.heat.ultra >= 1, JSON.stringify(all.heat));
  const keep = all.jobs.find(j => j.key === 'truckit:keep1');
  assert.equal(keep.heat, 'luke');
  const hot = (await api('GET', '/api/freight/jobs?heat=ultra,hot')).json;
  assert.ok(hot.jobs.length && hot.jobs.every(j => ['ultra', 'hot'].includes(j.heat)));
  assert.deepEqual(hot.heat, all.heat, 'counts cover every tier whatever is shown');

  const k = encodeURIComponent('truckit:keep1');
  assert.equal((await api('POST', `/api/freight/jobs/${k}/contact`, { phone: '12' })).status, 400);
  let r = await api('POST', `/api/freight/jobs/${k}/contact`, { name: 'Sam Smith', phone: '0412 345 678' });
  assert.equal(r.json.phone, '0412345678');
  r = await api('POST', `/api/freight/jobs/${k}/contact`, { method: 'text', outcome: 'quoted', quote: '$450', note: 'wants Thursday' });
  assert.equal(r.json.log[0].outcome, 'quoted'); assert.equal(r.json.log[0].quote, 450); assert.equal(r.json.log[0].by, 'Aaron');
  const mm = await (await realFetch(base + '/api/freight/jobs', { headers: H('matthew:m') })).json();
  const seen = mm.jobs.find(j => j.key === 'truckit:keep1');
  assert.equal(seen.contact.by, 'Aaron', 'Matthew sees Aaron already quoted it'); assert.equal(seen.contactPhone, '0412345678');
  r = await api('POST', `/api/freight/jobs/${k}/contact`, { method: 'call', outcome: 'already moved' });
  assert.equal(r.json.dead, true);
  const after = (await api('GET', '/api/freight/jobs')).json;
  assert.ok(!after.jobs.some(j => j.key === 'truckit:keep1'), 'already moved: off the board'); assert.equal(after.dead, 1);
  assert.ok((await api('GET', '/api/freight/jobs?dead=1')).json.jobs.some(j => j.key === 'truckit:keep1' && j.dead));
  await api('POST', `/api/freight/jobs/${k}/contact`, { dead: false });
  assert.ok((await api('GET', '/api/freight/jobs')).json.jobs.some(j => j.key === 'truckit:keep1'));

  // message template per login
  const m = (await api('GET', '/api/freight/message')).json;
  assert.match(m.template, /\{booking\}/); assert.equal(m.me, 'Aaron');
  await api('POST', '/api/freight/message', { template: 'Hi{name}, {me} here', day: 'Thursday' });
  const m2 = (await api('GET', '/api/freight/message')).json;
  assert.equal(m2.template, 'Hi{name}, {me} here'); assert.equal(m2.day, 'Thursday');
  assert.equal((await (await realFetch(base + '/api/freight/message', { headers: H('matthew:m') })).json()).template, m.template, "Matthew keeps his own");
});

// ---- quotes, the Katara Freight link (push out, convert back) ----
const quotes = await import('../src/freight/quotes.js');
const push = await import('../src/freight/push.js');

test('quotes: logged from the contact panel, won on "booked", fee by platform; the board shows them', async () => {
  upsertJob({ site: 'loadshift', ext_id: '40779001', title: 'Yanmar Excavator - 6m L (9T)', from_text: 'Fyshwick ACT 2609', to_text: 'Parramatta NSW 2150', km: 290,
    due_text: '9000 kg · qty 2 · ready 25 Oct', status: 'open' });
  const k = encodeURIComponent('loadshift:40779001');
  await api('POST', `/api/freight/jobs/${k}/contact`, { name: 'Sam', phone: '0412 345 678' });
  await api('POST', `/api/freight/jobs/${k}/contact`, { method: 'call', outcome: 'quoted' });          // no amount: nothing to track
  assert.equal((await api('GET', '/api/freight/quotes')).json.quotes.filter(q => q.jobKey === 'loadshift:40779001').length, 0);
  await api('POST', `/api/freight/jobs/${k}/contact`, { method: 'call', outcome: 'quoted', quote: '$1,500' });
  let list = (await api('GET', '/api/freight/quotes')).json;
  let q = list.quotes.find(x => x.jobKey === 'loadshift:40779001');
  assert.equal(q.status, 'quoted'); assert.equal(q.amount, 1500); assert.equal(q.feePct, 10); assert.equal(q.fee, 150); assert.equal(q.net, 1350);
  assert.equal(q.load.weight, '9000 kg'); assert.equal(q.load.qty, 2); assert.equal(q.source.ref, '40779001'); assert.equal(q.customer.phone, '0412345678');
  assert.deepEqual([q.pickup.suburb, q.pickup.state, q.pickup.postcode], ['Fyshwick', 'ACT', '2609']);
  assert.equal(list.summary.open, 2, 'this one and the Truckit job quoted earlier');
  const board = (await api('GET', '/api/freight/jobs')).json.jobs.find(j => j.key === 'loadshift:40779001');
  assert.deepEqual([board.quote.status, board.quote.amount, board.quote.by], ['quoted', 1500, 'Aaron']);
  // re-quoting updates the same quote; "booked" wins it
  await api('POST', `/api/freight/jobs/${k}/contact`, { method: 'call', outcome: 'quoted', quote: '1400' });
  await api('POST', `/api/freight/jobs/${k}/contact`, { method: 'call', outcome: 'booked' });
  list = (await api('GET', '/api/freight/quotes')).json;
  q = list.quotes.filter(x => x.jobKey === 'loadshift:40779001');
  assert.equal(q.length, 1); assert.equal(q[0].status, 'won'); assert.equal(q[0].amount, 1400); assert.ok(q[0].wonAt);
  assert.equal((await api('PATCH', `/api/freight/quotes/${q[0].id}`, { pickup_date: '2026-10-25' })).json.quote.pickupDate, '2026-10-25');
  assert.equal((await api('PATCH', `/api/freight/quotes/${q[0].id}`, { status: 'converted' })).status, 400, 'only Katara Freight converts');
});

test('API v1: key only, quotes out, convert back (safe to repeat, other job refused)', async () => {
  const noKey = await realFetch(base + '/api/v1/quotes');
  assert.equal(noKey.status, 503, 'no key made yet');
  const made = (await api('POST', '/api/freight/apikey')).json;
  assert.match(made.key, /^kmr_/);
  assert.equal((await api('GET', '/api/freight/apikey')).json.key, undefined, 'shown once');
  const K = { authorization: 'Bearer ' + made.key, 'content-type': 'application/json' };
  assert.equal((await realFetch(base + '/api/v1/quotes', { headers: { authorization: 'Bearer kmr_wrong' } })).status, 401);
  assert.equal((await realFetch(base + '/api/v1/quotes', { headers: H('aaron:a') })).status, 401, 'dashboard logins do not open the API');
  const out = await (await realFetch(base + '/api/v1/quotes?status=won', { headers: K })).json();
  assert.equal(out.quotes.length, 1);
  const q = out.quotes[0];
  assert.equal(q.links.convert, `${base}/api/v1/quotes/${q.id}/convert`);
  const conv = (body) => realFetch(`${base}/api/v1/quotes/${q.id}/convert`, { method: 'POST', headers: K, body: JSON.stringify(body) });
  assert.equal((await conv({})).status, 400);
  let r = await (await conv({ jobId: 7, jobNo: 'KF-261025-01', url: 'https://katarafreight.com.au/tools/jobs#edit=7' })).json();
  assert.equal(r.quote.status, 'converted'); assert.deepEqual([r.quote.job.id, r.quote.job.no], ['7', 'KF-261025-01']);
  r = await (await conv({ jobId: 7 })).json();
  assert.equal(r.already, true);
  assert.equal((await conv({ jobId: 8 })).status, 409);
  // unlink (job deleted over there) puts it back to won
  const back = (await api('PATCH', `/api/freight/quotes/${q.id}`, { status: 'won' })).json.quote;
  assert.equal(back.status, 'won'); assert.equal(back.job, null);
});

test('push: quotes go to Katara Freight with the key; retried with a growing wait when it fails', async () => {
  const sent = [];
  let fail = true;
  push._setFetch(async (url, init) => {
    sent.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
    return fail ? new Response('down', { status: 502 }) : new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  push.queueAll();
  const now = Date.now() + 5;   // everything queued so far is due
  assert.equal(await push.flushQuotes(now), 0);
  assert.equal(sent[0].url, 'https://katarafreight.com.au/api/imports/quotes');
  assert.match(sent[0].auth, /^Bearer kmr_/);
  assert.ok(sent[0].body.quotes.length >= 2 && sent[0].body.source === 'kamrads', JSON.stringify(sent[0].body).slice(0, 300));
  assert.match(push.outboxInfo().lastError, /HTTP 502/);
  assert.equal(await push.flushQuotes(now + 30000), 0, 'waits before trying again');
  assert.equal(sent.length, 1);
  fail = false;
  assert.ok(await push.flushQuotes(now + 61000) >= 2);
  assert.equal(push.outboxInfo().queued, 0);
  // a change re-queues just that quote
  const one = quotes.listQuotes().find(x => x.status === 'won');
  quotes.update(one.id, { notes: 'pallet jack needed' });
  await push.flushQuotes(Date.now() + 1000);
  const last = sent.at(-1).body.quotes;
  assert.equal(last.length, 1); assert.equal(last[0].notes, 'pallet jack needed');
});

test('a quote from a pasted link: Airtasker task we never listed, or a Loadshift number', async () => {
  const link = 'https://www.airtasker.com/tasks/help-me-move-home-x01m5ecj2g3gyhsc43rcvgd5hq9/';
  const r = await api('POST', '/api/freight/quotes', { link, amount: '$480' });
  assert.equal(r.status, 200); assert.equal(r.json.jobKey, 'airtasker:x01m5ecj2g3gyhsc43rcvgd5hq9');
  const q = (await api('GET', '/api/freight/quotes')).json.quotes.find(x => x.jobKey === r.json.jobKey);
  assert.equal(q.load.title, 'Help me move home'); assert.equal(q.feePct, 22); assert.equal(q.amount, 480);
  assert.equal((await api('POST', '/api/freight/quotes', { link: link.replace('www.', ''), amount: 500 })).json.jobKey, r.json.jobKey, 'same task: same job, quote updated');
  assert.equal((await api('POST', '/api/freight/quotes', { link: '40779001', amount: 1450 })).json.jobKey, 'loadshift:40779001');
  assert.equal((await api('POST', '/api/freight/quotes', { link: '99999999', amount: 10 })).status, 400);
  assert.equal((await api('POST', '/api/freight/quotes', { link: 'https://example.com/x', amount: 10 })).status, 400);
  assert.equal((await api('POST', '/api/freight/quotes', { link, amount: '' })).status, 400, 'needs a price');
});
