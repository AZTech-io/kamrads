// Bought: won lots become cost records; every cost adds up to what the item owes us; profit when sold.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kamrads-bought-'));
process.env.DASH_USER = 'aaron'; process.env.DASH_PASS = 'a'; process.env.DASH_USERS = 'matthew:m';
process.env.PORT = '18789'; process.env.HOST = '127.0.0.1';

const { upsertLot, q } = await import('../src/db.js');
const { startServer } = await import('../src/server.js');
startServer();
await new Promise(r => setTimeout(r, 300));
const H = u => ({ authorization: 'Basic ' + Buffer.from(u).toString('base64'), 'content-type': 'application/json' });
const api = async (m, p, body, who = 'aaron:a') => {
  const r = await fetch('http://127.0.0.1:18789' + p, { method: m, headers: H(who), body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: r.status, json, text };
};

test('won lot -> purchase with hammer, fees and GST; costs add up; sold gives profit and margin', async () => {
  const t = Date.now();
  upsertLot({ site: 'lloyds', ext_id: '6098920', title: '2004 Volvo FH12 Prime Mover', bid: 1650, gst_extra: 1, end_at: t - 3600000, url: 'https://www.lloydsonline.com.au/LotDetails.aspx?lid=6098920', location: 'Paget', state: 'QLD' });
  q.closeDue.all(t, t);
  const r = await api('POST', '/api/purchases', { lotKey: 'lloyds:6098920', price: '1,700' });
  assert.equal(r.status, 200);
  const again = await api('POST', '/api/purchases', { lotKey: 'lloyds:6098920', price: 1700 });
  assert.equal(again.json.id, r.json.id, 'one record per lot');
  let p = (await api('GET', '/api/purchases')).json.purchases[0];
  assert.deepEqual(p.costs.map(c => [c.category, c.amount]), [['Purchase price', 1700], ["Buyer's fees", 281], ['GST', 170]]);
  assert.equal(p.total, 2151);
  assert.equal(p.boughtBy, 'aaron');
  await api('POST', `/api/purchases/${p.id}/costs`, { category: 'Transport', description: 'Paget to Canberra', amount: '$3,200' }, 'matthew:m');
  await api('POST', `/api/purchases/${p.id}/costs`, { category: 'Repairs & parts', description: 'Tyres', amount: 1800 });
  assert.equal((await api('POST', `/api/purchases/${p.id}/costs`, { category: 'Other', amount: 'lots' })).status, 400);
  await api('PATCH', `/api/purchases/${p.id}`, { status: 'for sale', asking_price: '12,000', entity: 'Katara Group' });
  p = (await api('GET', '/api/purchases')).json.purchases[0];
  assert.equal(p.total, 7151); assert.equal(p.projected, 4849); assert.equal(p.costs.find(c => c.category === 'Transport').by, 'matthew');
  await api('PATCH', `/api/purchases/${p.id}`, { status: 'sold', sold_price: 11000 });
  const all = (await api('GET', '/api/purchases')).json;
  p = all.purchases[0];
  assert.equal(p.profit, 3849); assert.ok(p.soldAt > 0, 'sold date stamped');
  assert.ok(Math.abs(p.margin - 3849 / 7151) < 1e-9);
  assert.equal(all.summary.held, 0); assert.equal(all.summary.profit, 3849);
  assert.deepEqual(all.entities, ['Katara Group']);
  // the auction board knows it's been bought
  const closed = (await api('GET', '/api/closed?hours=24')).json.lots.find(l => l.key === 'lloyds:6098920');
  assert.equal(closed.purchaseId, p.id);
  const csv = await api('GET', '/api/export/bought.csv');
  assert.match(csv.text.split('\n')[0], /title,entity,status/);
  assert.match(csv.text, /2004 Volvo FH12 Prime Mover,Katara Group,sold/);
});

test('manual item, deleting a cost and an item', async () => {
  const r = await api('POST', '/api/purchases', { title: 'Speed Queen washer', price: 400 });
  assert.equal((await api('POST', '/api/purchases', { title: '  ' })).status, 400);
  const c = await api('POST', `/api/purchases/${r.json.id}/costs`, { category: 'Transport', amount: 80 });
  await api('DELETE', `/api/purchases/${r.json.id}/costs/${c.json.costId}`);
  let p = (await api('GET', '/api/purchases')).json.purchases.find(x => x.id === r.json.id);
  assert.equal(p.total, 400);
  await api('DELETE', `/api/purchases/${r.json.id}`);
  p = (await api('GET', '/api/purchases')).json.purchases.find(x => x.id === r.json.id);
  assert.equal(p, undefined);
  const page = await fetch('http://127.0.0.1:18789/bought', { headers: H('aaron:a') });
  assert.match(await page.text(), /Bought &amp; costs/);
});

test.after(() => setTimeout(() => process.exit(0), 50));
