// Where Finds look: eBay (official Browse API), Gumtree (public search pages) and Facebook Marketplace
// (public search pages, logged out: best effort - Facebook shows a limited set before asking to log in).
// Each reader takes one search phrase (+ an area for Facebook) and returns listings:
//   { site, ext_id, url, title, price, location, state, image, posted_at }
import { withPage, looksBlocked } from '../browser.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { parseAgo } from '../freight/parse.js';
import { haversineKm } from '../geo.js';

const tidy = s => String(s || '').replace(/\s+/g, ' ').trim();
const ST = /\b(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b/;
const STATE_NAMES = { 'new south wales': 'NSW', victoria: 'VIC', queensland: 'QLD', 'western australia': 'WA', 'south australia': 'SA', tasmania: 'TAS', 'australian capital territory': 'ACT', 'northern territory': 'NT' };
const stateOf = t => { const m = ST.exec(t || ''); if (m) return m[1]; const low = String(t || '').toLowerCase(); for (const [n, s] of Object.entries(STATE_NAMES)) if (low.includes(n)) return s; return null; };
const priceOf = t => { if (/\bfree\b/i.test(t || '')) return 0; const m = /A?\$\s?([\d,]+(?:\.\d{1,2})?)/.exec(t || ''); return m ? Number(m[1].replace(/,/g, '')) : null; };

/** One listing card (its link + text lines) -> fields. Lines: price, title, "Fyshwick, ACT", "3 hours ago"... */
export function cardToItem(site, id, href, text, image = null, now = Date.now()) {
  const lines = String(text || '').split('\n').map(tidy).filter(Boolean);
  const isPrice = l => /^(?:A?\$\s?[\d,]+(?:\.\d{1,2})?|free)(?:\s|$)/i.test(l);
  const isPlace = l => /^[A-Z][A-Za-z' .-]+,\s*(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT|New South Wales|Victoria|Queensland|Western Australia|South Australia|Tasmania|Australian Capital Territory|Northern Territory)\b/i.test(l);
  const isTime = l => /\bago\b|^(?:today|yesterday|just listed)/i.test(l) || /^\d+\s*(?:km|mi)\s+away$/i.test(l);
  const price = priceOf(lines.find(isPrice) || '');
  const location = lines.find(isPlace) || null;
  const title = lines.find(l => !isPrice(l) && !isPlace(l) && !isTime(l) && l.length > 2 && !/^(?:sponsored|new|featured|top ad|urgent|see more|message|save)$/i.test(l)) || null;
  const ago = lines.find(l => /\bago\b|yesterday|just now/i.test(l));
  return { site, ext_id: String(id), url: href, title: title ? title.slice(0, 200) : null, price, location: location ? location.slice(0, 120) : null,
    state: stateOf(location), image: image || null, posted_at: ago ? parseAgo(ago, now) : null };
}

/** Cards on a results page: each link matching re, with the text of its own card (climbing while the box holds only this one). */
const cards = (page, src) => page.evaluate(src => {
  const rx = new RegExp(src, 'i');
  const out = new Map();
  for (const a of document.querySelectorAll('a[href]')) {
    const m = rx.exec(a.href);
    if (!m) continue;
    let box = a;
    for (let i = 0; i < 6 && box.parentElement; i++) {
      const p = box.parentElement;
      const ids = new Set([...p.querySelectorAll('a[href]')].map(x => (rx.exec(x.href) || [])[1]).filter(Boolean));
      if (ids.size > 1) break;
      box = p;
    }
    const img = box.querySelector('img');
    const text = (box.innerText || a.innerText || '').trim();
    const prev = out.get(m[1]);
    if (!prev || text.length > prev.text.length) out.set(m[1], { id: m[1], href: a.href.split('?')[0], text, image: img?.currentSrc || img?.src || '' });
  }
  return [...out.values()];
}, src);

// ---- Facebook Marketplace (logged out) ----
// Areas: a pasted Marketplace link's area ("106270089409734" or "canberra"), else the nearest city.
const FB_CITIES = { sydney: [-33.87, 151.21], melbourne: [-37.81, 144.96], brisbane: [-27.47, 153.03], perth: [-31.95, 115.86], adelaide: [-34.93, 138.6],
  canberra: [-35.28, 149.13], hobart: [-42.88, 147.33], darwin: [-12.46, 130.84], newcastle: [-32.93, 151.78], wollongong: [-34.42, 150.89], goldcoast: [-28.02, 153.4],
  geelong: [-38.15, 144.36], townsville: [-19.26, 146.82], cairns: [-16.92, 145.77], toowoomba: [-27.56, 151.95], launceston: [-41.43, 147.14], albury: [-36.08, 146.92],
  ballarat: [-37.56, 143.85], bendigo: [-36.76, 144.28] };   // (smaller towns: paste a Marketplace link for the exact area)
export function fbAreaOf(s) {
  if (s.fb_area) return s.fb_area;
  if (s.lat == null) return 'sydney';
  return Object.entries(FB_CITIES).map(([k, c]) => [k, haversineKm([s.lat, s.lon], c)]).sort((a, b) => a[1] - b[1])[0][0];
}
/** "https://www.facebook.com/marketplace/110884905606108/search/?query=..." -> "110884905606108" */
export const fbAreaFromLink = link => (/facebook\.com\/marketplace\/([a-z0-9-]+)(?:\/|$|\?)/i.exec(String(link || '')) || [])[1]?.replace(/^(?:item|search|category|you)$/i, '') || null;

export const facebook = {
  site: 'facebook', label: 'Facebook',
  async search(query, { area = 'sydney' } = {}) {
    const url = `https://www.facebook.com/marketplace/${encodeURIComponent(area)}/search/?query=${encodeURIComponent(query)}&sortBy=creation_time_descend&exact=false`;
    const r = await withPage('facebook', url, async page => {
      // close the "log in to see more" box if it covers the results
      await page.keyboard.press('Escape').catch(() => {});
      await page.locator('[aria-label="Close"]').first().click({ timeout: 1500 }).catch(() => {});
      for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 2200); await page.waitForTimeout(900); }
      return cards(page, 'facebook\\.com\\/marketplace\\/item\\/(\\d{6,})');
    }, { waitMs: 2500 });
    if (looksBlocked(r)) throw new Error(`blocked by Facebook (HTTP ${r.status})`);
    const items = (r.result || []).map(c => cardToItem('facebook', c.id, `https://www.facebook.com/marketplace/item/${c.id}/`, c.text, c.image)).filter(i => i.title);
    if (!items.length && /log in|login|sign up/i.test(r.text || '')) throw new Error('Facebook showed only its login page (no public listings this time)');
    return items;
  },
};

