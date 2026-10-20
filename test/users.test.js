// Logins, per-user watchlists, "my bid" winning/outbid, saved searches, missed deals, CSV export.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kamrads-users-'));
process.env.DASH_USER = 'aaron';
process.env.DASH_PASS = 'a-pass';
process.env.DASH_USERS = 'matthew:m-pass';
process.env.PORT = '18787';
process.env.HOST = '127.0.0.1';
process.env.NTFY_URL = 'https://ntfy.test/shared';

// Capture pushes instead of sending them
const pushes = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://ntfy.test/')) { const h = opts.headers?.Title || ''; const m = /^=\?UTF-8\?B\?(.+)\?=$/.exec(h); pushes.push({ url: String(url), title: m ? Buffer.from(m[1], 'base64').toString() : h, body: opts.body }); return new Response('ok'); }
  return realFetch(url, opts);
};

const { upsertLot, q } = await import('../src/db.js');
const { bidStatus, checkBidders, announceResult } = await import('../src/users.js');
const { compile, addSearch, runSearches, searchFinalAlert } = await import('../src/searches.js');
const settings = await import('../src/settings.js');
const { startServer } = await import('../src/server.js');
startServer();
await new Promise(r => setTimeout(r, 300));

const base = 'http://127.0.0.1:18787';
const auth = u => ({ authorization: 'Basic ' + Buffer.from(u).toString('base64'), 'content-type': 'application/json' });
const AARON = auth('aaron:a-pass'), MATT = auth('Matthew:m-pass');
const api = async (method, p, who, body) => {
  const r = await realFetch(base + p, { method, headers: who, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, json: (() => { try { return JSON.parse(t); } catch { return t; } })() };
};
const now = Date.now();

test('bid status: proxy bidding means price at or under your max = winning', () => {
  assert.equal(bidStatus({ status: 'open', bid: 4200 }, 5000), 'winning');
  assert.equal(bidStatus({ status: 'open', bid: 5000 }, 5000), 'atmax');
  assert.equal(bidStatus({ status: 'open', bid: 5250 }, 5000), 'outbid');
  assert.equal(bidStatus({ status: 'open', bid: null }, 5000), 'nobids');
  assert.equal(bidStatus({ status: 'closed', final_bid: 4800 }, 5000), 'won');
  assert.equal(bidStatus({ status: 'closed', final_bid: 5100 }, 5000), 'lost');
  assert.equal(bidStatus({ status: 'open', bid: 100 }, null), null);
});

test('logins: wrong password refused, each person has their own name', async () => {
  assert.equal((await api('GET', '/api/me', auth('aaron:nope'))).status, 401);
  assert.equal((await api('GET', '/api/me', AARON)).json.user, 'aaron');
  assert.equal((await api('GET', '/api/me', MATT)).json.user, 'matthew', 'usernames are not case sensitive');
});

test('watchlists and bids are separate per person', async () => {
  upsertLot({ site: 'pickles', ext_id: '70000001', title: '2016 Renault Master Van', bid: 3000, end_at: now + 3600000, url: 'https://www.pickles.com.au/used/details/vans/x/70000001' });
  const key = 'pickles:70000001';
  assert.equal((await api('POST', `/api/lots/${key}/star`, AARON, { starred: true })).status, 200);
  assert.equal((await api('POST', `/api/lots/${key}/mybid`, MATT, { value: '$5,000' })).status, 200);
  const a = (await api('GET', '/api/watchlist', AARON)).json.lots;
  const m = (await api('GET', '/api/watchlist', MATT)).json.lots;
  assert.equal(a.length, 1); assert.equal(a[0].myBid, null); assert.deepEqual(a[0].others, ['matthew']);
  assert.equal(m.length, 1, 'setting a bid also watches the lot'); assert.equal(m[0].myBid, 5000); assert.equal(m[0].bidStatus, 'winning');
  const lots = (await api('GET', '/api/lots', AARON)).json.lots;
  assert.equal(lots.find(l => l.key === key).starred, true);
  // Aaron un-stars: Matthew still watches, so it keeps its 60 s re-checks
  await api('POST', `/api/lots/${key}/star`, AARON, { starred: false });
  assert.equal((await api('GET', '/api/watchlist', AARON)).json.lots.length, 0);
  assert.equal(q.lot.get(key).starred, 1);
  assert.equal((await api('POST', `/api/lots/${key}/mybid`, MATT, { value: 'abc' })).status, 400);
});

test('outbid: one push to the bidder, re-armed when they raise their bid; result at close', async () => {
  const key = 'pickles:70000001';
  settings.setUser('matthew', { ntfyUrl: 'https://ntfy.test/matthew' });
  pushes.length = 0;
  upsertLot({ site: 'pickles', ext_id: '70000001', bid: 5500 }, { checked: true });
  await checkBidders(q.lot.get(key));
  await checkBidders(q.lot.get(key));
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].url, 'https://ntfy.test/matthew', "goes to Matthew's own phone");
  assert.match(pushes[0].title, /OUTBID: now \$5,500 \(your max \$5,000\)/);
  await api('POST', `/api/lots/${key}/mybid`, MATT, { value: 6000 });
  assert.equal((await api('GET', '/api/watchlist', MATT)).json.lots[0].bidStatus, 'winning');
  upsertLot({ site: 'pickles', ext_id: '70000001', bid: 6100 }, { checked: true });
  await checkBidders(q.lot.get(key));
  assert.equal(pushes.length, 2, 'outbid again after raising');
  q.closeDue.all(Date.now(), Date.now() + 7200000);
  await announceResult(q.lot.get(key));
  assert.match(pushes[2].title, /^Lost/);
});

