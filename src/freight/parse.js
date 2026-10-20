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
