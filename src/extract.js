// Schema-agnostic lot extraction.
// Auction sites change their JSON field names without notice, so instead of hard-coding one
// schema we walk every JSON payload the page loads and recognise "lot-shaped" objects by
// their key names (an id + a title-ish field + a bid / close time / odometer).

const norm = k => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

const ID_KEYS = ['stocknumber', 'stockno', 'stockid', 'stock', 'aucid', 'auctionid', 'itemid', 'productid', 'vehicleid', 'assetid',
  'listingid', 'auctionitemid', 'salelotid', 'lotid', 'inventoryid', 'id'];
const LOTNO_KEYS = ['lotnumber', 'lotno', 'lot', 'lotnum', 'aucreferenceno', 'referenceno'];
const TITLE_KEYS = ['title', 'auctitle', 'name', 'heading', 'displayname', 'producttitle', 'vehicletitle', 'shortdescription', 'description'];
const URL_KEYS = ['url', 'aucurl', 'auclink', 'aucseourl', 'detailsurl', 'detailurl', 'producturl', 'permalink', 'link', 'href', 'canonicalurl', 'seourl', 'slug'];
const IMG_KEYS = ['image', 'aucthumbnailurl', 'aucimageurl', 'imageurl', 'thumbnail', 'thumbnailurl', 'mainimage', 'primaryimage', 'photo', 'photourl', 'images', 'photos', 'media'];
const ODO_KEYS = ['odometer', 'odometerreading', 'odometervalue', 'kms', 'kilometres', 'kilometers', 'mileage', 'odo'];
const WOVR_KEYS = ['wovr', 'wovrstatus', 'writeoff', 'writeofftype', 'writeoffstatus', 'writtenoff', 'wovrtype'];
const LOC_KEYS = ['location', 'auccity', 'locationname', 'branch', 'branchname', 'suburb', 'city', 'yard', 'yardname', 'salelocation', 'itemlocation', 'site'];
const STATE_KEYS = ['state', 'aucstate', 'statecode', 'locationstate', 'region'];
const BUYMETHOD_KEYS = ['buymethod', 'sellingmethod', 'sellingmethodname', 'saletype', 'saleschannel', 'channel', 'auctiontype'];
const SALE_KEYS = ['salename', 'auctionname', 'eventname', 'saletitle', 'eventtitle'];
const CAT_KEYS = ['category', 'producttype', 'producttypetitle', 'itemtype', 'assettype', 'vehicletype', 'lineofbusiness'];

const isBidKey = k => k.includes('bid') && /current|highest|high|top|leading|winning|latest|amount|value|price/.test(k)
  && !/increment|count|start|min|next|reserve|step|end|date|time|status|(?<!b)id$|type|history|number|total|user|bidder|placed|open/.test(k);
const isPriceFallbackKey = k => ['currentprice', 'highestoffer', 'currentoffer', 'price'].includes(k);
const isBuyNowKey = k => k.includes('buynow') && /price|amount|value/.test(k);
const isStartKey = k => /^(starting|start|opening|minimum|min)(bid|price)(amount|value)?$/.test(k);
const isBidCountKey = k => k === 'bids' || /(bidcount|bidscount|numberofbids|numbids|totalbids)$/.test(k);
const isEndKey = k => (/(end|close|closing|expir|finish)/.test(k) && /(date|time|utc|at|on)$/.test(k))
  || ['bidend', 'auctionend', 'enddate', 'endtime', 'closedate', 'closetime', 'closingdate', 'expirydate', 'productbidend', 'endsat', 'closesat'].includes(k);
const STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];

export function parseMoney(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v === 'object') return parseMoney(v.amount ?? v.value ?? v.price ?? null);
  const m = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return n >= 0 ? n : null;
}

export function parseInt0(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Math.round(v);
  if (typeof v === 'object') return parseInt0(v.value ?? v.amount ?? null);
  const m = String(v).replace(/,/g, '').match(/\d+/);
  return m ? Number(m[0]) : null;
}

// Offset (ms) of Australia/Sydney from UTC at a given instant.
function sydneyOffsetMs(utcMs) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const g = t => Number(parts.find(p => p.type === t).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - utcMs;
}

