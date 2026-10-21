import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kamrads-'));
const { classify } = await import('../src/alerts.js');
const { upsertLot, q } = await import('../src/db.js');
const { dueForRefresh } = await import('../src/scheduler.js');

const NOW = Date.parse('2026-10-20T03:00:00Z');
const lot = o => ({ status: 'open', starred: 0, last_checked: NOW - 30000, wovr: null, bid: null, start_price: null, end_at: NOW + 8 * 60000, url: 'https://www.pickles.com.au/used/details/trucks/x/1', ...o });

test("Aaron's Isuzu: $2,200 at T-8 with a $15k estimate is a sleeper", () => {
  const hit = classify(lot({ site: 'pickles', bid: 2200, manual_estimate: 15000, title: '2011 Isuzu NPR 400' }), NOW);
  assert.equal(hit.kind, 'sleeper');
  assert.match(hit.why, /\d+% of est \$15,000 \(incl\. \$[\d,]+ fees\)/);
});

test('no estimate: a cheap vehicle still alerts at T-10', () => {
  assert.equal(classify(lot({ bid: 2200 }), NOW).kind, 'cheap');
});

test('no alert outside the final 10 minutes, or when the price has caught up', () => {
  assert.equal(classify(lot({ bid: 2200, end_at: NOW + 30 * 60000 }), NOW), null);
  assert.equal(classify(lot({ bid: 9000, manual_estimate: 15000 }), NOW), null);
});

test('never alerts on stale listing data', () => {
  assert.equal(classify(lot({ bid: 2200, last_checked: NOW - 10 * 60000 }), NOW), null);
  assert.equal(classify(lot({ bid: 2200, last_checked: null }), NOW), null);
});

test('statutory write-offs are skipped unless starred', () => {
  assert.equal(classify(lot({ bid: 300, wovr: 'Statutory Write-Off' }), NOW), null);
  assert.equal(classify(lot({ bid: 300, wovr: 'Statutory Write-Off', starred: 1 }), NOW).kind, 'watched');
});

test('penny lots: tools and equipment yes, paint and household no', () => {
  assert.equal(classify(lot({ bid: 2, title: 'Makita 18V drill kit', url: 'https://www.pickles.com.au/used/details/general-goods/x/2' }), NOW).kind, 'penny');
  assert.equal(classify(lot({ bid: 2, title: 'Dulux Wash & Wear paint 10L', url: 'https://www.pickles.com.au/used/details/general-goods/x/3' }), NOW), null);
});

test('db merge keeps known values and records bid history', () => {
  upsertLot({ site: 'pickles', ext_id: '62430579', title: 'Isuzu', bid: 2000, odometer: 288400, url: 'https://x/1' });
  upsertLot({ site: 'pickles', ext_id: '62430579', bid: 2200, odometer: null });
  const row = q.lot.get('pickles:62430579');
  assert.equal(row.bid, 2200);
  assert.equal(row.odometer, 288400);
  assert.deepEqual(q.bidHistory.all('pickles:62430579').map(b => b.bid), [2000, 2200]);
});

test('refresh queue: closing-soon lots first, expensive ones skipped', () => {
  const now = Date.now();
  upsertLot({ site: 'pickles', ext_id: 'A', title: 'soon', bid: 500, end_at: now + 5 * 60000, url: 'https://x/a' });
  upsertLot({ site: 'pickles', ext_id: 'B', title: 'later', bid: 500, end_at: now + 50 * 60000, url: 'https://x/b' });
  upsertLot({ site: 'pickles', ext_id: 'C', title: 'pricey', bid: 90000, end_at: now + 4 * 60000, url: 'https://x/c' });
  upsertLot({ site: 'manheim', ext_id: 'D', title: 'tomorrow', bid: 10, end_at: now + 26 * 3600000, url: 'https://x/d' });
  assert.deepEqual(dueForRefresh(now).map(l => l.ext_id), ['A', 'B']);
});

test('final price: a lot just past its close gets one last read, then is closed with that price', () => {
  const now = Date.now();
  upsertLot({ site: 'pickles', ext_id: 'F', title: 'just closed', bid: 800, end_at: now - 60000, url: 'https://x/f' });
  assert.equal(dueForRefresh(now)[0].ext_id, 'F', 'final read goes first');
  upsertLot({ site: 'pickles', ext_id: 'F', bid: 950 }, { checked: true });
  assert.ok(!dueForRefresh(Date.now()).some(l => l.ext_id === 'F'), 'only one final read');
  q.closeDue.all(Date.now(), Date.now() + 1);
  const row = q.lot.get('pickles:F');
  assert.equal(row.status, 'closed');
  assert.equal(row.final_bid, 950);
  assert.ok(row.final_seen_at >= now);
});

