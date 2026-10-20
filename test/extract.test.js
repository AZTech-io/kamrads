import test from 'node:test';
import assert from 'node:assert/strict';
import { lotsFromJson, factsFromText, parseTime, parseCountdown, normaliseWovr, jsonBlobsFromHtml, parseAuDate, isVehicle } from '../src/extract.js';

const NOW = Date.parse('2026-10-20T03:00:00Z');

test('finds Pickles-style lots nested in a search response', () => {
  const body = {
    data: {
      totalCount: 3481,
      products: [
        {
          stockNumber: 62430579, title: '2011 Isuzu NPR 400 Medium', productType: { title: 'trucks' },
          odometer: { value: 288400, unit: 'km' }, wovr: 'WOVR N/A',
          location: { suburb: 'Altona North', state: 'VIC' },
          auction: { currentBid: { amount: 2200 }, bidCount: 7, bidEndDate: '2026-10-20T03:08:00Z', buyMethod: 'Pickles Online' },
          images: [{ url: 'https://www.pickles.com.au/images/transform/a/b.jpeg' }],
          url: '/used/details/trucks/2011-isuzu-npr-400-medium/62430579',
        },
        { stockNumber: 62423903, year: 2013, make: 'Ford', model: 'Focus', variant: 'LW MKII Trend', odometer: 227319,
          wovrStatus: 'Statutory Write-Off', highestBid: '$350', productBidEnd: '2026-10-21 14:00:00', branch: 'Kurri Kurri, NSW' },
      ],
      facets: [{ id: 1, name: 'Make', count: 4 }],
    },
  };
  const lots = lotsFromJson(body, NOW);
  assert.equal(lots.length, 2);
  const isuzu = lots.find(l => l.ext_id === '62430579');
  assert.equal(isuzu.bid, 2200);
  assert.equal(isuzu.bid_count, 7);
  assert.equal(isuzu.end_at, Date.parse('2026-10-20T03:08:00Z'));
  assert.equal(isuzu.odometer, 288400);
  assert.equal(isuzu.wovr, 'WOVR N/A');
  assert.equal(isuzu.state, 'VIC');
  assert.equal(isuzu.buy_method, 'Pickles Online');
  assert.match(isuzu.image, /b\.jpeg$/);
  const focus = lots.find(l => l.ext_id === '62423903');
  assert.equal(focus.title, '2013 Ford Focus LW MKII Trend');
  assert.equal(focus.bid, 350);
  assert.equal(focus.wovr, 'Statutory Write-Off');
  assert.equal(focus.state, 'NSW');
  // zone-less time is Sydney time: 14:00 AEDT = 03:00Z
  assert.equal(focus.end_at, Date.parse('2026-10-21T03:00:00Z'));
});

test('ignores facets, menus and other non-lot objects', () => {
  const lots = lotsFromJson({ menu: [{ id: 1, title: 'Cars', url: '/cars' }], user: { id: 9, name: 'Aaron' }, facets: [{ id: 3, name: 'Toyota', count: 120 }] });
  assert.equal(lots.length, 0);
});

test('does not mistake start price or increments for the current bid', () => {
  const [l] = lotsFromJson({ items: [{ lotId: 'A1', name: 'Pallet of tools', startingBid: 10, bidIncrement: 5, nextBidAmount: 15, endTime: 1792544400 }] });
  assert.equal(l.bid, null);
  assert.equal(l.start_price, 10);
  assert.equal(l.end_at, 1792544400000);
});

test('reads bid, countdown, km and WOVR from detail page text', () => {
  const text = `2016 Mitsubishi Triton\nMilperra, NSW\n297,531 km\nStatutory Write-Off\nCurrent Bid\n$1,850\n12 bids\nStarting bid $1\nEnds in 0d 00:09:30`;
  const f = factsFromText(text, NOW);
  assert.equal(f.bid, 1850);
  assert.equal(f.bid_count, 12);
  assert.equal(f.odometer, 297531);
  assert.equal(f.wovr, 'Statutory Write-Off');
  assert.equal(f.end_at, NOW + 570000);
  assert.equal(f.state, 'NSW');
  assert.equal(f.start_price, 1);
});

test('starting bid text is not read as the current bid', () => {
  const f = factsFromText('Starting bid: $500\nNo bids yet', NOW);
  assert.equal(f.bid, undefined);
  assert.equal(f.start_price, 500);
  assert.equal(f.bid_count, 0);
});

test('time parsing', () => {
  assert.equal(parseCountdown('2d 3h 4m'), ((2 * 24 + 3) * 60 + 4) * 60000);
  assert.equal(parseCountdown('14 mins 3 secs'), 14 * 60000 + 3000);
  assert.equal(parseCountdown('01:02:03'), 3723000);
  assert.equal(parseTime('/Date(1792544400000)/'), 1792544400000);
  // 10:00 in Sydney in July is AEST (+10)
  assert.equal(parseTime('2026-07-01T10:00:00'), Date.parse('2026-07-01T00:00:00Z'));
  assert.equal(parseAuDate('Thu 29 Oct 2026 1pm AWST'), Date.parse('2026-10-29T05:00:00Z'));
  assert.equal(parseAuDate('21/10/2026 2:30 pm'), Date.parse('2026-10-21T03:30:00Z'));
});

test('WOVR normalisation', () => {
  assert.equal(normaliseWovr('Inspection Passed Repairable Writeoff'), 'Inspection Passed Repairable');
  assert.equal(normaliseWovr('REPAIRABLE WRITE OFF'), 'Repairable Write-Off');
  assert.equal(normaliseWovr('WOVR N/A'), 'WOVR N/A');
});

test('pulls Next.js data out of HTML', () => {
  const html = `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"product":{"stockNumber":62430579,"title":"2011 Isuzu NPR","currentBid":2200}}}}</script>`
    + `<script>self.__next_f.push([1,"5:{\\"lot\\":{\\"lotId\\":\\"99001\\",\\"title\\":\\"Hino Ranger\\",\\"highestBid\\":4100}}\\n"])</script>`;
  const lots = jsonBlobsFromHtml(html).flatMap(b => lotsFromJson(b));
  assert.deepEqual(lots.map(l => [l.ext_id, l.bid]).sort(), [['62430579', 2200], ['99001', 4100]]);
});

test('vehicle detection', () => {
  assert.ok(isVehicle({ url: 'https://www.pickles.com.au/used/details/trucks/x/62430579' }));
  assert.ok(isVehicle({ year: 2014, make: 'Mazda' }));
  assert.ok(!isVehicle({ title: 'Box of tools', category: 'general-goods' }));
});