/** Parse a close time: epoch s/ms, ISO with zone, or a zone-less local time (taken as Sydney time). */
export function parseTime(v, now = Date.now()) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    const ms = v < 1e11 ? v * 1000 : v;
    return ms > 946684800000 ? ms : null;
  }
  const s = String(v).trim();
  if (/^\d{10,13}$/.test(s)) return parseTime(Number(s), now);
  const ms = /^\/Date\((\d+)/.exec(s); // .NET style
  if (ms) return Number(ms[1]);
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (iso) {
    const [, y, mo, d, h, mi, se = '0', zone] = iso;
    if (zone) return Date.parse(s.replace(' ', 'T'));
    const naive = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
    return naive - sydneyOffsetMs(naive - sydneyOffsetMs(naive));
  }
  const p = Date.parse(s);
  return Number.isFinite(p) ? p : null;
}

/** "2d 3h 14m", "03:12:45", "14 mins 3 secs" -> ms from now */
export function parseCountdown(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  const hms = /\b(?:(\d+)\s*d(?:ays?)?\s*)?(\d{1,2}):(\d{2}):(\d{2})\b/.exec(t);
  if (hms) return (((+hms[1] || 0) * 24 + +hms[2]) * 60 + +hms[3]) * 60000 + +hms[4] * 1000;
  let total = 0, hit = false;
  for (const [re, mult] of [[/(\d+)\s*(?:d|day|days)\b/, 86400000], [/(\d+)\s*(?:h|hr|hrs|hour|hours)\b/, 3600000],
    [/(\d+)\s*(?:m|min|mins|minute|minutes)\b/, 60000], [/(\d+)\s*(?:s|sec|secs|second|seconds)\b/, 1000]]) {
    const m = re.exec(t);
    if (m) { total += +m[1] * mult; hit = true; }
  }
  return hit ? total : null;
}

export function normaliseWovr(v) {
  if (v == null) return null;
  const s = String(v).toLowerCase();
  if (!s.trim()) return null;
  if (/statutory/.test(s)) return 'Statutory Write-Off';
  if (/inspection\s*passed/.test(s)) return 'Inspection Passed Repairable';
  if (/repairable/.test(s)) return 'Repairable Write-Off';
  if (/n\/?a|not\s*applicable|none|^no$|false/.test(s)) return 'WOVR N/A';
  return String(v).trim();
}

function pickImage(v) {
  if (!v) return null;
  if (typeof v === 'string') return /^(https?:)?\/\//.test(v) || v.startsWith('/') ? v : null;
  if (Array.isArray(v)) return pickImage(v[0]);
  if (typeof v === 'object') return pickImage(v.url ?? v.src ?? v.imageUrl ?? v.large ?? v.medium ?? v.thumbnail ?? null);
  return null;
}

const scalar = v => v == null || ['string', 'number', 'boolean'].includes(typeof v);

/** Flatten an object's own scalar fields plus one level of nested objects into normalised-key -> value. */
function flatFields(obj) {
  const out = new Map();
  const add = (k, v) => { if (!out.has(k) && v !== undefined) out.set(k, v); };
  for (const [k, v] of Object.entries(obj)) {
    const nk = norm(k);
    if (scalar(v)) add(nk, v);
    else if (Array.isArray(v)) { if (IMG_KEYS.includes(nk)) add(nk, v); }
    else if (typeof v === 'object') {
      if (['amount', 'value', 'price'].some(x => x in v) && Object.keys(v).length <= 4) add(nk, v);
      if (IMG_KEYS.includes(nk)) add(nk, v);
      for (const [k2, v2] of Object.entries(v)) {
        const nk2 = norm(k2);
        if (scalar(v2)) { add(nk2, v2); add(nk + nk2, v2); }
        else if (v2 && typeof v2 === 'object' && !Array.isArray(v2) && ['amount', 'value'].some(x => x in v2)) { add(nk2, v2); add(nk + nk2, v2); }
      }
    }
  }
  return out;
}

const firstOf = (f, keys) => { for (const k of keys) { const v = f.get(k); if (v != null && v !== '') return v; } return null; };
const firstWhere = (f, pred) => { for (const [k, v] of f) if (pred(k) && v != null && v !== '') return v; return null; };
const keyWhere = (f, pred) => { for (const [k, v] of f) if (pred(k) && v != null && v !== '') return k; return null; };

