// Finds: Swoopa-style searches over Facebook Marketplace, Gumtree and eBay, plus matching auction lots.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kamrads-finds-'));
process.env.DASH_USER = 'aaron'; process.env.DASH_PASS = 'a'; process.env.DASH_USERS = 'matthew:m';
process.env.GEOCODE = 'false'; process.env.PORT = '18793'; process.env.HOST = '127.0.0.1';
process.env.NTFY_URL = 'https://ntfy.test/shared';
process.env.EBAY_CLIENT_ID = 'test-id'; process.env.EBAY_CLIENT_SECRET = 'test-secret';

const pushes = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://ntfy.test/')) { const h = opts.headers?.Title || ''; const m = /^=\?UTF-8\?B\?(.+)\?=$/.exec(h); pushes.push({ title: m ? Buffer.from(m[1], 'base64').toString() : h, body: opts.body }); return new Response('ok'); }
  return realFetch(url, opts);
};

const geo = await import('../src/geo.js');
geo._setCache({ 'q:fyshwick act': { lat: -35.33, lon: 149.17, state: 'ACT' }, 'q:queanbeyan nsw': { lat: -35.35, lon: 149.23, state: 'NSW' }, 'q:goulburn nsw': { lat: -34.75, lon: 149.72, state: 'NSW' },
  'q:perth wa': { lat: -31.95, lon: 115.86, state: 'WA' }, 'q:canberra act 2600': { lat: -35.3, lon: 149.13, state: 'ACT' } });
const { cardToItem, ebayItem, fbAreaFromLink, fbAreaOf, findSources, _setFetch } = await import('../src/finds/sources.js');
const { upsertItem, fz } = await import('../src/finds/store.js');
const { fitsSearch, queriesOf, runFindAlerts, auctionMatches } = await import('../src/finds/match.js');
const { plan, scanFinds } = await import('../src/finds/loop.js');
const { upsertLot } = await import('../src/db.js');
const { startServer } = await import('../src/server.js');
startServer();
await new Promise(r => setTimeout(r, 300));
test.after(() => setTimeout(() => process.exit(0), 50));
const base = 'http://127.0.0.1:18793';
const H = u => ({ authorization: 'Basic ' + Buffer.from(u).toString('base64'), 'content-type': 'application/json' });
const api = async (m, p, body, u = 'aaron:a') => { const r = await realFetch(base + p, { method: m, headers: H(u), body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };

test('listing cards: price, title, place, posted time; Facebook areas from a pasted link', () => {
  const now = Date.now();
  const fb = cardToItem('facebook', '2051798579036344', 'https://www.facebook.com/marketplace/item/2051798579036344/', 'A$1,200\nVending machine - snacks and drinks\nFyshwick, ACT\n3 hours ago', 'https://scontent/x.jpg', now);
  assert.equal(fb.price, 1200); assert.equal(fb.title, 'Vending machine - snacks and drinks'); assert.equal(fb.location, 'Fyshwick, ACT'); assert.equal(fb.state, 'ACT');
  assert.ok(Math.abs(fb.posted_at - (now - 3 * 3600000)) < 60000);
  assert.equal(cardToItem('gumtree', '1', 'u', 'Free\nOld drink machine\nGoulburn, NSW').price, 0);
  assert.equal(cardToItem('facebook', '2', 'u', '$450\nSnack machine\nPerth, Western Australia').state, 'WA');
  assert.equal(fbAreaFromLink('https://www.facebook.com/marketplace/110884905606108/search/?query=vending%20machine'), '110884905606108');
  assert.equal(fbAreaFromLink('https://www.facebook.com/marketplace/canberra/search?query=x'), 'canberra');
  assert.equal(fbAreaFromLink('https://www.facebook.com/marketplace/item/2051798579036344/'), null);
  assert.equal(fbAreaOf({ lat: -35.33, lon: 149.17 }), 'canberra'); assert.equal(fbAreaOf({ lat: -32.37, lon: 115.86 }), 'perth');
  assert.equal(fbAreaOf({ fb_area: '106270089409734', lat: 0, lon: 0 }), '106270089409734');
  assert.deepEqual(queriesOf('vending machine -toy -miniature, snack machine'), ['vending machine', 'snack machine']);
});

test('eBay: official search, AU listings, current bid for auctions', async () => {
  const calls = [];
  _setFetch(async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.authorization, mkt: init.headers['x-ebay-c-marketplace-id'] });
    if (/oauth2\/token/.test(url)) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }));
    return new Response(JSON.stringify({ itemSummaries: [
      { itemId: 'v1|123|0', legacyItemId: '123', title: 'Vendo Snack Vending Machine', price: { value: '1500.00' }, itemWebUrl: 'https://www.ebay.com.au/itm/123',
        itemLocation: { city: 'Queanbeyan', stateOrProvince: 'NSW', postalCode: '2620', country: 'AU' }, image: { imageUrl: 'https://i.ebayimg.com/1.jpg' }, itemCreationDate: '2026-10-22T01:00:00.000Z', buyingOptions: ['FIXED_PRICE'] },
      { itemId: 'v1|456|0', legacyItemId: '456', title: 'Drink vending machine', price: { value: '900' }, currentBidPrice: { value: '310' }, itemWebUrl: 'https://www.ebay.com.au/itm/456',
        itemLocation: { stateOrProvince: 'WA', postalCode: '6000', country: 'AU' }, buyingOptions: ['AUCTION'] }] }));
  });
  const items = await findSources.ebay.search('vending machine');
  assert.equal(calls[0].auth, 'Basic ' + Buffer.from('test-id:test-secret').toString('base64'));
  assert.match(calls[1].url, /q=vending\+machine/); assert.match(calls[1].url, /itemLocationCountry%3AAU/); assert.equal(calls[1].mkt, 'EBAY_AU');
  assert.equal(items[0].ext_id, '123'); assert.equal(items[0].price, 1500); assert.equal(items[0].location, 'Queanbeyan NSW 2620'); assert.equal(items[0].state, 'NSW');
  assert.equal(items[1].price, 310, 'auction: the current bid');
  await findSources.ebay.search('snack machine');
  assert.equal(calls.filter(c => /oauth2/.test(c.url)).length, 1, 'token reused');
});

