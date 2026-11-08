// Cruises (/cruises): reading OzCruising's departure-port pages into cruise records.
// A record: { code, url, title, ship, line, port, nights, depart (YYYY-MM-DD), fares: [{ amount, occ, cabin, label }],
//             twin, triple, quad, solo, badge }
// Three readers, best first: the data the page loads (JSON), each cruise card (link + its text), the page text alone
// (also used for pages pasted in by hand). They all end in cardFromText().

export const OZ = 'https://www.ozcruising.com.au';

// Departure ports we read, by OzCruising's page slug (/departing/<slug>/cruises). key = what the page filters on.
export const PORTS = {
  sydney: { key: 'syd', name: 'Sydney', short: 'SYD' },
  brisbane: { key: 'bne', name: 'Brisbane', short: 'BNE' },
  fremantle: { key: 'per', name: 'Perth (Fremantle)', short: 'PER' },
  melbourne: { key: 'mel', name: 'Melbourne', short: 'MEL' },
  adelaide: { key: 'adl', name: 'Adelaide', short: 'ADL' },
  hobart: { key: 'hba', name: 'Hobart', short: 'HBA' },
  cairns: { key: 'cns', name: 'Cairns', short: 'CNS' },
  darwin: { key: 'drw', name: 'Darwin', short: 'DRW' },
  auckland: { key: 'akl', name: 'Auckland', short: 'AKL' },
};
export const PORT_KEYS = Object.fromEntries(Object.entries(PORTS).map(([slug, p]) => [p.key, { ...p, slug }]));
export const portUrl = slug => `${OZ}/departing/${slug}/cruises`;

/** "from Fremantle (Perth)" / "Departs: Circular Quay, Sydney" -> 'per' / 'syd' (or null) */
export function portKeyOf(text) {
  const t = String(text || '').toLowerCase();
  if (/sydney|circular quay|white bay/.test(t)) return 'syd';
  if (/brisbane|hamilton|luggage point|moreton/.test(t) && !/to moreton/.test(t)) return 'bne';
  if (/fremantle|perth/.test(t)) return 'per';
  if (/melbourne|port phillip|station pier/.test(t)) return 'mel';
  if (/adelaide|outer harbou?r/.test(t)) return 'adl';
  if (/hobart/.test(t)) return 'hba';
  if (/cairns|yorkeys/.test(t)) return 'cns';
  if (/darwin/.test(t)) return 'drw';
  if (/auckland/.test(t)) return 'akl';
  return null;
}

