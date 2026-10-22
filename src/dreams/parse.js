// Read what you copy off a search results page (select all, copy, paste - or a saved .txt) into listings.
// Handles Trucksales and Carsales results (plain text or the markdown version with links), Pickles search
// pages (which show the body type: "Curtainsider Day Cab") and simple CSV with a header row.
// Nothing here touches the database.
import { features } from './model.js';
import { factsFromText, parseAuDate, placeFromAddress } from '../extract.js';

const STATES = 'NSW|VIC|QLD|WA|SA|TAS|ACT|NT';
const STATE_RE = new RegExp(`\\b(${STATES})\\b`);
const TITLE_RE = /^(19[5-9]\d|20[0-3]\d)\s+([A-Za-z][A-Za-z-]+)(?:\s+(.*))?$/;
const money = s => { const m = /\$\s?([\d,]+(?:\.\d+)?)/.exec(s); return m ? Math.round(Number(m[1].replace(/,/g, ''))) : null; };
const int = s => Number(String(s).replace(/[,\s]/g, ''));
const BODY_WORDS = /^(curtain\s?sider|curtainsider|tautliner|pantech|refrigerated(?: pantech)?|tipper|tray(?: ?top| ?back)?|table ?top|tilt ?tray|cab ?chassis|crane truck|crane|beavertail|flat ?top|drop ?side|service (?:body|truck)|tanker|water truck|ute|utility|cab chassis|dual cab|single cab|space cab|crew cab|box van|van|bus|wagon|suv|car carrier|hook ?lift|skip bin|garbage|compactor|vacuum|ewp|elevated work platform|concrete agitator|agitator|tow truck|horse truck|livestock|stock crate|dropside|trayback|other)$/i;

/** A line of pasted markdown -> { text, urls[] } */
function clean(line) {
  const urls = [...String(line).matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map(m => m[1]);
  const text = String(line).replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[*•-]\s+/, '').replace(/\s+/g, ' ').trim();
  return { text, urls };
}

export function detectSource(text) {
  const t = String(text).slice(0, 200000);
  // one lot's page after it closed: "Sold for $13,900" / "Referred" + "The auction has ended"
  if (/\bSold for\s*\$\s?[\d,]+|^\s*(?:Referred|Passed in)\s*$/im.test(t) && /auction has ended|bidding (?:has )?(?:closed|ended)|^\s*Closed:/im.test(t)) return 'result';
  if (/MyPickles|Pickles Live|Pickles Online|pickles\.com\.au|\bStock \d{6,9}\b/i.test(t)) return 'pickles';
  // each site's footer names the other, so go by the page's own title first
  const own = /-\s*(trucksales|carsales)\.com\.au\s*$/im.exec(t);
  if (own) return own[1].toLowerCase();
  if (/\btrucks? for sale\b/i.test(t)) return 'trucksales';
  if (/\bcars? for sale\b/i.test(t)) return 'carsales';
  if (/trucksales/i.test(t)) return 'trucksales';
  if (/carsales|Excl\.? (?:Est\.? )?Govt\.? Charges|Drive ?away/i.test(t)) return 'carsales';
  if (/^[^\n]*,[^\n]*\n/.test(t) && /\b(title|price|year)\b/i.test(t.split('\n')[0])) return 'csv';
  return 'other';
}

