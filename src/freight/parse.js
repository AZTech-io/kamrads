import crypto from 'node:crypto';
// Reading a job card's text: "Collect couch from Fyshwick and deliver to Lyneham  $80  Fyshwick ACT 2609
// Lyneham ACT 2602  Posted about 17 hours ago" (Airtasker) or "Ebike  MACKSVILLE to SOUTHPORT  Distance 382km" (Truckit).
import { parseMoney } from '../extract.js';

const ST = 'NSW|VIC|QLD|WA|SA|TAS|ACT|NT';
// "Fyshwick ACT 2609" / "North Kellyville NSW" / "Bibra Lake, WA 6163"
const PLACE_RE = new RegExp(`([A-Z][A-Za-z'.-]+(?:\\s+[A-Z][A-Za-z'.-]+){0,3}),?\\s+(${ST})\\b(?:\\s+(\\d{4}))?`, 'g');

export function placesIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(PLACE_RE)) {
    const name = m[1].replace(/^(?:From|To|In|At|Near|Pickup|Drop[- ]?off|Deliver(?:y)?)\s+/i, '').trim();
    out.push(`${name} ${m[2]}${m[3] ? ' ' + m[3] : ''}`);
  }
  return [...new Set(out)];
}

/** "about 17 hours ago" / "less than a minute ago" / "2 days ago" / "yesterday" -> ms timestamp */
export function parseAgo(text, now = Date.now()) {
  const t = String(text || '').toLowerCase();
  if (/less than a minute|just now|moments? ago/.test(t)) return now;
  const m = /(?:about|over|almost|~)?\s*(\d+|an?|one)\s+(minute|min|hour|hr|day|week|month)s?\s+ago/.exec(t);
  if (m) {
    const n = /^\d+$/.test(m[1]) ? +m[1] : 1;
    const unit = { minute: 6e4, min: 6e4, hour: 36e5, hr: 36e5, day: 864e5, week: 6048e5, month: 2592e6 }[m[2]];
    return now - n * unit;
  }
  if (/\byesterday\b/.test(t)) return now - 864e5;
  return null;
}

const tidy = s => String(s || '').replace(/\s+/g, ' ').trim();
const titleCase = s => s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());

/** One job card (link + its card text) -> job fields. */
export function jobFromCard(card, { site, idFromUrl, now = Date.now() }) {
  const ext_id = idFromUrl(card.href);
  if (!ext_id) return null;
  const text = String(card.text || '');
  const lines = text.split('\n').map(tidy).filter(Boolean);
  const title = tidy(card.heading) || lines.find(l => l.length > 3 && !/^\$|^posted|ago$|^(open|assigned|completed|make an offer|view|quote now)$/i.test(l) && !PLACE_RE.test(l) && !(PLACE_RE.lastIndex = 0)) || null;
  PLACE_RE.lastIndex = 0;
  let from = null, to = null;
  const places = placesIn(text);
  if (places.length) { from = places[0]; to = places[1] || null; }
  // Truckit style "MACKSVILLE to SOUTHPORT" (towns without a state)
  if (!from) {
    const r = /\b([A-Z][A-Z' .-]{2,40}?)\s+to\s+([A-Z][A-Z' .-]{2,40}?)(?=\s*(?:\n|$|distance|\d|\$))/.exec(text);
    if (r) { from = titleCase(tidy(r[1])); to = titleCase(tidy(r[2])); }
  }
  const price = /\$\s?([\d,]+(?:\.\d{1,2})?)/.exec(text);
  const km = /distance\s*:?\s*([\d,]+)\s*km/i.exec(text) || /\b([\d,]{2,6})\s*km\b/i.exec(text);
  const offers = /(\d+)\s+(?:offers?|quotes?)\b/i.exec(text);
  const posted = parseAgo(text, now);
  // Truckit's "Winning Quote" = already awarded (kept as price history, not shown as open work)
  const status = /\b(assigned|completed|closed|booked|awarded)\b/i.test(lines.slice(-4).join(' ')) || /winning\s+quote/i.test(text) ? 'taken' : 'open';
  const priceKind = /winning\s+quote/i.test(text) ? 'won quote' : /budget|\$/i.test(text) ? 'budget' : null;
  return {
    site, ext_id, url: card.href.split('#')[0], title: title ? title.slice(0, 160) : null,
    price: price ? parseMoney(price[1]) : null, price_kind: priceKind,
    from_text: from, to_text: to, km: km ? parseMoney(km[1]) : null,
    posted_at: posted, offers: offers ? +offers[1] : null, status, category: card.category || null,
  };
}