/** Turn one candidate object into a normalised lot, or null if it isn't lot-shaped. */
export function lotFromObject(obj, now = Date.now()) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const f = flatFields(obj);
  const id = firstOf(f, ID_KEYS);
  if (id == null || typeof id === 'boolean') return null;
  const year = parseInt0(firstOf(f, ['year', 'buildyear', 'yearofmanufacture', 'manufactureyear', 'compliancedate', 'modelyear']));
  const make = firstOf(f, ['make', 'makename', 'brand', 'manufacturer']);
  const model = firstOf(f, ['model', 'modelname', 'family']);
  const variant = firstOf(f, ['variant', 'series', 'badge', 'trim']);
  let title = firstOf(f, TITLE_KEYS);
  if (typeof title !== 'string' || title.length > 200 || /\{\{/.test(title)) title = null;
  const builtTitle = [year, make, model, variant].filter(Boolean).join(' ').trim();
  if (!title || (builtTitle && title.length < builtTitle.length)) title = builtTitle || title;

  const bidRaw = firstWhere(f, isBidKey) ?? firstWhere(f, isPriceFallbackKey);
  const endRaw = firstWhere(f, isEndKey);
  const odoRaw = firstOf(f, ODO_KEYS);
  const buyNowRaw = firstWhere(f, isBuyNowKey);
  const startRaw = firstWhere(f, isStartKey);

  if (!title) return null;
  if (bidRaw == null && endRaw == null && odoRaw == null && buyNowRaw == null && startRaw == null) return null;

  let state = firstOf(f, STATE_KEYS);
  state = state && STATES.includes(String(state).toUpperCase()) ? String(state).toUpperCase() : null;
  let location = firstOf(f, LOC_KEYS);
  if (location && typeof location !== 'string') location = null;
  if (!state && location) {
    const m = String(location).match(/\b(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b/);
    if (m) state = m[1];
  }
  const wovrRaw = firstOf(f, WOVR_KEYS);
  const url = firstOf(f, URL_KEYS);
  const cat = firstOf(f, CAT_KEYS);

  return {
    ext_id: String(id),
    title: String(title).replace(/\s+/g, ' ').trim(),
    year: year && year > 1900 && year < 2100 ? year : null,
    make: make ? String(make) : null,
    model: model ? String(model) : null,
    odometer: parseInt0(odoRaw),
    wovr: normaliseWovr(typeof wovrRaw === 'boolean' ? (wovrRaw ? 'Repairable Write-Off' : 'WOVR N/A') : wovrRaw),
    location: location ? String(location) : null,
    state,
    url: typeof url === 'string' ? url : null,
    image: pickImage(firstOf(f, IMG_KEYS)),
    buy_method: (v => (typeof v === 'string' ? v : null))(firstOf(f, BUYMETHOD_KEYS)),
    sale_name: (v => (typeof v === 'string' ? v : null))(firstOf(f, SALE_KEYS)),
    category: typeof cat === 'string' ? cat : null,
    lot_no: (v => (v == null || typeof v === 'object' ? null : String(v)))(firstOf(f, LOTNO_KEYS)),
    bid: (b => (b > 0 ? b : null))(parseMoney(bidRaw)), // 0 means "no bids yet" (or hidden), not a $0 bid
    bid_count: parseInt0(firstWhere(f, isBidCountKey)),
    buy_now: parseMoney(buyNowRaw),
    start_price: (b => (b > 0 ? b : null))(parseMoney(startRaw)),
    // a field named ...Utc holding a zone-less time (ALLBIDS aucCloseUtc) is UTC, not Sydney time
    end_at: parseTime(typeof endRaw === 'string' && /utc/.test(keyWhere(f, isEndKey) || '') && /\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(endRaw) ? endRaw.replace(' ', 'T') + 'Z' : endRaw, now),
  };
}

const richness = l => Object.values(l).filter(v => v != null).length;

/** Walk any JSON value and return every lot-shaped object found (deduped by id, richest wins). */
export function lotsFromJson(json, now = Date.now()) {
  const found = new Map();
  const seen = new Set();
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 14 || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    const lot = lotFromObject(v, now);
    if (lot) {
      const prev = found.get(lot.ext_id);
      if (!prev) found.set(lot.ext_id, lot);
      else for (const [k, val] of Object.entries(lot)) if (prev[k] == null && val != null) prev[k] = val;
      return; // its nested objects (vehicle, auction, location...) belong to this lot, not separate lots
    }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(json, 0);
  return [...found.values()].sort((a, b) => richness(b) - richness(a));
}

/** Pull bid / close / odometer / WOVR out of a detail page's visible text. */
export function factsFromText(text, now = Date.now()) {
  const t = String(text || '').replace(/ /g, ' ');
  const out = {};
  const money = re => { const m = re.exec(t); return m ? parseMoney(m[m.length - 1]) : null; };
  out.bid = money(/(?:current|highest|high|top|winning|leading)\s*(?:top\s*)?bid\s*(?:\(\s*\[?\s*\d+\s*bids?\s*\]?\s*\))?\s*(?:is|:)?\s*(?:AU)?\$\s?([\d,]+(?:\.\d+)?)/i)
    ?? money(/(?<!(?:starting|start|opening|minimum|min|next|reserve)\s*)\bbid\s*:?\s*(?:AU)?\$\s?([\d,]+(?:\.\d+)?)/i);
  out.start_price = money(/(?:starting|start|opening|minimum)\s*(?:bid|price)\s*:?\s*(?:AU)?\$\s?([\d,]+)/i);
  out.buy_now = money(/buy\s*now\s*(?:price)?\s*:?\s*(?:AU)?\$\s?([\d,]+)/i);
  // Bid count: explicit labels first ("Total Bids Recorded: 10"), then "12 bids" - but never site-wide
  // counters ("929,512 bids placed this week") and never implausibly large numbers.
  const bc = /total\s+bids?\s*(?:recorded|placed)?\s*:?\s*(\d{1,4})\b/i.exec(t)
    || /\b(?:bids?|bid\s*count)\s*:\s*(\d{1,4})\b/i.exec(t)
    || /(?<![\d,])(\d{1,3})\s+bids?\b(?!\s*(?:placed|this|today|so\s+far\s+this))/i.exec(t);
  out.bid_count = bc && +bc[1] <= 500 ? +bc[1] : (/\bno\s+bids\b/i.test(t) ? 0 : null);
  // "Indicated Odometer Reading: 332204" (Grays: no unit), "Odometer: 85,000 km", else "85,000 km"
  const odo = /\b(?:indicated\s+)?odometer(?:\s+reading)?\s*(?:\(km\))?\s*:?\s*([\d,]{1,9})\b/i.exec(t) || /\bkms?\s*:\s*([\d,]{1,9})\b/i.exec(t) || /([\d,]{1,9})\s*(?:km|kms|kilometres)\b/i.exec(t);
  const km = odo ? parseInt0(odo[1]) : null;
  out.odometer = km != null && km > 0 && km < 2000000 ? km : null;
  const w = /(statutory\s*write-?\s*off|inspection\s*passed\s*repairable\s*write-?\s*off|repairable\s*write-?\s*off|wovr\s*n\/a)/i.exec(t);
  out.wovr = w ? normaliseWovr(w[1]) : null;
  // Close time: a countdown first, then an explicit date.
  // (Grays' final phase reads "Going, going, gone: 4m 9s")
  const cd = /(?:ends?|closes?|closing|time\s*left|time\s*remaining|remaining|ending\s+in|going,?\s*going,?\s*gone!?)\s*(?:in)?\s*:?\s*((?:\d+\s*d(?:ays?)?\s*)?\d{1,2}:\d{2}:\d{2}|(?:\d+\s*(?:d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)\s*){1,4})/i.exec(t);
  const cdMs = cd ? parseCountdown(cd[1]) : null;
  if (cdMs != null) out.end_at = now + cdMs;
  else {
    const dt = /(?:ends?|closes?|closing|auction\s*end)\s*(?:on|at)?\s*:?\s*([A-Z][a-z]{2,8},?\s+\d{1,2}\s+[A-Z][a-z]{2,8}\s+\d{4}[^\n]{0,20}|\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*(?:am|pm)?)/i.exec(t);
    if (dt) out.end_at = parseAuDate(dt[1]);
    else {
      const rel = /\b(today|tomorrow)\s*(?:at)?\s*(\d{1,2}):(\d{2})\s*(am|pm)\b/i.exec(t);
      if (rel) out.end_at = relativeSydney(rel[1], +rel[2], +rel[3], rel[4], now);
    }
  }
  const loc = /([A-Z][A-Za-z .'-]{2,30}),\s*(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b/.exec(t);
  if (loc) { out.location = `${loc[1].trim()}, ${loc[2]}`; out.state = loc[2]; }
  // Bidding over ("Bidding closed", "Auction has ended", "This lot has closed")
  if (/\bbidding\s+(?:has\s+)?(?:closed|ended)\b|\bauction\s+(?:has\s+)?(?:closed|ended)\b|\b(?:this\s+)?lot\s+(?:has\s+|is\s+)?closed\b|\bclosed\s+for\s+bidding\b/i.test(t)) out.closed = true;
  // Lot already gone before its listed close (sold early / withdrawn): Pickles shows "SOLD - No longer available"
  if (/no longer available|this (?:item|lot|vehicle) (?:has been|is) (?:sold|withdrawn)|lot (?:has been )?withdrawn|item withdrawn/i.test(t)) out.gone = true;
  // Reserve: "Reserve not met" / "No Reserve" / "Reserve met" (not the "once the reserve is met..." help text)
  if (/\breserve\s+not\s+(?:yet\s+)?met\b/i.test(t)) out.reserve = 'not met';
  else if (/\bno\s+reserve\b|\bunreserved\b|\babsolute\s+sale\b/i.test(t)) out.reserve = 'none';
  else if (/\breserve\s+(?:has\s+been\s+)?(?:met|reached)\b(?!,)/i.test(t) && !/once the reserve/i.test(t)) out.reserve = 'met';
  // "Buyer's Premium: 16.5% GST Inclusive"
  const bp = /buyer'?s?\s*premium[^0-9%\n]{0,30}(\d{1,2}(?:\.\d{1,2})?)\s*%/i.exec(t);
  if (bp && +bp[1] <= 30) out.buyer_premium = +bp[1];
  if (/(?:\+|plus)\s*GST\b|\bGST\s+(?:applies|applicable|is\s+payable|payable\s+on\s+(?:the\s+)?(?:hammer|purchase))/i.test(t)) out.gst_extra = 1;
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

/**
 * A close time tucked into a page's raw HTML (data attributes, script variables) when the visible countdown
 * is drawn by script: "data-end-time="1792950000000"", "closingDate":"2026-10-22T09:00:00Z", endTime = 1792950000.
 * Only times with a zone (or epoch numbers) within a day before / 60 days after now are taken.
 */
export function timeFromHtml(html, now = Date.now()) {
  const re = /(?:end|clos|finish|expir)[a-z_-]*(?:date|time|at|utc|on)?["'\s]*[:=]\s*["']?(\d{13}|\d{10}|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))\b/gi;
  for (const m of String(html || '').matchAll(re)) {
    const v = m[1];
    const t = /^\d{13}$/.test(v) ? +v : /^\d{10}$/.test(v) ? +v * 1000 : Date.parse(v.replace(' ', 'T'));
    if (Number.isFinite(t) && t > now - 864e5 && t < now + 60 * 864e5) return t;
  }
  return null;
}

/**
 * A lot's own buyer's premium table -> tiers ("5500:25%,27500:16.5%,44000:11.5%,*:9%" or "2000:495,5000:650,*:5%"),
 * from rows like "$0 - $5,500 25%", "$5,501 - $27,500 16.5%", "$44,001+ 9%", "$0 - $2,000 $495", "ANY 20%".
 * Each band's rate applies to the whole price in that band. null if there's no table.
 */
export function premiumTiers(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const at = t.search(/buyers?'?\s*premium/i);
  if (at < 0) return null;
  const seg = t.slice(at, at + 900);
  const fee = f => (/%$/.test(f) ? `${parseFloat(f)}%` : String(Math.round(Number(f.replace(/[$,\s]/g, '')))));
  const rows = [];
  for (const m of seg.matchAll(/\$\s?([\d,]+)\s*[-–]\s*\$\s?([\d,]+)\s*(\d{1,2}(?:\.\d+)?\s*%|\$\s?[\d,]+(?:\.\d+)?)/g)) rows.push([Number(m[2].replace(/,/g, '')), fee(m[3].replace(/\s/g, ''))]);
  const top = /\$\s?([\d,]+)\s*\+\s*(\d{1,2}(?:\.\d+)?\s*%|\$\s?[\d,]+)/.exec(seg) || /\bany\s+(\d{1,2}(?:\.\d+)?\s*%)/i.exec(seg);
  if (!rows.length) return top && /any/i.test(top[0]) ? `*:${fee(top[1].replace(/\s/g, ''))}` : null;
  rows.sort((a, b) => a[0] - b[0]);
  const last = top ? fee((top[2] || top[1]).replace(/\s/g, '')) : null;
  const parts = rows.map(([lim, f]) => `${lim}:${f}`);
  parts.push(`*:${last ?? rows[rows.length - 1][1]}`);
  return parts.join(',');
}

/** "140 National Drive Dandenong South VIC 3125" / "Unit 3/12 Smith St, Fyshwick ACT 2609" -> { location: "Dandenong South, VIC", state: "VIC" } */
export function placeFromAddress(addr) {
  const m = /^(.{2,120}?),?\s+(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b/i.exec(String(addr || '').replace(/\s+/g, ' ').trim());
  if (!m) return null;
  const sub = m[1].replace(/^.*\b(?:drive|dr|road|rd|street|st|avenue|ave|highway|hwy|court|ct|crescent|cres|place|pl|parade|pde|way|lane|ln|close|circuit|cct|boulevard|blvd|terrace|tce|grove|gr)\b\.?,?\s*/i, '')
    .replace(/^[\d/ -]+/, '').replace(/,\s*$/, '').trim();
  if (!sub || sub.length > 40) return null;
  return { location: `${sub}, ${m[2].toUpperCase()}`, state: m[2].toUpperCase() };
}

/** "27 October 20:00 AEDT" (no year): the next such date, in the zone given (Sydney if none). */
export function parseDayMonthTime(s, now = Date.now()) {
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(?:(\d{4})\s+)?(?:at\s+)?(\d{1,2})[:.](\d{2})\s*(am|pm)?\s*(AEDT|AEST|ACDT|ACST|AWST)?/i.exec(String(s || ''));
  if (!m) return null;
  const mo = MONTHS.indexOf(m[2].toLowerCase());
  if (mo < 0) return null;
  let h = +m[4];
  if (/pm/i.test(m[6] || '') && h < 12) h += 12;
  if (/am/i.test(m[6] || '') && h === 12) h = 0;
  const zone = (m[7] || '').toLowerCase();
  const build = y => parseAuDate(`${m[1]} ${MONTHS[mo]} ${y} ${h}:${m[5]} ${zone}`);
  if (m[3]) return build(+m[3]);
  const y = new Date(now).getUTCFullYear();
  const t = build(y);
  return t && t < now - 60 * 86400000 ? build(y + 1) : t; // "3 January" seen in December
}

/** "Today at 7:12 PM" as shown in the browser (Sydney time) -> ms */
export function relativeSydney(day, h, mi, ampm, now = Date.now()) {
  if (/pm/i.test(ampm) && h < 12) h += 12;
  if (/am/i.test(ampm) && h === 12) h = 0;
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date(now + (/tomorrow/i.test(day) ? 86400000 : 0)));
  return parseTime(`${ymd}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00`);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** "21/10/2026 2:30 pm" (d/m/y) or "Wed 21 Oct 2026 4pm AEDT" -> ms (Sydney time unless AWST/ACST given) */
export function parseAuDate(s) {
  if (!s) return null;
  const str = String(s).toLowerCase();
  let d, mo, y, h = 0, mi = 0;
  let m = /(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(am|pm)?)?/.exec(str);
  if (m) { d = +m[1]; mo = +m[2]; y = +m[3]; h = +(m[4] || 0); mi = +(m[5] || 0); if (m[6] === 'pm' && h < 12) h += 12; if (m[6] === 'am' && h === 12) h = 0; }
  else {
    m = /(\d{1,2})[\s-]+([a-z]{3})[a-z]*[\s-]+(\d{4})(?:[^\d]+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/.exec(str);
    if (!m || MONTHS.indexOf(m[2]) < 0) return null;
    d = +m[1]; mo = MONTHS.indexOf(m[2]) + 1; y = +m[3]; h = +(m[4] || 0); mi = +(m[5] || 0);
    if (m[6] === 'pm' && h < 12) h += 12; if (m[6] === 'am' && h === 12) h = 0;
  }
  const local = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00`;
  if (/awst/.test(str)) return Date.parse(local + '+08:00');
  if (/acst/.test(str)) return Date.parse(local + '+09:30');
  if (/acdt/.test(str)) return Date.parse(local + '+10:30');
  if (/aest/.test(str)) return Date.parse(local + '+10:00');
  if (/aedt/.test(str)) return Date.parse(local + '+11:00');
  return parseTime(local);
}

/** Pull Next.js __NEXT_DATA__ / embedded JSON blobs out of raw HTML. */
export function jsonBlobsFromHtml(html) {
  const blobs = [];
  const re = /<script[^>]*type=["']application\/(?:json|ld\+json)["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) { try { blobs.push(JSON.parse(m[1])); } catch { /* ignore */ } }
  // Next.js app router streams data as self.__next_f.push([1,"..."]) chunks
  const re2 = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let joined = '';
  while ((m = re2.exec(html))) { try { joined += JSON.parse(`"${m[1]}"`); } catch { /* ignore */ } }
  if (joined) {
    for (const line of joined.split('\n')) {
      const i = line.indexOf(':');
      const body = i > 0 ? line.slice(i + 1) : '';
      if (body.startsWith('{') || body.startsWith('[')) { try { blobs.push(JSON.parse(body)); } catch { /* ignore */ } }
    }
  }
  return blobs;
}

// Parts and accessories listed under vehicles ("Truck Tool Box", "Ute canopy") are goods, not vehicles
const ACCESSORY = /accessor|\bspares?\b|\bparts\b|tool[\s-]?box|toolbox|\btyres?\b|\bwheels?\b|\brims?\b|canopy|tonneau|bull[\s-]?bar|roof[\s-]?racks?|tow[\s-]?bar|\bseats?\b|headlights?|tail[\s-]?lights?|mud[\s-]?flaps?|ladder[\s-]?racks?|\bjack\b|jerry[\s-]?can/i;
export function isVehicle(lot) {
  if (!lot.odometer && ACCESSORY.test(`${lot.title || ''} ${lot.category || ''} ${(lot.url || '').replace(/^https?:\/\/[^/]+/, '')}`)) return false;
  const s = `${lot.category || ''} ${lot.url || ''}`.toLowerCase();
  if (/\/(cars|trucks|motorcycles|vans|utes)\//.test(s) || /\b(cars?|trucks?|vehicles?|motorcycles?|utes?|vans?)\b/.test(s)) return true;
  if (lot.odometer || (lot.year && lot.make)) return true;
  // "2004 Volvo FH12 Prime Mover" - a year then a vehicle make (Lloyds and others don't give a category)
  return /^\s*(?:19[5-9]\d|20[0-3]\d)\s+(?:toyota|ford|holden|nissan|mazda|mitsubishi|hyundai|kia|isuzu|hino|volvo|scania|kenworth|mack|iveco|fuso|ud|mercedes|benz|renault|volkswagen|vw|subaru|suzuki|honda|bmw|audi|jeep|land\s*rover|range\s*rover|ldv|great\s*wall|gwm|haval|mg|peugeot|citroen|skoda|tesla|chrysler|dodge|ram|chevrolet|lexus|porsche|jaguar|volvo|yamaha|kawasaki|harley|ducati|ktm|triumph|daihatsu|proton|ssangyong|foton|jac|dennis|freightliner|western\s*star|international|daf|man)\b/i.test(lot.title || '');
}