// ---- cruise lines ----
// The card names the ship (and sometimes the line's tagline); the line comes from the ship, the tagline or the cruise code.
const LINE_BY_TAGLINE = [
  [/australia'?s favou?rite cruise|p\s*&\s*o australia/i, 'Carnival'],
  [/premium cruise line|princess cruises/i, 'Princess'],
  [/royal caribbean/i, 'Royal Caribbean'], [/celebrity cruises/i, 'Celebrity'], [/carnival cruise/i, 'Carnival'],
  [/\bcunard\b/i, 'Cunard'], [/holland america/i, 'Holland America'], [/\bmsc cruises\b/i, 'MSC'],
  [/norwegian cruise|\bncl\b/i, 'Norwegian'], [/\bviking\b/i, 'Viking'], [/oceania cruises/i, 'Oceania'],
  [/\bazamara\b/i, 'Azamara'], [/\bsilversea\b/i, 'Silversea'], [/regent seven seas/i, 'Regent'], [/\bseabourn\b/i, 'Seabourn'],
  [/\bponant\b/i, 'Ponant'], [/coral expeditions/i, 'Coral Expeditions'], [/\bscenic\b/i, 'Scenic'], [/disney cruise/i, 'Disney'],
  [/virgin voyages/i, 'Virgin Voyages'], [/windstar/i, 'Windstar'], [/\bcunard line\b/i, 'Cunard'],
];
const LINE_BY_SHIP = [
  [/^carnival\b/i, 'Carnival'], [/^pacific (?:encounter|adventure|explorer|eden|jewel|dawn|aria|pearl)\b/i, 'Carnival'],
  [/\bof the seas$/i, 'Royal Caribbean'], [/\bprincess$/i, 'Princess'], [/^celebrity\b/i, 'Celebrity'],
  [/^queen (?:elizabeth|mary 2|victoria|anne)$/i, 'Cunard'], [/dam$/i, 'Holland America'], [/^msc\b/i, 'MSC'],
  [/^norwegian\b/i, 'Norwegian'], [/^viking\b/i, 'Viking'], [/^(?:regatta|insignia|nautica|sirena|riviera|marina|vista|allura)$/i, 'Oceania'],
  [/^azamara\b/i, 'Azamara'], [/^silver\b/i, 'Silversea'], [/^seven seas\b/i, 'Regent'], [/^seabourn\b/i, 'Seabourn'],
  [/^le (?:[a-z]+)/i, 'Ponant'], [/^coral (?:adventurer|discoverer|geographer|expeditions)/i, 'Coral Expeditions'],
  [/^scenic\b/i, 'Scenic'], [/^disney\b/i, 'Disney'], [/(?:resilient|valiant|scarlet|brilliant) lady$/i, 'Virgin Voyages'],
];
// P&O Australia became Carnival in 2025, so its ships and code are Carnival.
// OzCruising cruise codes start with the line: pa26-x623 (P&O Australia), pc26-3618g.1 (Princess), cu24-q432 (Cunard)
const LINE_BY_CODE = { pa: 'Carnival', pc: 'Princess', cu: 'Cunard', rc: 'Royal Caribbean', ce: 'Celebrity', cc: 'Carnival', ca: 'Carnival',
  ha: 'Holland America', hl: 'Holland America', ms: 'MSC', nc: 'Norwegian', vi: 'Viking', oc: 'Oceania', az: 'Azamara', ss: 'Silversea', rs: 'Regent', sb: 'Seabourn' };

export function lineOf({ line, ship, tagline, code } = {}) {
  if (line && /[a-z]/i.test(line)) return tidyLine(line);
  for (const [rx, l] of LINE_BY_SHIP) if (ship && rx.test(ship.trim())) return l;
  for (const [rx, l] of LINE_BY_TAGLINE) if (tagline && rx.test(tagline)) return l;
  const c = /^([a-z]{2})\d/i.exec(code || '');
  return c ? LINE_BY_CODE[c[1].toLowerCase()] || null : null;
}
const tidyLine = l => {
  for (const [rx, name] of LINE_BY_TAGLINE) if (rx.test(l)) return name;
  return String(l).replace(/\s+(?:cruises?|cruise line|line)$/i, '').trim().slice(0, 40);
};

// Ship names as they're written on the cards
const SHIP_RX = new RegExp([
  String.raw`(?:Carnival|Pacific|Celebrity|MSC|Norwegian|Disney|Viking|Azamara|Seabourn|Silver|Seven Seas|Coral|Scenic) +[A-Z][A-Za-z]+(?: +[A-Z][A-Za-z]+)?`,
  String.raw`[A-Z][a-z]+ +of +the +Seas`, String.raw`(?:[A-Z][a-z]+ +)?[A-Z][a-z]+ +Princess`, String.raw`Queen +(?:Elizabeth|Mary +2|Victoria|Anne)`,
  String.raw`(?:Noordam|Westerdam|Oosterdam|Zaandam|Volendam|Eurodam|Nieuw Amsterdam|Koningsdam|Nieuw Statendam|Rotterdam|Zuiderdam)`,
  String.raw`(?:Resilient|Valiant|Scarlet|Brilliant) +Lady`, String.raw`Le +[A-Z][a-z]+`,
].join('|'));
const shipIn = t => { const m = new RegExp(`\\b(?:${SHIP_RX.source})\\b`).exec(t || ''); return m ? m[0].replace(/\s+/g, ' ') : null; };

// ---- dates ----
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = n => String(n).padStart(2, '0');
const DATE_RX = /\b(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s*(\d{4}|\d{2})?\b/i;
const DATE_US_RX = /\b(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i;
const DATE_NUM_RX = /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/;
/** First departure date in the text -> 'YYYY-MM-DD'. A date with no year is the next one from `now`. */
export function dateIn(text, now = Date.now()) {
  const t = String(text || '');
  let y, m, d;
  let x = DATE_RX.exec(t);
  if (x) { d = +x[1]; m = MONTHS.indexOf(x[2].toLowerCase()) + 1; y = x[3] ? +x[3] : null; }
  else if ((x = DATE_US_RX.exec(t))) { m = MONTHS.indexOf(x[1].toLowerCase()) + 1; d = +x[2]; y = +x[3]; }
  else if ((x = DATE_NUM_RX.exec(t))) { d = +x[1]; m = +x[2]; y = +x[3]; }
  else if ((x = /\b(20\d\d)-(\d{2})-(\d{2})/.exec(t))) { y = +x[1]; m = +x[2]; d = +x[3]; }
  else return null;
  if (y != null && y < 100) y += 2000;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  if (y == null) {
    const today = new Date(now);
    y = today.getUTCFullYear();
    if (Date.UTC(y, m - 1, d) < Date.UTC(y, today.getUTCMonth(), today.getUTCDate()) - 864e5) y++;
  }
  return `${y}-${pad(m)}-${pad(d)}`;
}
export const dayMs = ymd => (ymd ? Date.parse(ymd + 'T00:00:00Z') : null);

// ---- fares ----
const OCC = [['quad', /\bquad\b|\b4(?:th)?\s*(?:guest|person|share)|4 share|four share/i], ['triple', /\btriple\b|\b3(?:rd)?\s*(?:guest|person|share)|3 share/i],
  ['solo', /\bsolo\b|\bsingle\b/i], ['twin', /\btwin\b|\bdouble\b|\b2\s*(?:guest|person|share)/i]];
const CABIN = [['inside', /\binside\b|\binterior\b/i], ['oceanview', /ocean\s*view|oceanview|outside|window/i], ['balcony', /balcony|verandah|veranda/i], ['suite', /\bsuite\b|\bmini[-\s]?suite/i]];
// words right before a price that make it not a fare ("Save $500", "was $2,000", "$200 deposit"...)
const BEFORE_NOT = /\b(?:save|saving|savings|was|deposit|credit|onboard|obc|bonus|spend|up to|discount of|reduced by|tax(?:es)?|port charges|gratuities|plus)\s*(?:of|up to|an extra|extra)?\s*$/i;
const AFTER_NOT = /^\s*(?:off\b|onboard|obc\b|credit|deposit|bonus|saving|savings|per\s+night|\/\s*n(?:igh)?t|pn\b|p\.n\.|a\s+night|nightly|discount|per\s+cabin|reduction)/i;
// what can follow a fare and still be its own label: "pp", "per person", "twin share", "(inside)"
const OWN_AFTER = /^\s*(?:pp\b|per\s+person\b|p\/p\b|pps\b)?\s*(?:\([^)$]{0,24}\)|(?:twin|quad|triple|solo|2|3|4)\s+share\b)?/i;
/** Every fare in a block of text: "Twin From $1,308 pp", "Inside from $899pp", "Quad From $654 pp". Struck-out
 *  "was" prices, savings, deposits, onboard credit and per-night figures are left out. */
export function faresIn(text) {
  const out = [];
  const lines = String(text || '').split('\n').map(l => l.replace(/\s+/g, ' ').trim());
  lines.forEach((line, i) => {
    // a label on the line above ("Twin" / "Balcony" then "From $1,308 pp")
    const above = i && lines[i - 1].length < 26 && !/\$/.test(lines[i - 1]) ? lines[i - 1] : '';
    const rx = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?(?!\s*(?:k\b|m\b|\d))/g;
    let m, prevEnd = 0;
    while ((m = rx.exec(line))) {
      const before = line.slice(prevEnd, m.index);
      const rest = line.slice(m.index + m[0].length);
      const own = OWN_AFTER.exec(rest)[0];
      prevEnd = m.index + m[0].length + own.length;
      if (BEFORE_NOT.test(before) || AFTER_NOT.test(rest) || /\bwas\b[^$]{0,6}$/i.test(before)) continue;
      const amount = Number(m[1].replace(/,/g, ''));
      if (!(amount >= 39 && amount <= 250000)) continue;
      let ctx = `${before.slice(-40)} ${own}`;   // its own label, not the previous fare's
      if (!OCC.some(([, r]) => r.test(ctx)) && !CABIN.some(([, r]) => r.test(ctx)) && !/[a-z]{3,}/i.test(before.replace(/\b(?:from|now|only)\b/gi, ''))) ctx = `${above} ${ctx}`;
      const occ = (OCC.find(([, r]) => r.test(ctx)) || [null])[0];
      const cabin = (CABIN.find(([, r]) => r.test(ctx)) || [null])[0];
      out.push({ amount, occ: occ || 'twin', cabin, label: (ctx.replace(/\b(?:from|pp|pps|per person|p\/p|now|only)\b/gi, '').replace(/[^A-Za-z0-9 &/-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || null) });
    }
  });
  return out;
}
const minOf = (fares, occ) => { const a = fares.filter(f => f.occ === occ).map(f => f.amount); return a.length ? Math.min(...a) : null; };
export function leadFares(fares) {
  return { twin: minOf(fares, 'twin'), triple: minOf(fares, 'triple'), quad: minOf(fares, 'quad'), solo: minOf(fares, 'solo') };
}

const BADGE = /\b(?:sale|deal|special|discount(?:ed)?|fares?|bonus|kids sail free|free|offer|limited|last minute|hot|clearance|price drop|lowest|value|exclusive|flash)\b/i;
const NIGHTS_RX = /\b(\d{1,3})\s*-?\s*nights?\b/i;
const NOISE = /^(?:view|book|details|more info|enquire|compare|select|add to|show|hide|see|from|pp|per person|twin share|cruise|cruises|departs?|departing|sailing|ship|itinerary|nights?|\d+|share|save|wishlist|favourite|call|ozcruising)\b.{0,12}$/i;

/** One cruise card's text (+ its link) -> a record. Lines can come in any order. */
export function cardFromText(text, { href = null, portKey = null, now = Date.now() } = {}) {
  const t = String(text || '').replace(/ /g, ' ');
  const lines = t.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const flat = lines.join('\n');
  const nights = Number((NIGHTS_RX.exec(flat) || [])[1]) || null;
  const depart = dateIn(flat, now);
  const fares = faresIn(flat);
  if (!nights || !fares.length) return null;
  const code = codeOf(href);
  // "12 Night Fremantle to Sydney Cruise on the Queen Elizabeth" (a title that carries the ship)
  const onThe = /\bon (?:the|board)\s+([A-Z][A-Za-z0-9 ]{3,40}?)(?:[.,|]|\s+-|\s*$)/m.exec(flat);
  const ship = (onThe && shipIn(onThe[1])) || shipIn(flat) || (onThe ? onThe[1].trim() : null);
  const tagline = lines.find(l => LINE_BY_TAGLINE.some(([rx]) => rx.test(l))) || null;
  const lineName = (/\b(?:cruise line|line|operator)\s*:\s*([A-Za-z&' ]{3,40})/i.exec(flat) || [])[1] || null;
  const fromLine = lines.find(l => /^(?:from|departs?|departing|ex|leaving|embark(?:s|ing)?)\b[:\s]/i.test(l) || /\bdeparts?\s+(?:from\s+)?[A-Z]/.test(l));
  const port = portKeyOf(fromLine) || portKeyOf((/\bfrom\s+([A-Z][A-Za-z() ]{2,30})/.exec(flat) || [])[1]) || portKey;
  const badge = lines.find(l => l.length < 40 && !/\$|\d{3}/.test(l) && BADGE.test(l) && !NIGHTS_RX.test(l) && !LINE_BY_TAGLINE.some(([rx]) => rx.test(l))) || null;
  const isOther = l => l === tagline || l === badge || l === fromLine || /\$/.test(l) || NIGHTS_RX.test(l) && l.length < 14 || DATE_RX.test(l) && l.length < 34 ||
    (ship && l.toLowerCase() === ship.toLowerCase()) || NOISE.test(l) || !/[a-z]{3}/i.test(l);
  // the title: the line just above the ship if it is one (OzCruising: "Vanuatu & Fiji" then "Pacific Adventure"), else the first
  const shipAt = ship ? lines.findIndex(l => l.toLowerCase() === ship.toLowerCase()) : -1;
  const okTitle = l => l && !isOther(l) && l.length >= 3 && l.length <= 110;
  let title = shipAt > 0 && okTitle(lines[shipAt - 1]) ? lines[shipAt - 1] : lines.find(okTitle) || null;
  if (!title && onThe) title = flat.split('\n').find(l => /\bon (?:the|board)\b/.test(l)) || null;
  if (title) title = title.replace(/\.\s*cruise code:.*$/i, '').replace(/\s+-\s+[a-z]{2}\d{2}-[a-z0-9.]+$/i, '').trim().slice(0, 110);
  const lead = leadFares(fares);
  return {
    code, url: href || null, title, ship, line: lineOf({ line: lineName, ship, tagline, code }), port, nights, depart,
    fares: fares.slice(0, 12), ...lead, badge,
  };
}
export const codeOf = href => (/\/cruise\/([a-z0-9][a-z0-9.-]{3,40})(?:[/?#]|$)/i.exec(href || '') || [])[1]?.toLowerCase() || null;

/** A whole page's text (pasted, or read when the cards can't be told apart) -> records.
 *  Each cruise has its nights; cards are cut between one cruise's nights and the next. Where the fares come after
 *  the nights (OzCruising's cards), the cut goes after the last fare (and its "View cruise" button); otherwise
 *  straight after the nights. */
export function cardsFromPageText(text, { portKey = null, now = Date.now() } = {}) {
  const lines = String(text || '').replace(/ /g, ' ').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const isP = l => /\$/.test(l) && faresIn(l).length > 0;
  // nights lines; a title that says "12 Night ... Cruise" and a "12 nights" line with no fare between are one cruise
  const N = [];
  lines.forEach((l, i) => {
    if (!NIGHTS_RX.test(l)) return;
    const prev = N[N.length - 1];
    if (prev != null && i - prev <= 6 && !lines.slice(prev + 1, i).some(isP)) return;
    N.push(i);
  });
  if (!N.length) return [];
  const faresAfter = N.length > 1 ? lines.slice(N[0] + 1, N[1]).some(isP) && !lines.slice(Math.max(0, N[0] - 6), N[0]).some(isP)
    : lines.slice(N[0] + 1).some(isP);
  const skippable = l => NOISE.test(l) || /^(?:view|book|details|more|enquire|compare|select|quick view)\b/i.test(l) && l.length < 30;
  const cuts = [Math.max(0, N[0] - 6)];
  for (let k = 0; k < N.length - 1; k++) {
    let b;
    if (faresAfter) {
      let last = -1;
      for (let i = N[k] + 1; i < N[k + 1]; i++) if (isP(lines[i])) last = i;
      b = last >= 0 ? last + 1 : N[k] + 1;
    } else b = N[k] + 1;
    while (b < N[k + 1] && (skippable(lines[b]) || !faresAfter && (DATE_RX.test(lines[b]) && lines[b].length < 34 || /^(?:from|departs?|departing)\b/i.test(lines[b])))) b++;
    cuts.push(Math.min(b, N[k + 1]));
  }
  cuts.push(lines.length);
  const out = [];
  for (let k = 0; k < N.length; k++) {
    const rec = cardFromText(lines.slice(cuts[k], cuts[k + 1]).join('\n'), { portKey, now });
    if (rec) out.push(rec);
  }
  return dedupe(out);
}

// ---- the data the page loads ----
const pick = (o, rxs) => {
  for (const rx of rxs) for (const [k, v] of Object.entries(o)) if (rx.test(k) && v != null && v !== '') return v;
  return null;
};
const str = v => (v == null ? null : typeof v === 'object' ? (v.name ?? v.title ?? v.label ?? v.displayName ?? null) : String(v));
const numv = v => { if (v == null) return null; if (typeof v === 'object') v = v.amount ?? v.value ?? v.price ?? null; const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
/** Objects anywhere in a JSON body that look like cruises (a ship or itinerary, nights, a price). */
function cruiseObjects(body, out = [], depth = 0) {
  if (!body || typeof body !== 'object' || depth > 7) return out;
  if (Array.isArray(body)) { for (const x of body) cruiseObjects(x, out, depth + 1); return out; }
  const keys = Object.keys(body).join(' ');
  if (/night|duration/i.test(keys) && /price|fare|cost|amount|from/i.test(keys) && /ship|vessel|itinerary|title|name/i.test(keys)) out.push(body);
  else for (const v of Object.values(body)) if (v && typeof v === 'object') cruiseObjects(v, out, depth + 1);
  return out;
}
export function cardsFromJson(bodies, { portKey = null, now = Date.now() } = {}) {
  const out = [];
  for (const { body } of bodies || []) {
    for (const o of cruiseObjects(body)) {
      const nights = Number(numv(pick(o, [/^nights?$/i, /numberofnights|nightcount|nights/i, /^duration$/i, /duration/i]))) || null;
      const ship = str(pick(o, [/^ship(?:name)?$/i, /shipname|vesselname/i, /^ship$|^vessel$/i]));
      const line = str(pick(o, [/^(?:cruise)?line(?:name)?$/i, /cruiseline|brand|operator/i]));
      const depart = dateIn(String(pick(o, [/^(?:departure|sail|start|depart)(?:ure)?date$/i, /sail.?date|depart.*date|start.?date|^date$/i]) ?? ''), now);
      const portTxt = str(pick(o, [/departure.?port|embark.*port|^port$|from.?port|departure.?place/i, /^from$|departure/i]));
      const href = str(pick(o, [/^url$|^link$|href|permalink|^slug$/i]));
      const codeTxt = str(pick(o, [/cruise.?code|^code$|^cruiseid$/i]));
      const title = str(pick(o, [/^title$|itinerary.?name|^name$|headline|destination/i]));
      // fares: a list of prices, or price fields named by occupancy / cabin
      const fares = [];
      const add = (amount, label) => { const n = numv(amount); if (n && n >= 39 && n <= 250000) fares.push(...faresIn(`${label || ''} $${n}`)); };
      for (const [k, v] of Object.entries(o)) {
        if (/price|fare|from|cost/i.test(k) && !/was|old|original|save|saving|deposit|credit|tax|per.?night|currency/i.test(k)) {
          if (Array.isArray(v)) for (const p of v) { if (p && typeof p === 'object') add(p.price ?? p.amount ?? p.fare ?? p.value, `${p.occupancy ?? p.type ?? p.cabin ?? p.name ?? p.label ?? ''} ${p.cabinType ?? p.category ?? ''}`); }
          else if (v && typeof v === 'object' && !('amount' in v || 'value' in v)) { for (const [k2, v2] of Object.entries(v)) add(v2, `${k} ${k2}`.replace(/([a-z])([A-Z])/g, '$1 $2')); }
          else add(v, k.replace(/([a-z])([A-Z])/g, '$1 $2'));
        }
      }
      if (!nights || !fares.length) continue;
      const url = href ? (href.startsWith('http') ? href : `${OZ}${href.startsWith('/') ? '' : '/cruise/'}${href}`) : codeTxt ? `${OZ}/cruise/${String(codeTxt).toLowerCase()}` : null;
      const code = codeOf(url) || (codeTxt ? String(codeTxt).toLowerCase() : null);
      out.push({ code, url, title: title ? String(title).slice(0, 110) : null, ship, line: lineOf({ line, ship, code }),
        port: portKeyOf(portTxt) || portKey, nights, depart, fares: fares.slice(0, 12), ...leadFares(fares), badge: null });
    }
  }
  return dedupe(out);
}

/** One record per cruise: by its code, else ship + date + nights. Keeps the lower fares and any fields one copy lacks. */
export const keyOf = r => (r.code ? `oz:${r.code}` : `oz:${(r.ship || r.title || '?').toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${r.depart || '?'}:${r.nights}`);
export function dedupe(recs) {
  const by = new Map();
  for (const r of recs) {
    if (!r) continue;
    const k = keyOf(r);
    const p = by.get(k);
    if (!p) { by.set(k, { ...r }); continue; }
    for (const f of ['code', 'url', 'title', 'ship', 'line', 'port', 'depart', 'badge']) if (p[f] == null && r[f] != null) p[f] = r[f];
    for (const f of ['twin', 'triple', 'quad', 'solo']) if (r[f] != null && (p[f] == null || r[f] < p[f])) p[f] = r[f];
    if (r.fares?.length > (p.fares?.length || 0)) p.fares = r.fares;
  }
  return [...by.values()];
}

/** What a night costs each person: on the cheapest twin-share fare, and on a 3rd/4th-guest share fare (cheaper,
 *  but only if you fill the cabin). Either can be missing: some cards only show a share fare. */
export function nightly(r) {
  if (!r?.nights) return { twin: null, share: null };
  const share = [r.triple, r.quad].filter(v => v != null);
  return { twin: r.twin != null ? r.twin / r.nights : null, share: share.length ? Math.min(...share) / r.nights : null };
}