test('matching: words with exclusions, price range, within the distance; unknown places only in the same state', () => {
  const s = { terms: 'vending machine -toy, snack machine', lat: -35.33, lon: 149.17, state: 'ACT', radius_km: 150, min_price: null, max_price: 3000, sources: 'facebook,gumtree,ebay' };
  const it = (o) => ({ site: 'facebook', title: 'Vending machine', price: 1200, location: 'Queanbeyan NSW', ...o });
  assert.ok(fitsSearch(s, it()).km < 20);
  assert.ok(fitsSearch(s, it({ location: 'Goulburn NSW' })).km <= 150);
  assert.equal(fitsSearch(s, it({ location: 'Perth WA' })), null, 'too far');
  assert.equal(fitsSearch(s, it({ title: 'Toy vending machine' })), null, 'excluded word');
  assert.equal(fitsSearch(s, it({ price: 5000 })), null, 'over the max');
  assert.ok(fitsSearch(s, it({ title: 'Snack machine, works' })));
  assert.equal(fitsSearch(s, it({ title: 'Washing machine' })), null);
  assert.deepEqual(fitsSearch(s, it({ location: 'Somewhere, ACT', state: 'ACT' })), { km: null }, 'unknown suburb, same state');
  assert.equal(fitsSearch(s, it({ location: 'Somewhere, VIC', state: 'VIC' })), null);
  assert.equal(fitsSearch({ ...s, sources: 'ebay' }, it()), null, 'site not in this search');
  assert.ok(fitsSearch({ ...s, lat: null, radius_km: null }, it({ location: 'Perth WA' })), 'no place: anywhere');
});

test('alerts: a new search records what is already out there quietly, then pushes new listings once', async () => {
  const r = await api('POST', '/api/finds/searches', { name: 'Vending ACT', terms: 'vending machine -toy', place: 'Fyshwick ACT', radius: 150, sources: ['ebay'] });
  assert.equal(r.status, 200);
  const id = r.json.id;
  await scanFinds();            // its first scan (eBay fake above): both listings found; Queanbeyan is near
  assert.equal(pushes.length, 0, 'first scan is quiet');
  let res = (await api('GET', `/api/finds/searches/${id}`)).json;
  assert.deepEqual(res.items.map(i => i.title), ['Vendo Snack Vending Machine'], 'Perth one is too far');
  await new Promise(r => setTimeout(r, 5));
  upsertItem({ site: 'ebay', ext_id: '789', url: 'https://www.ebay.com.au/itm/789', title: 'Coke vending machine', price: 800, location: 'Fyshwick ACT', posted_at: Date.now() });
  await runFindAlerts(); await runFindAlerts();
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].title, /1 new: Vending ACT/); assert.match(pushes[0].body, /Coke vending machine — \$800 · Fyshwick ACT \(\d+ km\) · eBay/);
  // an old listing seen for the first time doesn't count as new
  upsertItem({ site: 'ebay', ext_id: '790', url: 'u', title: 'Old vending machine', price: 100, location: 'Fyshwick ACT', posted_at: Date.now() - 20 * 864e5 });
  await runFindAlerts();
  assert.equal(pushes.length, 1);
});

