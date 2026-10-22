// End-to-end: real headless Chromium against fake Pickles / Manheim pages served by request
// interception. Proves the browser, JSON capture, DOM fallback, merge and DB pipeline work.
// Skips automatically if no Chromium is available.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kamrads-e2e-'));
process.env.PICKLES_SEARCHES = 'https://www.pickles.com.au/used/search/trucks?contentkey=trucks';
process.env.PICKLES_MAX_PAGES = '1';
process.env.MANHEIM_SCROLLS = '1';
process.env.ALLBIDS_PAGES = 'https://www.allbids.com.au/closing-today';
process.env.ALLBIDS_SCROLLS = '3';
process.env.PAGE_TIMEOUT_MS = '15000';
if (!process.env.CHROME_PATH && fs.existsSync('/opt/google/chrome/chrome')) process.env.CHROME_PATH = '/opt/google/chrome/chrome';

process.env.AIRTASKER_CATEGORIES = 'delivery';
process.env.AIRTASKER_CITIES = 'canberra';
process.env.LLOYDS_MAX_PAGES = '2';
process.env.LLOYDS_PAGE_SIZE = '3';
const { getContext, closeBrowser } = await import('../src/browser.js');
const lloyds = await import('../src/sites/lloyds.js');
process.env.GRAYS_MAX_PAGES = '3';
const extra = await import('../src/sites/extra.js');
const pickles = await import('../src/sites/pickles.js');
const manheim = await import('../src/sites/manheim.js');
const allbids = await import('../src/sites/allbids.js');

const soon = new Date(Date.now() + 9 * 60000).toISOString();
const html = (body, script = '') => `<!doctype html><html><body>${body}<script>${script}</script></body></html>`;

const PICKLES = {
  '/used/search/trucks': html('<div id="results">Loading…</div>', `
    fetch('/api-website/search/products?page=1').then(r => r.json()).then(d => {
      document.getElementById('results').innerHTML = d.products.map(p =>
        '<div class="card"><a href="' + p.url + '"><h3>' + p.title + '</h3></a><p>Altona North, VIC</p><p>' + p.odometer + ' km</p></div>').join('')
        + '<div class="card"><a href="/used/details/cars/2014-mazda-3/62442387"><h3>2014 Mazda 3 Maxx</h3></a><p>Tullamarine, VIC</p><p>82,915 km</p><p>Statutory Write-Off</p><p>Current bid $650</p></div>';
    });`),
  '/api-website/search/products': JSON.stringify({ totalCount: 1, products: [{
    stockNumber: 62430579, title: '2011 Isuzu NPR 400 Medium', url: '/used/details/trucks/2011-isuzu-npr-400-medium/62430579',
    odometer: 288400, wovr: 'WOVR N/A', location: 'Altona North, VIC',
    auction: { currentBid: { amount: 2200 }, bidCount: 4, bidEndDate: soon, buyMethod: 'Pickles Online' },
    vehicle: { id: 55501234, title: 'Isuzu NPR', odometer: 288400 } },
    { stockNumber: 99999999, title: 'Internal record not on page', currentBid: 5 }] }),
  '/used/details/trucks/2011-isuzu-npr-400-medium/62430579': html('<h1>2011 Isuzu NPR 400 Medium</h1><div id="bid"></div>', `
    setTimeout(() => { document.getElementById('bid').innerText = 'Current Bid\\n$2,450\\n5 bids\\nEnds in 00:08:30'; }, 400);`),
};
PICKLES['/'] = html('<nav><a href="/group/pickles/dashboard">My Pickles</a><a href="#">Login</a></nav>');
PICKLES['/used/details/cars/2014-mazda-3/62442387'] = html('<h1>2014 Mazda 3 Maxx</h1>', `fetch('/api-website/buyer/product/62442387').then(r => r.json())`);
PICKLES['/api-website/buyer/product/62442387'] = JSON.stringify({ product: { stockNumber: 62442387, title: 'Mazda 3', currentBid: { amount: 700 }, bidCount: 9, bidEndDate: soon } });
PICKLES['/api-website/buyer/product/62430579'] = JSON.stringify({ product: { stockNumber: 62430579, title: 'internal', currentBid: { amount: 2600 }, bidCount: 6, bidEndDate: soon } });
const MANHEIM = {
  '/': html('<ul><li><a href="/events/statutory-write-off">Statutory Write off Vehicles</a> | (173) lots</li><li><a href="/events/classic-mercedes">Classic Mercedes Benz Auction</a> | (3) lots</li></ul>'),
  '/events/statutory-write-off': html('<div id="lots"></div>', `
    document.getElementById('lots').innerHTML = '<div class="lot"><a href="/damaged/vehicle-details/4471923"><h4>2019 Toyota Hilux SR</h4></a><span>143,200 km</span><span>Repairable Write-Off</span><span>Minto, NSW</span><span>Current bid $1,100</span></div>';`),
};

