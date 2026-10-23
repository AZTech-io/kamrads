import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kamrads-'));
process.env.GEOCODE = 'false';
const { parseVelocicast, importVelocicast } = await import('../src/results.js');
const { upsertLot, q, db } = await import('../src/db.js');
const { soldLike } = await import('../src/history.js');

// the shape of a saved Velocicast page (run list, then the current-lot panel repeating one lot)
const PAGE = `<html><body><div>National Corporate, Fleet and Finance Vehicle Auction at 23/10/2026 10:00 AM AEDT</div>
<div>#2</div><div>- CP: 07/2022,Toyota,Kluger,AXUH78R GX,Wagon,7 seats,5 doors</div><div>Location:</div><div>Belmore, NSW</div><div>089 - Frosted White (T)</div>
<div>103,578</div><div>Kms. Showing on Odometer</div><div>SOLD</div><div>$33,750</div>
<div>#3</div><div>- CP: 11/2021,Mazda,CX-5,KF2W7A Maxx,Wagon,5 seats,5 doors</div><div>Location:</div><div>Belmore, NSW</div><div>Blue</div>
<div>77,552</div><div>Kms. Showing on Odometer</div><div>PASSED IN</div><div>--</div>
<div>#12</div><div>- CP: 10/2021,Toyota,Hilux,GUN126R SR,Utility Dual Cab,5 seats,4 doors</div><div>Location:</div><div>Gateshead, NSW</div><div>White</div>
<div>278,640</div><div>Kms. Showing on Odometer</div><div>SOLD</div><div>$21,750</div>
<div>#59</div><div>- CP: 08/2018,Ford,Escape,ZG MY18.75 Titanium,Wagon,5 seats,5 doors</div><div>Location:</div><div>Brendale, QLD</div><div>White</div>
<div>155,907</div><div>Kms. Showing on Odometer</div><div>Max Bid</div>
<div>#59</div><div>-</div><div>CP: 08/2018,Ford,Escape,ZG MY18.75 Titanium,Wagon,5 seats,5 doors</div><div>ONLINE</div><div>$5,500</div></body></html>`;

test('Velocicast page: sale time, each run with its result and price', () => {
  const p = parseVelocicast(PAGE);
  assert.equal(p.sale.name, 'National Corporate, Fleet and Finance Vehicle Auction');
  assert.equal(new Date(p.sale.at).toISOString(), '2026-10-22T23:00:00.000Z');
  assert.deepEqual(p.lots.map(l => [l.run, l.result, l.price, l.odometer, l.state]),
    [[2, 'sold', 33750, 103578, 'NSW'], [3, 'passed', null, 77552, 'NSW'], [12, 'sold', 21750, 278640, 'NSW'], [59, 'upcoming', null, 155907, 'QLD']]);
  assert.match(p.lots[0].title, /^2022 Toyota Kluger AXUH78R GX/);
});