test('auction lots that match show with the search, nearest first', async () => {
  const now = Date.now();
  upsertLot({ site: 'grays', ext_id: '0010-1', title: 'Coca-Cola Vending Machine', bid: 150, end_at: now + 3600000, location: 'Mitchell, ACT', state: 'ACT', url: 'https://www.grays.com/lot/0010-1/x' });
  upsertLot({ site: 'lloyds', ext_id: '77', title: 'Snack Vending Machine with coin mech', bid: 60, end_at: now + 7200000, location: 'Perth, WA', state: 'WA', url: 'https://x/77' });
  upsertLot({ site: 'pickles', ext_id: '5', title: 'Toyota Hilux', bid: 6000, end_at: now + 3600000, url: 'https://x/5' });
  const m = auctionMatches({ terms: 'vending machine -toy', lat: -35.33, lon: 149.17 });
  assert.deepEqual(m.map(x => x.l.ext_id), ['0010-1', '77']);
  const list = (await api('GET', '/api/finds/searches')).json.searches;
  const s = list.find(x => x.name === 'Vending ACT');
  assert.equal(s.auctions, 2);
  const res = (await api('GET', `/api/finds/searches/${s.id}`)).json;
  assert.equal(res.lots[0].title, 'Coca-Cola Vending Machine'); assert.ok(res.lots[0].allIn > 150, 'all-in includes fees');
});

test('API: first visit gets a Vending machines search; searches are per person; edits restart quietly; bad input refused', async () => {
  const mm = (await api('GET', '/api/finds/searches', null, 'matthew:m')).json.searches;
  assert.equal(mm.length, 1); assert.equal(mm[0].name, 'Vending machines'); assert.ok(mm[0].radius > 0);
  assert.equal((await api('GET', '/api/finds/searches', null, 'matthew:m')).json.searches.length, 1, 'seeded once');
  assert.ok(!(await api('GET', '/api/finds/searches')).json.searches.some(s => s.name === 'Vending machines' && false));
  assert.equal((await api('POST', '/api/finds/searches', { terms: '-toy' })).status, 400);
  assert.equal((await api('POST', '/api/finds/searches', { terms: 'forklift', place: 'Zzzqx' })).status, 400);
  assert.equal((await api('POST', '/api/finds/searches', { terms: 'forklift', sources: [] })).status, 400);
  assert.equal((await api('POST', '/api/finds/searches', { terms: 'forklift', fbLink: 'https://www.facebook.com/groups/123' })).status, 400);
  const ok = await api('POST', '/api/finds/searches', { terms: 'forklift', fbLink: 'https://www.facebook.com/marketplace/106270089409734/search/?query=forklift', sources: ['facebook'] });
  assert.equal(ok.status, 200);
  assert.equal((await api('GET', `/api/finds/searches/${ok.json.id}`)).json.search.fbArea, '106270089409734');
  assert.equal((await api('GET', `/api/finds/searches/${ok.json.id}`, null, 'matthew:m')).status, 404, "not Matthew's");
  assert.equal((await api('PATCH', `/api/finds/searches/${ok.json.id}`, { alerts: false })).status, 200);
  assert.equal((await api('GET', `/api/finds/searches/${ok.json.id}`)).json.search.alerts, false);
  assert.equal((await api('PATCH', `/api/finds/searches/${ok.json.id}`, { terms: 'forklift, pallet jack' })).status, 200);
  assert.equal(fz.search.get(ok.json.id).primed, 0, 'changed search starts quiet again');
  const st = (await api('GET', '/api/finds/status')).json;
  assert.deepEqual(st.sources.map(s => s.site), ['facebook', 'gumtree', 'ebay']);
  assert.equal(st.sources.find(s => s.site === 'ebay').needsKeys, false);
  assert.match(await (await realFetch(base + '/finds', { headers: H('aaron:a') })).text(), /window\.__PREFS=/);
  assert.equal((await api('DELETE', `/api/finds/searches/${ok.json.id}`)).status, 200);
});

test('plan: each site/phrase/area read once for all the searches that need it', () => {
  const p = plan([
    { id: 1, terms: 'vending machine, snack machine', sources: 'facebook,ebay', lat: -35.33, lon: 149.17 },
    { id: 2, terms: 'vending machine', sources: 'facebook,ebay', lat: -35.3, lon: 149.1 },
    { id: 3, terms: 'vending machine', sources: 'facebook', lat: -31.95, lon: 115.86 },
  ]);
  const keys = p.map(j => `${j.site}|${j.phrase}|${j.area || ''}`).sort();
  assert.deepEqual(keys, ['ebay|snack machine|', 'ebay|vending machine|', 'facebook|snack machine|canberra', 'facebook|vending machine|canberra', 'facebook|vending machine|perth']);
  assert.deepEqual([...p.find(j => j.site === 'ebay' && j.phrase === 'vending machine').searches], [1, 2]);
});
