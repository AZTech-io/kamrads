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
  const hit = classify(lot({ bid: 2200, manual_estimate: 15000, title: '2011 Isuzu NPR 400' }), NOW);
  assert.equal(hit.kind, 'sleeper');
  assert.match(hit.why, /15%/);
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

test('penny lots on general goods', () => {
  assert.equal(classify(lot({ bid: 2, url: 'https://www.pickles.com.au/used/details/general-goods/x/2' }), NOW).kind, 'penny');
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