// ---- time: "Starts Thu 29/10/2026 07:00AM" is shown in the browser's own time zone ----
function tzOffsetMs(tz, utcMs) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
  } catch { return 0; }
}
export function localTime(y, mo, d, h, mi, tz = 'Australia/Sydney') {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  return naive - tzOffsetMs(tz, naive - tzOffsetMs(tz, naive));
}
/** "Starts Thu 29/10/2026 07:00AM", "Ends in 2D 3H 10M", "Starts in 10H 8M" -> ms */
export function whenFrom(line, { now = Date.now(), tz = 'Australia/Sydney' } = {}) {
  const abs = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(line);
  if (abs) {
    let h = +abs[4];
    if (/pm/i.test(abs[6] || '') && h < 12) h += 12;
    if (/am/i.test(abs[6] || '') && h === 12) h = 0;
    return localTime(+abs[3], +abs[2], +abs[1], h, +abs[5], tz);
  }
  const rel = /\bin\s+((?:\d+\s*[DHMS]\s*){1,4})/i.exec(line);
  if (rel) {
    let ms = 0;
    for (const [, n, u] of rel[1].matchAll(/(\d+)\s*([DHMS])/gi)) ms += +n * { d: 864e5, h: 36e5, m: 6e4, s: 1e3 }[u.toLowerCase()];
    return now + ms;
  }
  return null;
}

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---- Trucksales / Carsales results ----
function parseClassifieds(lines, source) {
  const out = [];
  let cur = null, expectSub = false;
  const done = () => { if (cur && (cur.price != null || cur.priceNote === 'poa' || cur.km != null)) out.push(cur); cur = null; };
  for (const raw of lines) {
    const { text: t, urls } = clean(raw);
    if (!t && !urls.length) continue;
    if (/^(advertisement|want more search results|back\s*page|page \d+ of \d+|©|contact us|learn more)/i.test(t)) { done(); continue; }
    const tm = TITLE_RE.exec(t);
    if (tm && !/^\d{4}\s+(?:km|kg|hp)\b/i.test(t)) {
      done();
      cur = { source, title: t, year: +tm[1], price: null, priceNote: null, km: null, gvm: null, hp: null, trans: null, body: null, seller: null, condition: null, state: null, location: null, url: null };
      expectSub = true;
      continue;
    }
    if (!cur) continue;
    for (const u of urls) if (/\/(?:items\/details|cars\/details|details)\//i.test(u) && !cur.url) cur.url = u.split('?')[0];
    if (!t) continue;
    let m;
    // Carsales puts the spec on the line under the title ("X-TERRAIN Auto 4x4 MY23")
    if (expectSub) {
      expectSub = false;
      if (!/^\$|^enquire|^price on|^poa$|\b(?:km|kg|hp)$|^(?:dealer|private)\b|drive\s?away|excl\.?/i.test(t) && !BODY_WORDS.test(t) && t.length <= 90) { cur.title = `${cur.title} ${t}`; cur.subtitle = t; continue; }
    }
    // "Drive away $45,053 Excl. Est. Govt. Charges": the excl-govt figure is the one that compares with everything else
    if ((m = /\$\s?([\d,]+)\s*excl\.?\s*(?:est\.?\s*)?govt/i.exec(t))) { cur.driveAway = cur.price; cur.price = int(m[1]); cur.priceNote = 'egc'; continue; }
    if (cur.price == null && /^\$\s?[\d,]/.test(t)) { cur.price = money(t); if (/drive\s?away/i.test(t)) cur.priceNote = 'driveaway'; continue; }
    if (/^enquire for price|^price on application|^POA$/i.test(t)) { cur.priceNote = 'poa'; continue; }
    if (/excl\.?\s*(?:est\.?\s*)?govt/i.test(t)) { cur.priceNote = cur.priceNote || 'egc'; continue; }
    if (/^drive\s?away/i.test(t)) { cur.priceNote = 'driveaway'; continue; }
    if ((m = /^([\d,]+)\s*km$/i.exec(t))) { cur.km = int(m[1]); continue; }
    if ((m = /^([\d,]+)\s*kg$/i.exec(t))) { cur.gvm = Math.max(cur.gvm || 0, int(m[1])); continue; }
    if ((m = /^(\d{2,3})\s*hp$/i.exec(t))) { cur.hp = +m[1]; continue; }
    if (/^(manual|automatic|automated manual(?: transmission)?|auto|\d+\s*sp(?:ee)?d.*)$/i.test(t)) { cur.trans = t; continue; }
    if ((m = /^(dealer|private)(?:\s+(used|new|demo))?(?:\s+seller)?\s*(?:[•·|,-]\s*(.*))?$/i.exec(t))) {
      cur.seller = m[1].toLowerCase(); cur.condition = (m[2] || (m[1].toLowerCase() === 'private' ? 'used' : '')).toLowerCase() || null;
      const st = STATE_RE.exec(m[3] || ''); if (st) cur.state = st[1];
      if (m[3] && m[3].length > 3) cur.location = m[3].trim();
      continue;
    }
    if (BODY_WORDS.test(t)) { cur.body = cur.body || t; continue; }
    if (!cur.state && (m = new RegExp(`^(?:[A-Za-z .'-]{2,40},\\s*)?(${STATES})$`).exec(t))) { cur.state = m[1]; cur.location = t; continue; }
  }
  done();
  for (const l of out) {
    if (l.url) l.extId = (/\/((?:OAG|SSE|ACC|AD|CP|DEALER|PRIVATE)[-A-Z0-9]+|\d{6,})\/?$/i.exec(l.url) || [])[1] || null;
  }
  return out;
}

// ---- Pickles search results ----
function parsePickles(lines, { now, tz }) {
  const t = lines.map(l => clean(l).text);
  const out = [];
  for (let i = 0; i < t.length; i++) {
    const tm = TITLE_RE.exec(t[i]);
    if (!tm) continue;
    // a lot card: the title is followed (within ~30 lines) by "Stock 12345678"
    let end = i + 1;
    while (end < t.length && end < i + 40 && !/^MORE DETAILS$/i.test(t[end]) && !(end > i + 2 && TITLE_RE.test(t[end]) && /^Starts|^Ends|^Colour/i.test(t[end - 1] || ''))) end++;
    const block = t.slice(i + 1, end);
    const stock = block.map(x => /^Stock\s+(\d{6,9})(?:\s*\|\s*Lot\s+(\w+))?/i.exec(x)).find(Boolean);
    if (!stock) continue;
    const before = t.slice(Math.max(0, i - 3), i);
    const sub = block[0] && !/,\s*(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT)$/.test(block[0]) && !/^share$/i.test(block[0]) ? block[0] : '';
    const locLine = block.slice(0, 3).find(x => /,\s*(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT)$/.test(x)) || null;
    const l = { source: 'pickles', title: sub ? `${t[i]} ${sub}` : t[i], baseTitle: t[i], subtitle: sub || null, year: +tm[1], stock: stock[1], lotNo: stock[2] || null,
      location: locLine, state: locLine ? (/(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)$/.exec(locLine) || [])[1] : null,
      km: null, gvm: null, drive: null, trans: null, body: null, buyMethod: null, buyNow: null, bid: null, startsAt: null, endsAt: null, wovr: null, damage: null };
    for (const x of [...before, ...block]) {
      let m;
      if (/^Starts\b/i.test(x)) l.startsAt = whenFrom(x, { now, tz });
      else if (/^(?:Ends|Closes|Closing)\b/i.test(x)) l.endsAt = whenFrom(x, { now, tz });
      else if ((m = /^([\d,]+)\s*km$/i.exec(x))) l.km = int(m[1]);
      else if ((m = /^([\d,]+)\s*kg$/i.exec(x))) l.gvm = Math.max(l.gvm || 0, int(m[1]));
      else if (/^4x4|dual range|four wheel|all wheel/i.test(x)) l.drive = '4x4';
      else if (/^rear wheel drive|^4x2|^2wd|front wheel drive/i.test(x)) l.drive = l.drive || '4x2';
      else if (/spd|manual|automatic/i.test(x) && x.length < 40) l.trans = l.trans || x;
      else if (/^Pickles (Live|Online)$/i.test(x)) l.buyMethod = x;
      else if ((m = /^Buy(?: Now)?\s*\$\s?([\d,]+)/i.exec(x))) { l.buyNow = money(x); l.buyMethod = l.buyMethod || 'Buy Now'; }
      else if ((m = /^(?:Current\s+)?(?:Bid|High(?:est)? bid)\s*:?\s*\$\s?([\d,]+)/i.exec(x))) l.bid = money(x);
      else if (/write-?\s?off|wovr/i.test(x) && x.length < 60) l.wovr = x;
      else if (/^(?:damage|incident)\b/i.test(x)) l.damage = x;
      else if (/^LOT\s+\w+$/i.test(x)) l.lotNo = l.lotNo || x.replace(/^LOT\s+/i, '');
    }
    if (!l.buyMethod && l.lotNo) l.buyMethod = 'Pickles Live';
    // body: "Curtainsider Day Cab" -> "Curtainsider"; cars carry it in the variant ("Cab Chassis Crew Cab", "Utility")
    const f = features(l.title);
    l.body = sub ? (f.truck ? sub.replace(/\b(?:half\s+)?(?:day|dual|crew|sleeper)\s+cab\b/gi, '').replace(/\s+/g, ' ').trim() || null : f.body) : null;
    const cat = f.truck ? 'trucks' : 'cars';
    l.url = `https://www.pickles.com.au/used/details/${cat}/${slug(t[i])}/${l.stock}`;
    l.category = cat;
    out.push(l);
    i = end - 1;
  }
  return out;
}

// ---- CSV: a header row naming the columns (title, price, year, km, state, url, seller, body...) ----
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true; else if (c === ',' || c === '\t') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (rows.length < 2) return [];
  const head = rows[0].map(h => h.toLowerCase().replace(/[^a-z]/g, ''));
  const col = (...names) => head.findIndex(h => names.includes(h));
  const ix = { title: col('title', 'name', 'vehicle', 'listing'), price: col('price', 'askingprice', 'amount'), year: col('year'), km: col('km', 'kms', 'odometer', 'kilometres'),
    state: col('state'), url: col('url', 'link'), seller: col('seller', 'sellertype'), body: col('body', 'bodytype'), location: col('location', 'suburb') };
  if (ix.title < 0 || ix.price < 0) return [];
  return rows.slice(1).filter(r => r[ix.title]?.trim()).map(r => {
    const title = r[ix.title].trim();
    const y = ix.year >= 0 ? +r[ix.year] : +(/^(19|20)\d\d/.exec(title) || [])[0];
    return { source: 'csv', title, year: y || null, price: money('$' + r[ix.price]), km: ix.km >= 0 && r[ix.km] ? int(r[ix.km]) || null : null,
      state: ix.state >= 0 ? (STATE_RE.exec(r[ix.state] || '') || [])[1] || null : null, url: ix.url >= 0 ? r[ix.url] || null : null,
      seller: ix.seller >= 0 ? (/private/i.test(r[ix.seller]) ? 'private' : /dealer/i.test(r[ix.seller]) ? 'dealer' : null) : null,
      body: ix.body >= 0 ? r[ix.body] || null : null, location: ix.location >= 0 ? r[ix.location] || null : null, condition: 'used' };
  });
}