test('import: our lots close with the hammer price (passed in = not sold), new sold ones are added, re-import is a no-op, and a rescrape does not reopen them', () => {
  const p = parseVelocicast(PAGE);
  upsertLot({ site: 'pickles', ext_id: '9001', title: '2022 Toyota Kluger GX', odometer: 103578, end_at: p.sale.at + 14 * 36e5, bid: 30000 });
  upsertLot({ site: 'pickles', ext_id: '9002', title: '2021 Mazda CX-5 Maxx', odometer: 77552, end_at: p.sale.at + 14 * 36e5, bid: 18000 });
  const r = importVelocicast(p);
  assert.equal(r.sold, 2); assert.equal(r.passed, 1); assert.equal(r.upcoming, 1); assert.equal(r.matched, 2); assert.equal(r.added, 1);
  const k = q.lot.get('pickles:9001');
  assert.equal(k.status, 'closed'); assert.equal(k.final_bid, 33750);
  const m = q.lot.get('pickles:9002');
  assert.equal(m.status, 'closed'); assert.equal(m.final_bid, null); assert.equal(m.reserve, 'not met');
  const before = db.prepare('SELECT count(*) AS n FROM lots').get().n;
  assert.equal(importVelocicast(p).added, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM lots').get().n, before);
  upsertLot({ site: 'pickles', ext_id: '9001', title: '2022 Toyota Kluger GX', end_at: p.sale.at + 14 * 36e5, bid: 31000 });
  assert.equal(q.lot.get('pickles:9001').status, 'closed');
  assert.equal(q.lot.get('pickles:9001').final_bid, 33750);
  // listed again in a later sale: open again
  upsertLot({ site: 'pickles', ext_id: '9002', title: '2021 Mazda CX-5 Maxx', end_at: Date.now() + 7 * 864e5 });
  assert.equal(q.lot.get('pickles:9002').status, 'open');
  // the hammer prices count as sold results
  const h = soldLike({ key: 'x', title: '2022 Toyota Kluger GX', odometer: 100000 }, { minN: 1 });
  assert.equal(h.median, 33750);
});

test('bid stream (HAR socket messages): reserve and bidding reached, matched by Pickles stock number; stream-only lots carry no result', async () => {
  const { parseVelocicastStream, importVelocicastStream } = await import('../src/results.js');
  const stats = (item, bid, extra = {}) => '42["message",' + JSON.stringify({ type: 'EventStats', doc: { Stats: { EventDesc: 'National Corporate, Fleet and Finance Vehicle Auction at 23/10/2026 10:00 AM AEDT', EventStart: '2026-10-22T23:00:00.000Z', CurrentItemID: item.ID, CurrentBidAmount: bid, Status: 'RUNNING', Bids: [], ...extra, CurrentItem: item } } }) + ']';
  const camry = { ID: 951036, ItemNum: '82', StockNumber: '62419073', Description: 'CP: 03/2019,Toyota,Camry,AXVH71R Ascent Sport,Sedan,5 seats,4 doors', ReserveAmt: 13250, Miles: 213763, DisplayLocation: 'Brendale, QLD', ItemLink: 'https://www.pickles.com.au/used/details/cars/Toyota-Camry-2019/62419073', SellerNote: 'Prev: 1, GST: GST_INCL' };
  const jolion = { ...camry, ID: 950978, ItemNum: '94', StockNumber: '62421381', Description: 'CP: 02/2024,GWM,Haval Jolion,A01 Lux,Wagon,5 seats,5 doors', ReserveAmt: 14000, Miles: 34150, SellerNote: 'Prev: 0, Lee: $1000, GST: GST_INCL' };
  upsertLot({ site: 'pickles', ext_id: '62419073', title: '2019 Toyota Camry Ascent Sport', bid: 11000, end_at: Date.now() + 36e5, url: 'https://www.pickles.com.au/used/details/cars/Toyota-Camry-2019/62419073' });
  const p = parseVelocicastStream([stats(camry, 12000), stats(camry, 12500), '42["message",{"type":"EventStats","doc":{"Stats":{"CurrentItemID":951036,"CurrentBidAmount":12250,"Status":"RUNNING"}}}]', stats(jolion, null), stats(jolion, 13300), '2', 'garbage']);
  assert.equal(p.sale.name, 'National Corporate, Fleet and Finance Vehicle Auction');
  assert.deepEqual(p.items.map(i => [i.run, i.stock, i.reserve, i.lastBid, i.leeway]), [[82, '62419073', 13250, 12250, null], [94, '62421381', 14000, 13300, 1000]]);
  const r = importVelocicastStream(p);
  assert.equal(r.matched, 1); assert.equal(r.added, 1); assert.equal(r.reserves, 2);
  const c = q.lot.get('pickles:62419073');
  assert.equal(c.reserve_amt, 13250); assert.equal(c.bid, 12250); assert.equal(c.status, 'open');
  const j = q.lot.get('pickles:62421381');
  assert.equal(j.reserve_amt, 14000); assert.equal(j.status, 'closed'); assert.equal(j.final_bid, null); assert.equal(j.result_src, 'stream');
  assert.match(j.title, /^2024 GWM Haval Jolion/);
});