test('watchlist: add by link, re-checked every 60 s however far from close', async () => {
  const { watchUrl } = await import('../src/scheduler.js');
  const key = watchUrl('https://www.allbids.com.au/c/antiques-art-memorabilia/collectible-watches/seiko-5-sports-supercars-2023-limited-edition-number-1678197');
  assert.equal(key, 'allbids:1678197');
  assert.throws(() => watchUrl('https://example.com/whatever'), /not a lot page/);
  const now = Date.now();
  // a starred lot closing in 3 days, last checked 2 minutes ago -> due; checked 10 s ago -> not due
  upsertLot({ site: 'pickles', ext_id: 'W', title: 'watched', bid: 99000, end_at: now + 3 * 86400000, url: 'https://x/w' });
  q.star.run(1, 'pickles:W');
  db().prepare('UPDATE lots SET last_checked = ? WHERE key = ?').run(now - 120000, 'pickles:W');
  assert.ok(dueForRefresh(now).some(l => l.ext_id === 'W'), 'due after 60 s');
  db().prepare('UPDATE lots SET last_checked = ? WHERE key = ?').run(now - 10000, 'pickles:W');
  assert.ok(!dueForRefresh(now).some(l => l.ext_id === 'W'), 'not due again within 60 s');
  assert.ok(dueForRefresh(now).some(l => l.key === 'allbids:1678197'), 'new link read straight away');
});
const db = () => dbMod.db;
const dbMod = await import('../src/db.js');

test('a blank title never overwrites or blocks a real one', () => {
  upsertLot({ site: 'allbids', ext_id: '1678440', title: '', url: 'https://www.allbids.com.au/c/computers-it/processors/intel-xeon-silver-4110-210ghz300ghz-8core-server-cpu-lot-of-four-1678440' });
  assert.equal(q.lot.get('allbids:1678440').title, null);
  upsertLot({ site: 'allbids', ext_id: '1678440', title: 'Intel Xeon Silver 4110 Server CPU (Lot of Four)' });
  upsertLot({ site: 'allbids', ext_id: '1678440', title: '   ' });
  assert.equal(q.lot.get('allbids:1678440').title, 'Intel Xeon Silver 4110 Server CPU (Lot of Four)');
});

test('final minutes: a lot on a fast feed is re-read every ~10 s', async () => {
  const fast = await import('../src/fast.js');
  const now = Date.now();
  upsertLot({ site: 'allbids', ext_id: 'Z9', title: 'closing', bid: 20, end_at: now + 2 * 60000, url: 'https://x/z9' });
  dbMod.db.prepare('UPDATE lots SET last_checked = ? WHERE key = ?').run(now - 12000, 'allbids:Z9');
  assert.ok(!dueForRefresh(now).some(l => l.ext_id === 'Z9'), 'without a feed: 30 s cadence');
  const feedsFile = (await import('node:path')).join(process.env.DATA_DIR, 'fast-feeds.json');
  fast.learn('allbids', '555', { json: [{ url: 'https://www.allbids.com.au/api/a/555', body: { aucID: 555, aucTitle: 'x', aucCurrentBid: 5 } }] });
  assert.ok(fast.hasFeed('allbids') && fs.existsSync(feedsFile));
  assert.ok(dueForRefresh(now).some(l => l.ext_id === 'Z9'), 'with a feed: due after 10 s');
  fast.forget('allbids');
});

test('lots closing later today get a light check every few hours; a lot sold early is closed', async () => {
  const { factsFromText } = await import('../src/extract.js');
  assert.equal(factsFromText('2012 Holden Barina\nSOLD\nNo longer available').gone, true);
  assert.equal(factsFromText('Current bid $110\nEnds in 06:00:00').gone, undefined);
  const now = Date.now();
  upsertLot({ site: 'pickles', ext_id: '62447142', title: '2012 Holden Barina', bid: 110, end_at: now + 6 * 3600000, url: 'https://www.pickles.com.au/used/details/cars/2012-holden-barina/62447142' });
  assert.ok(dueForRefresh(now).some(l => l.ext_id === '62447142'), 'never checked: due');
  dbMod.db.prepare('UPDATE lots SET last_checked = ? WHERE key = ?').run(now - 3600000, 'pickles:62447142');
  assert.ok(!dueForRefresh(now).some(l => l.ext_id === '62447142'), 'checked an hour ago: not yet');
  q.closeEarly.run(now - 3600000, now, now, now, 'pickles:62447142');
  const row = q.lot.get('pickles:62447142');
  assert.equal(row.status, 'closed'); assert.equal(row.ended_early, 1); assert.equal(row.final_bid, 110);
  assert.ok(row.end_at <= now, 'close time moved to when it actually ended');
});