test('saved search: terms, plurals, exclusions', () => {
  const t = compile('renault master, mercedes sprinter, van -crash');
  assert.ok(t('2016 Renault Master Long Wheelbase'));
  assert.ok(t('2019 Mercedes-Benz Sprinter 316'.replace(/-/g, ' ')));
  assert.ok(t('Toyota Hiace Van'));
  assert.ok(t('cars vans'), 'plural');
  assert.ok(!t('Renault Kangoo'));
  assert.ok(!t('Vanity unit'), 'whole words only');
  assert.ok(!t('Ford Transit Van crash damaged'));
});

test('saved search: existing lots counted without a push, new ones pushed once, final-minutes alert under max price', async () => {
  upsertLot({ site: 'allbids', ext_id: '2000001', title: '2018 Mercedes-Benz Sprinter 316 CDI', bid: 7000, end_at: now + 7200000, url: 'https://www.allbids.com.au/c/x/sprinter-2000001' });
  const r = await api('POST', '/api/searches', AARON, { terms: 'sprinter, renault master', maxPrice: '$8,000' });
  assert.equal(r.status, 200);
  assert.equal(r.json.matches, 1, 'the Sprinter already listed, plus the Master closed earlier is not open');
  pushes.length = 0;
  await runSearches();
  assert.equal(pushes.length, 0, 'no flood for lots that were already there');
  upsertLot({ site: 'lloyds', ext_id: '6100001', title: '2017 Renault Master Van', bid: 2500, end_at: now + 8 * 60000, url: 'https://www.lloydsonline.com.au/LotDetails.aspx?smode=0&aid=1&lid=6100001' });
  upsertLot({ site: 'lloyds', ext_id: '6100002', title: 'Office chair', bid: 5, end_at: now + 8 * 60000, url: 'https://www.lloydsonline.com.au/LotDetails.aspx?smode=0&aid=1&lid=6100002' });
  await runSearches();
  await runSearches();
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].title, /1 new match: sprinter, renault master/);
  assert.equal(pushes[0].url, 'https://ntfy.test/shared', 'Aaron has no own link: shared one, with his name');
  assert.match(pushes[0].title, /^\[aaron\]/);
  const list = (await api('GET', '/api/searches', AARON)).json;
  assert.equal(list[0].matches, 2);
  assert.equal((await api('GET', '/api/searches', MATT)).json.length, 0, "Matthew doesn't see Aaron's searches");
  // final minutes, fresh price under the max
  upsertLot({ site: 'lloyds', ext_id: '6100001', bid: 2600 }, { checked: true });
  await searchFinalAlert(q.lot.get('lloyds:6100001'));
  await searchFinalAlert(q.lot.get('lloyds:6100001'));
  assert.equal(pushes.length, 2);
  assert.match(pushes[1].title, /MATCH: 8 min left · \$2,600 \(under your \$8,000\)/);
  assert.equal((await api('DELETE', `/api/searches/${list[0].id}`, MATT)).status, 200);
  assert.equal((await api('GET', '/api/searches', AARON)).json.length, 1, "Matthew can't delete Aaron's search");
});

test('missed deals: cheap closes shown, ones you won and stale prices left out; CSV export', async () => {
  const t = Date.now();
  const closeAt = (id, title, bid, extra = {}) => {
    upsertLot({ site: 'allbids', ext_id: id, title, bid, end_at: t - 1000, url: `https://www.allbids.com.au/c/x/y-${id}`, ...extra });
    q.lot.get(`allbids:${id}`);
  };
  closeAt('3000001', '2012 Toyota Corolla', 1500, { category: 'motor-vehicles-cars' });
  closeAt('3000002', '2015 Ford Ranger', 9000);
  closeAt('3000003', 'Laptop', 2);
  closeAt('3000004', '2010 Hyundai iLoad', 1200);
  dbm.db.prepare(`UPDATE lots SET last_checked = ? WHERE key LIKE 'allbids:300000%'`).run(t - 30000);
  dbm.db.prepare(`UPDATE lots SET manual_estimate = 20000, category = 'cars' WHERE key = 'allbids:3000002'`).run();
  dbm.db.prepare(`UPDATE lots SET last_checked = ? WHERE key = 'allbids:3000004'`).run(t - 40 * 60000);
  for (const k of ['allbids:3000001']) await api('POST', `/api/lots/${k}/mybid`, AARON, { value: 2000 });
  q.closeDue.all(t, t);
  const missed = (await api('GET', '/api/missed?days=7', AARON)).json.lots;
  const titles = missed.map(l => l.title);
  assert.ok(titles.includes('2015 Ford Ranger'), '45% of estimate');
  assert.ok(titles.includes('Laptop'), 'penny lot');
  assert.ok(!titles.includes('2012 Toyota Corolla'), 'Aaron won the Corolla, so not missed');
  assert.ok(!titles.includes('2010 Hyundai iLoad'), 'last seen 40 min before close: price unknown');
  assert.equal(missed[0].title, '2015 Ford Ranger', 'biggest saving first');
  const mattMissed = (await api('GET', '/api/missed?days=7', MATT)).json.lots.map(l => l.title);
  assert.ok(mattMissed.includes('2012 Toyota Corolla'), "for Matthew it's a missed deal (vehicle under $3k)");
  const csv = await realFetch(base + '/api/export/closed.csv?days=30', { headers: AARON });
  const text = await csv.text();
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(text.split('\n')[0], /^site,ext_id,title/);
  assert.match(text, /2015 Ford Ranger,cars/);
});
const dbm = await import('../src/db.js');

test.after(() => setTimeout(() => process.exit(0), 50));