// ---- jobs inside captured JSON (Truckit's board loads by script) ----
const nk = k => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
const FROM_KEYS = ['pickup', 'pickupsuburb', 'pickuplocation', 'pickupaddress', 'from', 'fromsuburb', 'fromlocation', 'origin', 'originsuburb', 'collection', 'collectionsuburb', 'sourcesuburb', 'pickuptown'];
const TO_KEYS = ['delivery', 'deliverysuburb', 'deliverylocation', 'deliveryaddress', 'to', 'tosuburb', 'tolocation', 'destination', 'destinationsuburb', 'dropoff', 'dropoffsuburb', 'deliverytown'];
const TITLE_KEYS = ['title', 'name', 'jobtitle', 'description', 'summary', 'itemdescription', 'items', 'freighttype'];
const ID_KEYS = ['id', 'jobid', 'jobnumber', 'reference', 'ref', 'uuid'];
const PRICE_KEYS = ['budget', 'price', 'amount', 'quote', 'lowestquote', 'winningquote', 'offerprice'];
const KM_KEYS = ['distance', 'distancekm', 'km', 'kms'];
const POSTED_KEYS = ['created', 'createdat', 'posted', 'postedat', 'datecreated', 'publishedat', 'createddate'];

const placeText = v => {
  if (v == null) return null;
  if (typeof v === 'string') return tidy(v) || null;
  if (typeof v === 'object') {
    const sub = v.suburb ?? v.town ?? v.city ?? v.locality ?? v.name ?? null;
    const st = v.state ?? v.stateCode ?? v.region ?? '';
    const pc = v.postcode ?? v.postCode ?? '';
    return sub ? tidy(`${sub} ${st} ${pc}`) : null;
  }
  return null;
};
const pick = (o, keys) => { const m = new Map(Object.keys(o).map(k => [nk(k), k])); for (const k of keys) if (m.has(k) && o[m.get(k)] != null && o[m.get(k)] !== '') return o[m.get(k)]; return null; };

export function jobsFromJson(json, { site, urlFor }) {
  const out = new Map();
  const walk = (v, d) => {
    if (!v || typeof v !== 'object' || d > 12) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, d + 1); return; }
    const from = placeText(pick(v, FROM_KEYS)), to = placeText(pick(v, TO_KEYS)), id = pick(v, ID_KEYS);
    if (id != null && from && to) {
      const title = pick(v, TITLE_KEYS);
      const posted = pick(v, POSTED_KEYS);
      out.set(String(id), {
        site, ext_id: String(id), url: urlFor(v, id), title: typeof title === 'string' ? tidy(title).slice(0, 160) : null,
        from_text: from, to_text: to, price: parseMoney(pick(v, PRICE_KEYS)), km: parseMoney(pick(v, KM_KEYS)),
        posted_at: posted ? Date.parse(posted) || null : null, status: 'open',
      });
      return;
    }
    for (const x of Object.values(v)) walk(x, d + 1);
  };
  walk(json, 0);
  return [...out.values()];
}

// ---- Truckit: /api/frontend/search/jobs records ----
// { suburb1, state1, postcode1, suburb2, state2, postcode2, distance_estimate, item_label, category_label,
//   created_at (epoch s), collection_date_earliest/latest, delivery_date_*, date_flexibility (html),
//   active_quotes, min_quote, max_quote, user_max_price, book_now_value, status: "active" }
// Logged out, jobs carry no id or link, so the id is built from what doesn't change.
const stripHtml = s => tidy(String(s || '').replace(/<[^>]+>/g, ' '));
const place = (sub, st, pc) => (sub ? tidy(`${titleCase(tidy(sub))} ${st || ''} ${pc || ''}`) : null);
const shortDate = s => { const d = s ? new Date(String(s).replace(' ', 'T') + '+10:00') : null; return d && !isNaN(d) ? d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'Australia/Sydney' }) : null; };
const span = (a, b) => {
  const x = shortDate(a), y = shortDate(b);
  if (!x || !y || x === y) return x || y;
  const [dx, mx] = x.split(' '), [dy, my] = y.split(' ');
  return mx === my ? `${dx}–${dy} ${my}` : `${x}–${y}`; // "1–5 Dec", "30 Oct–2 Nov"
};