const utcNoZone = new Date(Date.now() + 25 * 60000).toISOString().slice(0, 19); // ALLBIDS style: UTC without a Z
const ALLBIDS = {
  '/closing-today': html('<ul id="l"></ul><a href="#" id="more" style="display:block;margin-top:3000px">SEE MORE</a>', `
    fetch('/Search/GetAuctions?tab=closingtoday').then(r => r.json()).then(d => {
      document.getElementById('l').innerHTML = d.auctions.map(a =>
        '<li><a href="/c/' + a.cat + '/' + a.slug + '-' + a.pageId + '"><h4>' + a.aucTitle + '</h4></a><b>$' + a.aucCurrentBid + '</b></li>').join('');
    });
    document.getElementById('more').onclick = e => { e.preventDefault();
      document.getElementById('l').insertAdjacentHTML('beforeend', '<li><a href="/c/tools/makita-drill-kit-1101234"><h4>Makita drill kit</h4></a><span>Current bid $12</span><span>Closes Today at 9:45 PM</span></li>');
      e.target.remove(); };`),
  '/Search/GetAuctions': JSON.stringify({ total: 2, auctions: [
    { aucID: 1100784, pageId: 1100784, cat: 'computers-it/notebooks-laptops', slug: 'dell-latitude-5420-i5-laptop', aucTitle: 'Dell Latitude 5420 i5 Laptop',
      aucCurrentBid: 3, aucCloseUtc: utcNoZone, aucCity: 'Fyshwick', aucState: 'ACT', aucBidCount: 2, aucThumbnailUrl: '/img/1.jpg' },
    { aucID: 77001, pageId: 1100999, cat: 'allbids-car-auctions/motor-vehicles-cars', slug: '2012-toyota-corolla', aucTitle: '2012 Toyota Corolla Ascent',
      aucCurrentBid: 1250, aucCloseUtc: utcNoZone, aucCity: 'Mitchell', aucState: 'ACT' },
  ] }),
};

