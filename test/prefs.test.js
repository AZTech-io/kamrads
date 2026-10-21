// View settings follow the login; rough values from sold vehicles of the same type.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kamrads-prefs-'));
process.env.DASH_USER = 'aaron'; process.env.DASH_PASS = 'a'; process.env.DASH_USERS = 'matthew:m';
process.env.GEOCODE = 'false'; process.env.PORT = '18791'; process.env.HOST = '127.0.0.1';

const { startServer } = await import('../src/server.js');
const { upsertLot, q, db } = await import('../src/db.js');
const history = await import('../src/history.js');
const { estimateOf, estimateSource } = await import('../src/alerts.js');
startServer();
await new Promise(r => setTimeout(r, 300));
const base = 'http://127.0.0.1:18791';
const H = u => ({ authorization: 'Basic ' + Buffer.from(u).toString('base64'), 'content-type': 'application/json' });

test('view settings are kept with the login and come back in the page', async () => {
  const save = (u, body) => fetch(base + '/api/prefs', { method: 'POST', headers: H(u), body: JSON.stringify(body) });
  assert.equal((await save('aaron:a', { key: 'k2_view', value: 'deals' })).status, 200);
  assert.equal((await save('aaron:a', { all: { kf_heat: ['ultra', 'hot'], kf_plan: { a: 'Canberra', b: 'Sydney', d: 40 } } })).status, 200);
  assert.equal((await save('aaron:a', { key: 'evil', value: 1 })).status, 400);
  assert.equal((await save('aaron:a', { key: 'k2_more', value: 'x'.repeat(5000) })).status, 400);
  const page = await (await fetch(base + '/', { headers: H('aaron:a') })).text();
  const prefs = JSON.parse(/window\.__PREFS=(\{.*?\});<\/script>/.exec(page)[1]);
  assert.equal(prefs.k2_view, 'deals'); assert.deepEqual(prefs.kf_heat, ['ultra', 'hot']);
  const fr = await (await fetch(base + '/freight', { headers: H('aaron:a') })).text();
  assert.match(fr, /"kf_plan":\{"a":"Canberra"/);
  const mm = await (await fetch(base + '/', { headers: H('matthew:m') })).text();
  assert.match(mm, /window\.__PREFS=\{\};/, "Matthew's are his own");
  await save('aaron:a', { key: 'k2_view', value: null });
  assert.doesNotMatch(await (await fetch(base + '/', { headers: H('aaron:a') })).text(), /k2_view/);
  assert.match(await (await fetch(base + '/bought', { headers: H('aaron:a') })).text(), /window\.__PREFS=/);
});

test('rough value: not enough Caddys sold, so similar vans of the same age and km', () => {
  const now = Date.now();
  const sold = (id, title, price, km) => upsertLot({ site: 'pickles', ext_id: id, title, category: 'vans', odometer: km, bid: price, url: 'https://x/' + id, end_at: now - 3600000 });
  const vans = [['V1', '2009 Volkswagen Caddy Van', 5200, 300000], ['V2', '2011 Toyota HiAce Van', 9000, 350000], ['V3', '2010 Ford Transit Van', 4800, 310000], ['V4', '2012 Renault Kangoo Van', 4500, 280000],
    ['V5', '2010 Hyundai iLoad Van', 7600, 330000], ['V6', '2009 Mitsubishi Express Van', 3900, 360000], ['V7', '2011 Volkswagen Transporter Van', 8800, 300000], ['V8', '2010 Peugeot Partner Van', 3500, 260000],
    ['V9', '2008 Toyota HiAce Van', 7900, 400000]];
  for (const v of vans) sold(...v);
  // as if read right at the close
  db.exec(`UPDATE lots SET status = 'closed', final_bid = bid, final_seen_at = end_at WHERE site = 'pickles' AND ext_id LIKE 'V%'`);
  history.rebuild();
  upsertLot({ site: 'grays', ext_id: '0022-23502706', title: '2010 Volkswagen Caddy Petrol', category: 'commercial vehicles van', odometer: 332204, bid: 3000, end_at: now + 3600000,
    url: 'https://www.grays.com/lot/0022-23502706/commercial-vehicles/2010-volkswagen-caddy-petrol' });
  const caddy = q.lot.get('grays:0022-23502706');
  const sl = history.soldLike(caddy, { minN: 3 }); assert.equal(sl, null, 'only one Caddy sold: ' + JSON.stringify(sl && { label: sl.label, ex: sl.examples.map(e => e.title) }));
  const t = history.typeLike(caddy);
  assert.ok(t && t.rough && t.n >= 8, JSON.stringify(t));
  assert.ok(t.median >= 4500 && t.median <= 8000, `${t.median}`);
  assert.match(t.label, /^rough: \d+ vans 2007–2013/);
  assert.equal(estimateSource(caddy), 'type'); assert.equal(estimateOf(caddy), t.median);
  // a car with no year gets nothing rather than a guess
  assert.equal(history.typeLike({ ...caddy, key: 'x:1', title: 'Volkswagen Caddy', year: null }), null);
});