export function truckitJob(r) {
  if (!r || !r.suburb1) return null;
  const created = Number(r.created_at) ? Number(r.created_at) * 1000 : null;
  const id = crypto.createHash('sha1').update([r.created_at, r.suburb1, r.postcode1, r.suburb2, r.postcode2, String(r.item_label || '').slice(0, 60)].join('|')).digest('hex').slice(0, 16);
  const collect = r.collection_date_view === 'Ready Now' ? 'ready now' : span(r.collection_date_earliest, r.collection_date_latest) || stripHtml(r.date_flexibility);
  const deliver = span(r.delivery_date_earliest, r.delivery_date_latest) || stripHtml(r.date_flex_delivery);
  const min = parseMoney(r.min_quote), max = parseMoney(r.max_quote), quotes = Number(r.active_quotes) || 0;
  const offer = parseMoney(r.book_now_value) ?? parseMoney(r.user_max_price);
  return {
    site: 'truckit', ext_id: id, url: 'https://www.truckit.net/search-for-jobs',
    title: tidy(r.item_label || r.category_label || 'Freight').slice(0, 160), category: r.category_label || null,
    from_text: place(r.suburb1, r.state1, r.postcode1), to_text: place(r.suburb2, r.state2, r.postcode2),
    km: parseMoney(r.distance_estimate), posted_at: created,
    price: offer ?? min ?? null,
    price_kind: offer != null ? (r.book_now_value ? 'book now' : 'customer max') : min != null ? (max && max !== min ? `quotes $${Math.round(min)}–$${Math.round(max)}` : 'lowest quote') : null,
    offers: quotes || (min != null ? 1 : 0),
    due_text: [collect ? `collect ${collect}` : null, deliver ? `deliver ${deliver}` : null].filter(Boolean).join(' · ') || null,
    status: !r.status || r.status === 'active' ? 'open' : 'taken',
  };
}

// ---- Loadshift: public load board (/search/loads). Read from the page text, which is labelled:
// "Load ID 40778814 · Machinery · Telehandler · Weight 8300 kg · Pickup Merredin, WA 6415 ·
//  Dropoff Wallumbilla, QLD 4428 · Ready On 27-Oct-26 · Distance 3775 km". No prices (quotes only).
const LS_FIELD = /(Load ID|Freight|Title|Weight|Pick ?up|Drop ?off|Ready On|Distance|Truck type|Posted)\s*:?\s*/gi;
const lsPlace = s => { const m = /([A-Za-z][A-Za-z' .-]+?),?\s+(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b\s*(\d{4})?/.exec(s || ''); return m ? tidy(`${titleCase(tidy(m[1].split(',').pop()))} ${m[2]} ${m[3] || ''}`) : null; };
const lsDate = s => { const m = /(\d{1,2})-([A-Za-z]{3})-(\d{2})/.exec(s || ''); return m ? `${+m[1]} ${m[2]}` : null; };

export function loadshiftJobsFromText(text, links = {}) {
  const out = [];
  const blocks = String(text || '').split(/(?=Load ID\s*:?\s*\d{5,})/i).slice(1);
  for (const b of blocks) {
    const id = (/Load ID\s*:?\s*(\d{5,})/i.exec(b) || [])[1];
    if (!id) continue;
    const f = {};
    const parts = b.split(LS_FIELD);
    for (let i = 1; i < parts.length - 1; i += 2) {
      const k = parts[i].toLowerCase().replace(/\s+/g, '');
      if (!(k in f)) f[k] = tidy(parts[i + 1].split('\n').filter(Boolean)[0] || parts[i + 1]);
    }
    // unlabelled lines right after the id: cargo type, then the shipper's title
    const afterId = (parts[2] || '').split('\n').map(tidy).filter(Boolean).slice(1).filter(l => !/^(view|quote|details|show map|save)/i.test(l));
    const cargo = f.freight || (afterId.length > 1 ? afterId[0] : null);
    const title = f.title || (afterId.length > 1 ? afterId[1] : afterId[0]) || cargo || 'Load';
    const weight = (/([\d,.]+)\s*(kg|t)\b/i.exec(f.weight || '') || [])[0];
    const ready = lsDate(f.readyon);
    out.push({
      site: 'loadshift', ext_id: id, url: links[id] || `https://www.loadshift.com.au/search/loads`,
      title: tidy(title).slice(0, 160), category: cargo,
      from_text: lsPlace(f.pickup), to_text: lsPlace(f.dropoff), km: parseMoney(f.distance),
      price: null, price_kind: null, offers: null, posted_at: parseAgo(f.posted || ''),
      due_text: [weight, ready ? `ready ${ready}` : null].filter(Boolean).join(' · ') || null, status: 'open',
    });
  }
  return out;
}