const lloydsDay = new Date(Date.now() + 3600000).toLocaleString('en-GB', { timeZone: 'Australia/Brisbane', day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');
const lotRow = (lid, no, title, bid, left) => `<tr><td>${no}</td><td><a href="LotDetails.aspx?smode=0&aid=74526&lid=${lid}"><img alt="${title}"></a></td>`
  + `<td><a href="LotDetails.aspx?smode=0&aid=74526&lid=${lid}">${title}</a></td><td><img title="Queensland"></td><td>$${bid}</td><td>${left}</td></tr>`;
const LLOYDS = {
  '/AuctionList.aspx': html(`<table>
    <tr><td>Wed ${lloydsDay} 10:00</td><td><a href="AuctionDetails.aspx?aid=74526">Machinery, Plant &amp; Equipment</a></td></tr>
    <tr><td>Wed ${lloydsDay} 12:00</td><td><a href="AuctionDetails.aspx?aid=63775">BUY NOW - 40 HECTARES - WARIALDA NSW</a></td></tr></table>`),
  '/AuctionLots.aspx': u => html('<table>' + (u.searchParams.get('pgn') === '1'
    ? lotRow(6098907, '1', 'HOW DOES THE AUCTION PROCESS WORK? PRACTICE...', '1', '1d 5h 05m')
      + lotRow(6098920, '1200', '2004 Volvo FH12 500 6x4 Prime Mover...', '1,350', '0d 0h 09m')
      + lotRow(6109475, '3000', 'Enforcer M16 10m Electric Counterbalanced...', '2,220', '1d 5h 07m')
    : lotRow(6109476, '3001', 'Pallet of Makita tools', '5', '2h 10m')) + '</table>'),
  '/LotDetails.aspx': html(`<title>Machinery, Plant &amp; Equipment - Lot 1200</title><table>
    <tr><td>Current Bid:</td><td>$1,650</td></tr><tr><td>Auction Date:</td><td>${lloydsDay} 10:00</td></tr>
    <tr><td>Estimated time until auction:</td><td>00:08:30</td></tr>
    <tr><td>Location of item:</td><td>Yard 3/263 Connors Road, Paget, QLD, Australia</td></tr>
    <tr><td>Bidder(s)</td><td>There are no bids on this lot.</td></tr></table><ul><li>Manufacture Year: 2004</li><li>Kms: 889724</li></ul>`),
};

const graysCard = (no, sale, slug, title, bid) => `<div class="card"><a href="/lot/${no}-${sale}/motor-vehicles-motor-cycles/${slug}"><h3>${title}</h3></a><p>Current bid: $${bid}</p><p>Dandenong South, VIC</p></div>`;
const GRAYS = {
  '/search/automotive-trucks-and-marine': u => html(u.searchParams.get('page') === '2'
    ? graysCard('0005', '23502659', '2015-bmw-220i-sport-line-petrol', '2015 BMW 220i Sport Line', '10,050')
    : u.searchParams.get('page') === '3' ? '<p>No more results</p>'
    : graysCard('0007', '23502659', '2016-hyundai-accent-active-petrol', '2016 Hyundai Accent Active', '2,809')
      + graysCard('0006', '23502659', '2011-volkswagen-golf-trendline-petrol', '2011 Volkswagen Golf Trendline', '3,200')
      + '<a href="/redirection/interimPage?x=1">Slattery lot</a>'),
  '/lot/0007-23502659/motor-vehicles-motor-cycles/2016-hyundai-accent-active-petrol': html(`<h1>2016 Hyundai Accent Active Petrol</h1>
    <p>Current bid: $2,950</p><p>12 bids</p><p>Closes in 0d 00:07:10</p><p>Odometer: 98,412 km</p><p>Buyer's Premium 16.5%</p>`),
};
const BARN_HOME = { '/upcoming-auctions': html('<a href="https://bidding.theauctionbarn.com.au/auction-items/2564">Weekly Online Vehicle Auction</a><a href="https://bidding.theauctionbarn.com.au/auction-items/2565">Machinery Clearance</a>') };
const BARN = {
  '/auction-items/2564': html('<div id="lots"></div>', `fetch('/api/auctions/2564/items').then(r => r.json()).then(d => {
      document.getElementById('lots').innerHTML = d.items.map(i => '<div class="lot"><a href="/lot-details/2564/' + i.lotId + '"><h4>' + i.title + '</h4></a><span>Current Top Bid: $' + i.currentBid + '</span></div>').join(''); });`),
  '/api/auctions/2564/items': JSON.stringify({ items: [
    { lotId: 689027, lotNumber: '12', title: '2012 Ford Ranger XL Cab Chassis', currentBid: 1550, endTime: soon, bidCount: 3 },
    { lotId: 689605, lotNumber: '13', title: 'Honda EU22i Generator', currentBid: 210, endTime: soon } ] }),
  '/auction-items/2565': html('<a href="/lot-details/2565/689061"><h4>Kubota Ride-on Mower</h4></a><span>Current Top Bid: $800</span>'),
};

const atCard = (slug, id, title, price, from, to, ago) => `<a href="/tasks/${slug}-${id}"><div class="card"><h3>${title}</h3><span>$${price}</span><div>${from}</div>${to ? `<div>${to}</div>` : ''}<p>Posted ${ago}</p><span>Open</span></div></a>`;
const AIRTASKER = {
  '/au/jobs/delivery/': html(atCard('move-my-bed', 'x01m5689s0jwrkx22z6n9mbswkn', 'Move my bed', 150, 'Mermaid Waters QLD 4218', 'Arana Hills QLD 4054', '4 minutes ago')),
  '/au/jobs/delivery/canberra/': html('<div id="l"></div>', `document.getElementById('l').innerHTML = '${atCard('collect-couch-from-fyshwick-and-deliver-to-lyneham', 'x01m59jffph0bcq12w1q92vv7z9', 'Collect couch from Fyshwick and deliver to Lyneham', 80, 'Fyshwick ACT 2609', 'Lyneham ACT 2602', 'about 17 hours ago')}'
    + '${atCard('bike-transported-from-canberra-to-sydney', 'x01m56wfbad7fvjdcm4v3886770', 'Bike transported from Canberra to Sydney', 100, 'Canberra ACT 2604', '', '2 days ago')}';`),
};

const TRUCKIT = {
  '/robots.txt': 'User-agent: *',
  '/search-for-jobs': html('<div id="jobs"></div>', `fetch('/api/frontend/search/jobs?_=1&initial=true').then(r => r.json()).then(d => { document.getElementById('jobs').innerText = d.data.length + ' jobs'; });`),
  '/api/frontend/search/jobs': u => JSON.stringify(u.searchParams.get('page') === '2'
    ? { data: [{ status: 'active', item_label: 'Fridge', category_label: 'Furniture', created_at: '1792526000', suburb1: 'FYSHWICK', state1: 'ACT', postcode1: '2609', suburb2: 'PARRAMATTA', state2: 'NSW', postcode2: '2150', distance_estimate: '290' }], page_count: 2, page: 2 }
    : { data: [{ status: 'active', item_label: 'crane hoist rope', category_label: 'Other General', created_at: '1792526930', collection_date_view: 'Ready Now', suburb1: 'SOMERSBY', state1: 'NSW', postcode1: '2250', suburb2: 'WILLIAMSTOWN', state2: 'VIC', postcode2: '3016', distance_estimate: '952' }], page_count: 2, page: 1, record_count: 2 }),
};

// Loadshift's real layout: a table, one row per load, each row linking to /projects/<type>/<slug>
const lsRow = (id, freight, qty, title, w, from, to, km, ready, href) => `<div class="row"><a href="${href}"></a><div>${id}</div><div>${freight}</div><div>${qty}</div><div>${title}</div><div>${w}</div><div><div>${from}</div><div>${to}</div></div><div>${km} km</div><div>${ready}</div></div>`;
const LOADSHIFT = {
  '/search/loads': u => html(u.searchParams.get('page') ? '<p>Showing 1-3 of 3</p>'
    : '<div>Load ID</div><div>Freight</div><div>Qty.</div><div>Title</div><div>Weight</div><div>Pickup and Dropoff</div><div>Distance</div><div>Ready On</div>'
    + lsRow(40720315, 'Machinery', 1, 'Komatsu PC300 Excavator - 3.19m W (Oversize)', '-', 'Garbutt, QLD 4814', 'Charters Towers City, QLD 4820', 137, '20-Oct-26', '/projects/machinery-mobile/Excavator-40720315')
    + lsRow(40779029, 'General Freight', 2, '1 Pallet - (turnbuckles)', '1850 kg', 'Kewdale, WA 6105', 'Kalgoorlie, WA 6430', 585, '21-Oct-26', '/projects/general-full-load/Pallet-turnbuckles')
    + lsRow(40778632, 'Machinery', 1, 'Bobcat machine on a trailer', '4000 kg', 'Australia', 'Boulia, QLD 4829', 2293, 'No date yet', '/projects/machinery-mobile/Bobcat-machine-trailer')),
};

async function fakeSite(site, origin, pages) {
  const ctx = await getContext(site);
  await ctx.route(origin + '/**', route => {
    const u = new URL(route.request().url());
    let body = pages[u.pathname];
    if (typeof body === 'function') body = body(u);
    if (body == null) return route.fulfill({ status: 404, body: 'nope' });
    route.fulfill({ status: 200, contentType: body.startsWith('{') ? 'application/json' : 'text/html', body });
  });
}

let chromeOk = true;
try { await getContext('probe'); } catch (e) { chromeOk = false; console.log('# no Chromium here, skipping e2e:', e.message.split('\n')[0]); }

test('Pickles: discovery merges JSON + DOM, refresh reads the live bid', { skip: !chromeOk }, async () => {
  await fakeSite('pickles', 'https://www.pickles.com.au', PICKLES);
  const lots = await pickles.discover();
  const isuzu = lots.find(l => l.ext_id === '62430579');
  const mazda = lots.find(l => l.ext_id === '62442387');
  assert.ok(isuzu, 'Isuzu found');
  assert.equal(isuzu.bid, 2200);
  assert.equal(isuzu.odometer, 288400);
  assert.equal(isuzu.category, 'trucks');
  assert.ok(Math.abs(isuzu.end_at - Date.parse(soon)) < 1000);
  assert.equal(lots.length, 2, 'no duplicate or off-page records');
  assert.ok(mazda, 'DOM-only card found');
  assert.equal(mazda.bid, 650);
  assert.equal(mazda.wovr, 'Statutory Write-Off');
  assert.equal(mazda.url, 'https://www.pickles.com.au/used/details/cars/2014-mazda-3/62442387');

  const fresh = await pickles.refresh(isuzu);
  assert.equal(fresh.bid, 2450);
  assert.equal(fresh.bid_count, 5);
  assert.ok(Math.abs(fresh.end_at - (Date.now() + 510000)) < 15000);
});

test('fast price feed: learned from one page read, then used without loading pages', { skip: !chromeOk }, async () => {
  const fast = await import('../src/fast.js');
  const mazda = { site: 'pickles', ext_id: '62442387', url: 'https://www.pickles.com.au/used/details/cars/2014-mazda-3/62442387' };
  const first = await pickles.refresh(mazda);
  assert.equal(first.bid, 700);
  assert.ok(!first.fast, 'first read is a full page read');
  assert.equal(fast.feedOf('pickles').template, 'https://www.pickles.com.au/api-website/buyer/product/{id}');
  const isuzu = { site: 'pickles', ext_id: '62430579', url: 'https://www.pickles.com.au/used/details/trucks/2011-isuzu-npr-400-medium/62430579' };
  const t0 = Date.now();
  const second = await pickles.refresh(isuzu);
  assert.ok(second.fast, 'second read uses the feed');
  assert.equal(second.bid, 2600);
  assert.equal(second.bid_count, 6);
  assert.equal(second.title, undefined, 'feed never supplies titles');
  assert.ok(Date.now() - t0 < 3000);
  fast.forget('pickles');
});

test('Manheim: finds matching events and their lots', { skip: !chromeOk }, async () => {
  await fakeSite('manheim', 'https://www.manheim.com.au', MANHEIM);
  const lots = await manheim.discover();
  assert.equal(lots.length, 1);
  const [hilux] = lots;
  assert.equal(hilux.ext_id, '4471923');
  assert.equal(hilux.title, '2019 Toyota Hilux SR');
  assert.equal(hilux.bid, 1100);
  assert.equal(hilux.wovr, 'Repairable Write-Off');
  assert.equal(hilux.sale_name, 'Statutory Write off Vehicles');
});

test('ALLBIDS: lots, UTC close times and ids lined up with the page', { skip: !chromeOk }, async () => {
  await fakeSite('allbids', 'https://www.allbids.com.au', ALLBIDS);
  const lots = await allbids.discover();
  assert.equal(lots.length, 3, 'includes the lot behind See more');
  const dell = lots.find(l => l.ext_id === '1100784');
  assert.equal(dell.bid, 3);
  assert.equal(dell.state, 'ACT');
  assert.equal(dell.bid_count, 2);
  assert.ok(Math.abs(dell.end_at - Date.parse(utcNoZone + 'Z')) < 1000, 'aucCloseUtc read as UTC');
  const corolla = lots.find(l => l.ext_id === '1100999');
  assert.ok(corolla, 'JSON lot with a different internal id matched to its card by title');
  assert.equal(corolla.bid, 1250);
  assert.match(corolla.url, /2012-toyota-corolla-1100999$/);
});

test('Lloyds: auctions -> lots with their own countdowns; lot page read by a quick fetch', { skip: !chromeOk }, async () => {
  await fakeSite('lloyds', 'https://www.lloydsonline.com.au', { ...LLOYDS, '/robots.txt': 'User-agent: *' });
  const lots = await lloyds.discover();
  assert.deepEqual(lots.map(l => l.ext_id).sort(), ['6098920', '6109475', '6109476'], 'practice lot and property tender skipped; page 2 read');
  const volvo = lots.find(l => l.ext_id === '6098920');
  assert.equal(volvo.title, '2004 Volvo FH12 500 6x4 Prime Mover');
  assert.equal(volvo.bid, 1350);
  assert.equal(volvo.lot_no, '1200');
  assert.equal(volvo.sale_name, 'Machinery, Plant & Equipment');
  assert.ok(Math.abs(volvo.end_at - (Date.now() + 9 * 60000)) < 20000, 'own countdown');
  assert.equal(volvo.url, 'https://www.lloydsonline.com.au/LotDetails.aspx?smode=0&aid=74526&lid=6098920');
  const forklift = lots.find(l => l.ext_id === '6109475');
  assert.ok(Math.abs(forklift.end_at - (Date.now() + (29 * 60 + 7) * 60000)) < 20000, '"10m" in the title is not the countdown');
  const { isVehicle } = await import('../src/extract.js');
  assert.ok(isVehicle(volvo) && !isVehicle(forklift));
  const fresh = await lloyds.refresh(volvo);
  assert.equal(fresh.bid, 1650);
  assert.equal(fresh.odometer, 889724);
  assert.equal(fresh.year, 2004);
  assert.equal(fresh.state, 'QLD');
  assert.ok(fresh.fast);
  assert.ok(Math.abs(fresh.end_at - (Date.now() + 510000)) < 15000);
  assert.ok(lloyds.owns(volvo.url) && lloyds.idFromUrl(volvo.url) === '6098920');
});

test('Grays (generic adapter): pages until no new lots, ids from links, page read gets fees', { skip: !chromeOk }, async () => {
  await fakeSite('grays', 'https://www.grays.com', GRAYS);
  const lots = await extra.grays.discover();
  assert.deepEqual(lots.map(l => l.ext_id).sort(), ['0005-23502659', '0006-23502659', '0007-23502659']);
  const hyundai = lots.find(l => l.ext_id === '0007-23502659');
  assert.equal(hyundai.title, '2016 Hyundai Accent Active');
  assert.equal(hyundai.bid, 2809);
  assert.equal(hyundai.state, 'VIC');
  const t0 = Date.now();
  const fresh = await extra.grays.refresh(hyundai);
  assert.equal(fresh.fast, true, 'read from the plain HTML, no page render');
  assert.ok(Date.now() - t0 < 3000, `quick (${Date.now() - t0} ms)`);
  assert.equal(fresh.bid, 2950);
  assert.equal(fresh.bid_count, 12);
  assert.equal(fresh.buyer_premium, 16.5);
  assert.equal(fresh.odometer, 98412);
  assert.ok(Math.abs(fresh.end_at - (Date.now() + 430000)) < 15000);
  assert.ok(extra.grays.owns(hyundai.url));
});

test('The Auction Barn (generic adapter): auctions page -> each auction -> lots from JSON + cards', { skip: !chromeOk }, async () => {
  await fakeSite('auctionbarn', 'https://theauctionbarn.com.au', BARN_HOME);
  await fakeSite('auctionbarn', 'https://bidding.theauctionbarn.com.au', BARN);
  const lots = await extra.auctionbarn.discover();
  assert.deepEqual(lots.map(l => l.ext_id).sort(), ['689027', '689061', '689605']);
  const ranger = lots.find(l => l.ext_id === '689027');
  assert.equal(ranger.bid, 1550);
  assert.equal(ranger.sale_name, 'Weekly Online Vehicle Auction');
  assert.ok(Math.abs(ranger.end_at - Date.parse(soon)) < 1000);
  assert.equal(ranger.url, 'https://bidding.theauctionbarn.com.au/lot-details/2564/689027');
  assert.equal(lots.find(l => l.ext_id === '689061').bid, 800);
});

test('Airtasker freight: category + city pages -> jobs with from/to, price, posted time', { skip: !chromeOk }, async () => {
  const { airtasker } = await import('../src/freight/sites.js');
  await fakeSite('airtasker', 'https://www.airtasker.com', AIRTASKER);
  const jobs = await airtasker.discover();
  assert.equal(jobs.length, 3);
  const couch = jobs.find(j => j.ext_id === 'x01m59jffph0bcq12w1q92vv7z9');
  assert.equal(couch.title, 'Collect couch from Fyshwick and deliver to Lyneham');
  assert.equal(couch.from_text, 'Fyshwick ACT 2609');
  assert.equal(couch.to_text, 'Lyneham ACT 2602');
  assert.equal(couch.price, 80);
  assert.equal(couch.category, 'delivery');
  assert.ok(Math.abs(couch.posted_at - (Date.now() - 17 * 3600000)) < 60000);
  const bike = jobs.find(j => /Bike/.test(j.title));
  assert.equal(bike.from_text, 'Canberra ACT 2604');
  assert.equal(bike.to_text, null);
});

test('Truckit freight: job feed read from the board page, more pages fetched directly', { skip: !chromeOk }, async () => {
  const { truckit } = await import('../src/freight/sites.js');
  await fakeSite('truckit', 'https://www.truckit.net', TRUCKIT);
  const jobs = await truckit.discover();
  assert.equal(jobs.length, 2);
  assert.ok(jobs.some(j => j.from_text === 'Somersby NSW 2250' && j.to_text === 'Williamstown VIC 3016' && j.km === 952));
  assert.ok(jobs.some(j => j.title === 'Fridge' && j.from_text === 'Fyshwick ACT 2609'), 'page 2');
});

test('Loadshift freight: table rows with their own links', { skip: !chromeOk }, async () => {
  const { loadshift } = await import('../src/freight/sites.js');
  await fakeSite('loadshift', 'https://www.loadshift.com.au', LOADSHIFT);
  const jobs = await loadshift.discover();
  assert.deepEqual(jobs.map(j => j.ext_id).sort(), ['40720315', '40778632', '40779029']);
  const ex = jobs.find(j => j.ext_id === '40720315');
  assert.equal(ex.title, 'Komatsu PC300 Excavator - 3.19m W (Oversize)'); assert.equal(ex.category, 'Machinery');
  assert.equal(ex.from_text, 'Garbutt QLD 4814'); assert.equal(ex.to_text, 'Charters Towers City QLD 4820'); assert.equal(ex.km, 137);
  assert.equal(ex.url, 'https://www.loadshift.com.au/projects/machinery-mobile/Excavator-40720315');
  const pal = jobs.find(j => j.ext_id === '40779029');
  assert.equal(pal.due_text, '1850 kg · qty 2 · ready 21 Oct');
  assert.equal(jobs.find(j => j.ext_id === '40778632').from_text, null, '"Australia" is not a pickup place');
});

test('Finds: Facebook Marketplace (logged out, login box closed) and Gumtree result pages -> listings', { skip: !chromeOk }, async () => {
  const { findSources } = await import('../src/finds/sources.js');
  const card = (id, price, title, place, extra = '') => `<div class="x9f619"><a href="/marketplace/item/${id}/?ref=search"><img src="https://scontent.xx/${id}.jpg"><div><span>${price}</span></div><div><span>${title}</span></div><div><span>${place}</span></div>${extra}</a></div>`;
  await fakeSite('facebook', 'https://www.facebook.com', {
    '/marketplace/canberra/search/': u => html(`<div role="dialog"><div aria-label="Close" role="button" onclick="this.parentNode.remove()">x</div>See more on Facebook. Log in</div><div id="feed">`
      + card('2051798579036344', 'A$1,200', 'Vending machine - snacks and drinks', 'Fyshwick, ACT')
      + card('2051798579036345', 'Free', 'Old drink machine', 'Queanbeyan, NSW')
      + `</div>`, ''),
  });
  const fb = await findSources.facebook.search('vending machine', { area: 'canberra' });
  assert.deepEqual(fb.map(i => i.ext_id), ['2051798579036344', '2051798579036345']);
  assert.equal(fb[0].price, 1200); assert.equal(fb[0].title, 'Vending machine - snacks and drinks'); assert.equal(fb[0].location, 'Fyshwick, ACT');
  assert.equal(fb[0].url, 'https://www.facebook.com/marketplace/item/2051798579036344/'); assert.equal(fb[1].price, 0);
  await fakeSite('gumtree', 'https://www.gumtree.com.au', {
    '/s-vending+machine/k0': html(`<ul><li class="user-ad"><a href="/s-ad/fyshwick/vending-machines/snack-vending-machine/1336829999"><img src="https://gumtree.test/1.jpg"><p>Snack vending machine</p><p>$650</p><p>Fyshwick, ACT</p><p>3 hours ago</p></a></li>
      <li class="user-ad"><a href="/s-ad/goulburn/vending-machines/coke-machine/1336820000"><p>Coke machine</p><p>$300</p><p>Goulburn, NSW</p><p>2 days ago</p></a></li></ul>`),
  });
  const gt = await findSources.gumtree.search('vending machine');
  assert.deepEqual(gt.map(i => i.ext_id).sort(), ['1336820000', '1336829999']);
  const snack = gt.find(i => i.ext_id === '1336829999');
  assert.equal(snack.price, 650); assert.equal(snack.title, 'Snack vending machine'); assert.equal(snack.location, 'Fyshwick, ACT');
  assert.ok(Date.now() - snack.posted_at > 2.9 * 3600000 && Date.now() - snack.posted_at < 3.1 * 3600000);
});

test('login check: a "My Pickles" menu link alone is not a logged-in session', { skip: !chromeOk }, async () => {
  const { ensureLogin } = await import('../src/login.js');
  assert.equal(await ensureLogin('pickles', 'https://www.pickles.com.au/'), false);
});

test.after(() => closeBrowser());