test('live-lane lots: no countdown alerts, placeholder 11:59:59 pm close recognised', async () => {
  const { isLiveSale } = await import('../src/live.js');
  const t = Date.parse('2026-10-21T15:59:59Z'); // 23:59:59 in Perth
  assert.equal(isLiveSale({ buy_method: 'Pickles Live' }), true);
  assert.equal(isLiveSale({ end_at: t }), true);
  assert.equal(isLiveSale({ buy_method: 'Pickles Online', end_at: Date.parse('2026-10-21T08:30:00Z') }), false);
  assert.equal(classify(lot({ bid: 900, buy_method: 'Pickles Live' }), NOW), null);
  upsertLot({ site: 'pickles', ext_id: '62447199', title: 'x', bid: 0, url: 'https://x/z' });
  assert.equal(q.lot.get('pickles:62447199').bid, null, '$0 means no bid');
});

test('a big Lloyds sale closing: at most 6 reads a cycle, vehicles before wine; a 429 pauses the site', async () => {
  const pz = await import('../src/pause.js');
  const now = Date.now();
  for (let i = 0; i < 40; i++) upsertLot({ site: 'lloyds', ext_id: `W${i}`, title: `Shiraz 2013 750ML lot ${i}`, bid: 5, end_at: now + 60000 + i * 1000, url: `https://x/w${i}` });
  upsertLot({ site: 'lloyds', ext_id: 'UTE', title: '2012 Toyota Hilux SR', category: 'cars', bid: 3000, end_at: now + 170000, url: 'https://x/ute' });
  const due = dueForRefresh(now).filter(l => l.site === 'lloyds');
  assert.equal(due.length, 6, 'capped');
  assert.equal(due[0].ext_id, 'UTE', 'the ute before the wine, though it closes later');
  pz.pause('lloyds', 'HTTP 429', now);
  assert.equal(dueForRefresh(now).filter(l => l.site === 'lloyds').length, 0, 'paused');
  assert.ok(pz.pausedUntil('lloyds') - now >= 2 * 60000);
  assert.ok(pz.isRateLimit('blocked by Lloyds (HTTP 429)'));
  assert.equal(dueForRefresh(now + 3 * 60000).filter(l => l.site === 'lloyds').length, 6, 'back after the pause');
  pz._reset();
});

test('soft close: not called sold without a read after its close; a moving bid means extended; recent unread closes reopened', async () => {
  const sch = await import('../src/scheduler.js');
  const { db } = await import('../src/db.js');
  const now = Date.now();
  upsertLot({ site: 'grays', ext_id: '0036-23502706', title: '2008 BMW X5 si Petrol', category: 'cars', bid: 1009, end_at: now - 10 * 60000, url: 'https://www.grays.com/lot/0036-23502706/x' });
  upsertLot({ site: 'grays', ext_id: '0036-23502706', bid: 1009 }, { checked: true });
  db.prepare("UPDATE lots SET last_checked = ? WHERE key = 'grays:0036-23502706'").run(now - 40 * 60000);
  q.closeConfirmed.all(now, now - 6 * 60000, now - 120 * 60000);
  assert.equal(q.lot.get('grays:0036-23502706').status, 'open', 'no read since its close: still open');
  assert.ok(dueForRefresh(now).some(l => l.key === 'grays:0036-23502706'), 'and queued for that read');
  db.prepare("UPDATE lots SET last_checked = ? WHERE key = 'grays:0036-23502706'").run(now);
  q.closeConfirmed.all(now + 1, now - 6 * 60000, now - 120 * 60000);
  assert.equal(q.lot.get('grays:0036-23502706').status, 'closed', 'read after close: closed');
  // a lot closed the old way (no read after close) is reopened on start
  upsertLot({ site: 'grays', ext_id: '0036-23502707', title: '2012 Ford Territory', category: 'cars', bid: 409, end_at: now - 30 * 60000, url: 'https://www.grays.com/lot/0036-23502707/x' });
  db.prepare("UPDATE lots SET status = 'closed', final_bid = 409, last_checked = ?, closed_at = ? WHERE key = 'grays:0036-23502707'").run(now - 70 * 60000, now - 20 * 60000);
  assert.ok(sch.reopenUnconfirmed(now) >= 1);
  assert.equal(q.lot.get('grays:0036-23502707').status, 'open');
  const { factsFromText } = await import('../src/extract.js');
  assert.equal(factsFromText('Bidding has closed. Final bid $1,850').closed, true);
  assert.equal(factsFromText('Time Left 0d 0h 4m 10s Current Bid $1,809').closed, undefined);
});
