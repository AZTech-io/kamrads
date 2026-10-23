import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kamrads-'));
process.env.GEOCODE = 'false';
const { upsertLot, q, db } = await import('../src/db.js');
const { adapters, settleResults } = await import('../src/scheduler.js');

test('Grays: a lot we called sold at its listed close is re-read; the page now says "Sold for" so the real hammer price replaces ours', async () => {
  const now = Date.now();
  upsertLot({ site: 'grays', ext_id: '0012-23502559', title: '2007 Mitsubishi Fighter FM 600 Curtainsider', bid: 7199, end_at: now - 5 * 3600000, url: 'https://www.grays.com/lot/0012-23502559/x', reserve: 'not met' });
  db.prepare(`UPDATE lots SET status = 'closed', final_bid = 7199, final_seen_at = ?, closed_at = ?, last_checked = ? WHERE key = 'grays:0012-23502559'`).run(now - 4.9 * 3600000, now - 4.9 * 3600000, now - 3 * 3600000);
  const orig = adapters.grays.refresh;
  adapters.grays.refresh = async () => ({ bid: 11299, bid_count: 153, closed: true, reserve: 'met', end_at: now - 1.5 * 3600000 });
  try {
    const n = await settleResults(now);
    assert.equal(n, 1);
    const l = q.lot.get('grays:0012-23502559');
    assert.equal(l.status, 'closed'); assert.equal(l.final_bid, 11299); assert.equal(l.reserve, 'met'); assert.equal(l.said_closed, 1);
    assert.equal(l.end_at, now - 1.5 * 3600000);
    // settled: not read again
    adapters.grays.refresh = async () => { throw new Error('should not be read again'); };
    assert.equal(await settleResults(now + 3 * 3600000), 0);
  } finally { adapters.grays.refresh = orig; }
});

test('Grays: still running when re-read -> back on the board', async () => {
  const now = Date.now();
  upsertLot({ site: 'grays', ext_id: '0012-1', title: '1997 Isuzu FVM1400 Curtainsider', bid: 3000, end_at: now - 4 * 3600000, url: 'https://www.grays.com/lot/0012-1/x' });
  db.prepare(`UPDATE lots SET status = 'closed', final_bid = 3000, final_seen_at = ?, closed_at = ?, last_checked = ? WHERE key = 'grays:0012-1'`).run(now - 4 * 3600000, now - 4 * 3600000, now - 3 * 3600000);
  const orig = adapters.grays.refresh;
  adapters.grays.refresh = async () => ({ bid: 3500, bid_count: 12 });
  try {
    await settleResults(now);
    const l = q.lot.get('grays:0012-1');
    assert.equal(l.status, 'open'); assert.equal(l.final_bid, null); assert.equal(l.bid, 3500); assert.ok(l.end_at > now);
  } finally { adapters.grays.refresh = orig; }
});
