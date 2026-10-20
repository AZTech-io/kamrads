import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kamrads-r-'));
const settings = await import('../src/settings.js');
const { upsertLot, q } = await import('../src/db.js');
const { researchLot, estimatePending } = await import('../src/estimate.js');
const { classify } = await import('../src/alerts.js');

const calls = [];
function fakeClaude(replies) {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
    const r = replies.shift();
    return { ok: true, status: 200, text: async () => JSON.stringify(r) };
  };
}

test('settings: key saved from the dashboard, never shown in full, file locked down', () => {
  settings.set({ anthropicKey: 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' });
  const v = settings.publicView();
  assert.equal(v.anthropicKeySet, true);
  assert.equal(v.anthropicKeyMasked, 'sk-ant-…6789');
  assert.ok(!JSON.stringify(v).includes('ABCDEFGHIJ'));
  const mode = fs.statSync(path.join(process.env.DATA_DIR, 'settings.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('research: web search for comparables, then resale range, market average and sources stored', async () => {
  const now = Date.now();
  upsertLot({ site: 'allbids', ext_id: '1678283', title: '07/2010 Hyundai iLoad TQ Van 2.5L', year: 2010, make: 'Hyundai', model: 'iLoad',
    odometer: 245000, bid: 2400, end_at: now + 40 * 60000, url: 'https://www.carbids.com.au/c/x/hyundai-iload-1678283', category: 'allbids-car-auctions' });
  const lot = q.lot.get('allbids:1678283');
  fakeClaude([
    { stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: '2010 Hyundai iLoad' } }] },
    { stop_reason: 'end_turn', usage: { server_tool_use: { web_search_requests: 3 } }, content: [
      { type: 'text', text: 'Found listings.', citations: [{ type: 'web_search_result_location', url: 'https://www.carsales.com.au/cars/details/1', title: '2010 iLoad', cited_text: '$8,990' }] },
      { type: 'text', text: '{"market_avg": 9200, "resale_low": 6500, "resale_high": 8000, "confidence": "medium", "note": "4 carsales/gumtree iLoads 2009-2011, 200-280k km",'
        + ' "comparables": [{"title": "2010 Hyundai iLoad TQ", "price": 8990, "km": 231000, "url": "https://www.carsales.com.au/cars/details/1"},'
        + ' {"title": "2011 iLoad van", "price": 9500, "km": 260000, "url": "https://www.gumtree.com.au/s-ad/2"}, {"title": "bad", "url": "javascript:alert(1)"}]}' },
    ] },
  ]);
  const r = await researchLot(lot);
  assert.equal(r.avg, 9200);
  assert.deepEqual([r.low, r.high], [6500, 8000]);
  assert.equal(r.comps.length, 2, 'non-http links dropped');
  // request shape: web search tool, AU, vehicle sites only; pause_turn resent with the assistant content
  const first = calls[0].body;
  assert.equal(first.tools[0].type, 'web_search_20250305');
  assert.equal(first.tools[0].user_location.country, 'AU');
  assert.ok(first.tools[0].allowed_domains.includes('carsales.com.au'));
  assert.equal(calls[1].body.messages.at(-1).role, 'assistant');
  assert.equal(calls[0].headers['x-api-key'], 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  const row = q.lot.get('allbids:1678283');
  assert.equal(row.est_method, 'web');
  assert.equal(row.est_avg, 9200);
  assert.equal(JSON.parse(row.est_comps)[1].url, 'https://www.gumtree.com.au/s-ad/2');
  // $2,400 vs resale low $6,500 = 37%: not a SLEEPER (25%) but a vehicle under $3k with no estimate would have been CHEAP;
  // with research it is judged on value instead
  assert.equal(classify({ ...row, last_checked: Date.now(), end_at: Date.now() + 5 * 60000 }), null);
  assert.equal(classify({ ...row, bid: 1500, last_checked: Date.now(), end_at: Date.now() + 5 * 60000 }).kind, 'sleeper');
});

test('daily cap stops automatic lookups', async () => {
  settings.set({ researchPerDay: 1 });
  calls.length = 0;
  upsertLot({ site: 'pickles', ext_id: '777', title: '2015 Toyota Hilux', year: 2015, make: 'Toyota', odometer: 150000, bid: 9000,
    end_at: Date.now() + 60 * 60000, url: 'https://www.pickles.com.au/used/details/cars/x/777' });
  await estimatePending();
  assert.equal(calls.length, 0, 'one lookup already used today');
});

test('no key: research explains what to do', async () => {
  settings.set({ clearKey: true, anthropicKey: '' });
  await assert.rejects(researchLot(q.lot.get('pickles:777')), /Settings/);
});