// ---- one lot's page after it closed (Grays and the like): the result, with what the lot was ----
const SITES = [['grays', /grays\.com|Slattery Grays|\bGrays\b/i], ['pickles', /pickles/i], ['manheim', /manheim/i], ['lloyds', /lloyds/i], ['allbids', /allbids|carbids/i], ['slattery', /slattery/i]];
function parseResult(text) {
  const t = String(text).replace(/\u00a0/g, ' ');
  const lines = t.split('\n').map(x => clean(x).text).filter(Boolean);
  // the title: under the "Description" heading (not the tab of the same name), else the line repeated most
  const di = lines.findIndex((x, i) => /^Description$/i.test(x) && lines.slice(i + 1, i + 3).some(y => TITLE_RE.test(y)));
  let title = di >= 0 ? lines.slice(di + 1, di + 4).find(x => TITLE_RE.test(x)) : null;
  if (!title) { const n = new Map(); for (const x of lines) if (TITLE_RE.test(x)) n.set(x, (n.get(x) || 0) + 1); title = [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]; }
  if (!title) return [];
  const field = re => (re.exec(t) || [])[1]?.trim() || null;
  const site = (SITES.find(([, re]) => re.test(t)) || ['other'])[0];
  const lotId = field(/\bLot ID\s*:?\s*(\d{2,6}-\d{5,})/i);
  const category = field(/^Category\s*:?\s*(.+)$/im);
  const place = placeFromAddress(field(/^Location\s*:?\s*(.+)$/im));
  const closedAt = (c => (c ? parseAuDate(c) : null))(field(/\bClosed:\s*([^\n]+)/i));
  const sold = field(/\bSold for\s*\$\s?([\d,]+)/i);
  const passed = !sold && /^\s*(?:Referred|Passed in)\s*$/im.test(t);
  // the top bid from the bidding history ("AU $6,000"), for a lot that was passed in
  const hist = t.slice(Math.max(0, t.search(/bidding history/i)));
  const top = Math.max(0, ...[...hist.matchAll(/AU\s*\$\s?([\d,]+)/g)].map(m => Number(m[1].replace(/,/g, ''))));
  const price = sold ? Number(sold.replace(/,/g, '')) : top || null;
  if (!price) return [];
  const facts = factsFromText(t);
  // cab and drive from the description line: "2014 ISUZU UTE D-MAX SX AUTO 4WD DIESEL CREW CAB - CAB CHASSIS"
  const desc = di >= 0 ? lines.slice(di + 1, di + 6).join(' ') : '';
  const cab = (/\b(crew|dual|double|space|extended|king|freestyle|single|one and a half)\s+cab\b/i.exec(desc) || [])[1]
    || (/\b4dr\b/i.test(desc) && /\b5\s?seat/i.test(desc) ? 'crew' : /\b2dr\b/i.test(desc) ? 'single' : undefined);
  const spec = [facts.spec || (/\b(?:4wd|awd|4x4)\b/i.test(desc) ? '4x4' : /\b(?:rwd|2wd|4x2|fwd)\b/i.test(desc) ? '4x2' : null),
    cab ? `${/one and a half|space|extended|king|freestyle/i.test(cab) ? 'space' : /single/i.test(cab) ? 'single' : 'crew'} cab` : null].filter(Boolean).join(' ') || null;
  const slugOf = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const url = site === 'grays' && lotId ? `https://www.grays.com/lot/${lotId}/${slugOf(category || 'commercial-vehicles')}/${slugOf(title)}` : null;
  return [{ source: 'result', site, title, year: +TITLE_RE.exec(title)[1], extId: lotId, url, category, location: place?.location || null, state: place?.state || null,
    sale: field(/^Part of Sale\s*:?\s*(.+)$/im), closedAt, price, sold: !!sold, passed, bidCount: facts.bid_count ?? null,
    km: facts.odometer ?? null, body: facts.body || null, spec, condition: facts.condition || null, wovr: facts.wovr || null,
    reserve: passed ? 'not met' : facts.reserve || null }];
}

/** Pasted page(s) -> { source, listings: [...] } (Pickles cards come back as auction lots, the rest as market listings). */
export function parsePaste(text, { now = Date.now(), tz = 'Australia/Sydney', source } = {}) {
  const src = source || detectSource(text);
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let listings = src === 'result' ? parseResult(String(text || '').replace(/\r/g, '')) : src === 'pickles' ? parsePickles(lines, { now, tz }) : src === 'csv' ? parseCsv(String(text)) : parseClassifieds(lines, src === 'other' ? 'other' : src);
  // the same ad often shows twice (featured spot + its place in the list)
  const seen = new Set();
  listings = listings.filter(l => {
    const k = l.stock || l.extId || `${l.title}|${l.price}|${l.km}|${l.state}`.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  for (const l of listings) Object.assign(l, { features: features(`${l.title} ${l.body || ''} ${l.spec || ''} ${l.gvm ? l.gvm + ' kg' : ''}`) });
  return { source: src, listings };
}