// ---- Gumtree (public search pages, newest first) ----
export const gumtree = {
  site: 'gumtree', label: 'Gumtree',
  async search(query) {
    const slug = query.trim().toLowerCase().replace(/[^a-z0-9]+/g, '+').replace(/^\+|\+$/g, '');
    const url = `https://www.gumtree.com.au/s-${slug}/k0?sort=date`;
    const r = await withPage('gumtree', url, page => cards(page, 'gumtree\\.com\\.au\\/s-ad\\/[^?#]*?\\/(\\d{6,})'), { scrolls: 2, waitMs: 2000 });
    if (looksBlocked(r)) throw new Error(`blocked by Gumtree (HTTP ${r.status})`);
    return (r.result || []).map(c => cardToItem('gumtree', c.id, c.href, c.text, c.image)).filter(i => i.title);
  },
};

// ---- eBay (Browse API: free developer keys, EBAY_CLIENT_ID / EBAY_CLIENT_SECRET) ----
let token = null;
let fetchImpl = (...a) => fetch(...a);
export const _setFetch = f => { fetchImpl = f; token = null; };
async function ebayToken() {
  if (token && token.until > Date.now() + 60000) return token.value;
  const { clientId, clientSecret } = config.finds.ebay;
  const res = await fetchImpl('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64') },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
  });
  if (!res.ok) throw new Error(`eBay login refused (HTTP ${res.status}) - check EBAY_CLIENT_ID / EBAY_CLIENT_SECRET`);
  const j = await res.json();
  token = { value: j.access_token, until: Date.now() + (Number(j.expires_in) || 7200) * 1000 };
  return token.value;
}
export function ebayItem(x) {
  const loc = x.itemLocation || {};
  const location = [loc.city, loc.stateOrProvince, loc.postalCode].filter(Boolean).join(' ') || null;
  const p = x.currentBidPrice || x.price;
  return { site: 'ebay', ext_id: String(x.legacyItemId || x.itemId), url: x.itemWebUrl, title: tidy(x.title).slice(0, 200),
    price: p?.value != null ? Number(p.value) : null, location, state: stateOf(loc.stateOrProvince || location),
    image: x.image?.imageUrl || x.thumbnailImages?.[0]?.imageUrl || null, posted_at: x.itemCreationDate ? Date.parse(x.itemCreationDate) : null,
    description: (x.buyingOptions || []).includes('AUCTION') ? 'auction' : '' };
}
export const ebay = {
  site: 'ebay', label: 'eBay',
  enabled: () => !!(config.finds.ebay.clientId && config.finds.ebay.clientSecret),
  async search(query) {
    if (!this.enabled()) throw new Error('eBay keys not set (EBAY_CLIENT_ID / EBAY_CLIENT_SECRET)');
    const u = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
    u.searchParams.set('q', query); u.searchParams.set('limit', '100'); u.searchParams.set('sort', 'newlyListed');
    u.searchParams.set('filter', 'itemLocationCountry:AU');
    const res = await fetchImpl(u.toString(), { signal: AbortSignal.timeout(20000), headers: { authorization: `Bearer ${await ebayToken()}`, 'x-ebay-c-marketplace-id': 'EBAY_AU', accept: 'application/json' } });
    if (res.status === 401) { token = null; throw new Error('eBay key expired, will retry'); }
    if (!res.ok) throw new Error(`eBay search HTTP ${res.status}`);
    const j = await res.json();
    return (j.itemSummaries || []).map(ebayItem).filter(i => i.url && i.title);
  },
};

export const findSources = { facebook, gumtree, ebay };
export const sourceOn = name => config.finds[name]?.enabled !== false && (name !== 'ebay' || ebay.enabled());
export { log };
