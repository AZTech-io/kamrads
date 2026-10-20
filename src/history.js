// "What did similar lots actually sell for?" from our own results - free, and real auction prices.
// Vehicles are grouped by make + model (and write-off class: a statutory write-off is a different
// market), then narrowed to a similar year.
import { q } from './db.js';
import { isVehicle } from './extract.js';

const MAKES = ['toyota', 'ford', 'holden', 'nissan', 'mazda', 'mitsubishi', 'hyundai', 'kia', 'isuzu', 'hino', 'volvo', 'scania', 'kenworth',
  'mack', 'iveco', 'fuso', 'mercedes-benz', 'mercedes', 'renault', 'volkswagen', 'subaru', 'suzuki', 'honda', 'bmw', 'audi', 'jeep',
  'land rover', 'range rover', 'ldv', 'great wall', 'gwm', 'haval', 'mg', 'peugeot', 'citroen', 'skoda', 'tesla', 'chrysler', 'dodge',
  'ram', 'chevrolet', 'lexus', 'porsche', 'jaguar', 'yamaha', 'kawasaki', 'harley-davidson', 'harley', 'ducati', 'ktm', 'triumph',
  'daihatsu', 'ssangyong', 'foton', 'freightliner', 'western star', 'international', 'daf', 'man', 'byd', 'cupra', 'alfa romeo', 'fiat', 'mini'];
const MAKE_RE = new RegExp(`\\b(${MAKES.map(m => m.replace(/[-\s]/g, '[- ]?')).join('|')})\\b\\s+([a-z0-9][a-z0-9-]*)`, 'i');
const canon = m => m.toLowerCase().replace(/[- ]/g, '').replace(/^mercedesbenz$/, 'mercedes').replace(/^harleydavidson$/, 'harley').replace(/^rangerover$/, 'landrover');

/** "2016 Mercedes-Benz Sprinter 316 CDI" -> { make: 'mercedes', model: 'sprinter', year: 2016 } */
export function identify(lot) {
  const t = String(lot.title || '');
  const m = MAKE_RE.exec(t);
  if (!m) return null;
  const year = lot.year || Number((/\b(19[5-9]\d|20[0-3]\d)\b/.exec(t) || [])[1]) || null;
  return { make: canon(m[1]), model: m[2].toLowerCase(), year };
}
const wclass = l => (/statutory/i.test(l.wovr || '') ? 'stat' : /repairable/i.test(l.wovr || '') ? 'rep' : 'clean');
const keyOf = (id, l) => `${id.make}|${id.model}|${wclass(l)}`;

let index = new Map(), builtAt = 0;
const MAX_AGE_MS = 10 * 60000;

function build(now = Date.now()) {
  const next = new Map();
  for (const l of q.historyRows.all(now - 365 * 86400000)) {
    if (!isVehicle(l)) continue;
    const id = identify(l);
    if (!id) continue;
    const k = keyOf(id, l);
    if (!next.has(k)) next.set(k, []);
    next.get(k).push({ key: l.key, title: l.title, price: l.final_bid, year: id.year, km: l.odometer, at: l.end_at, url: l.url, site: l.site });
  }
  index = next; builtAt = now;
}
export const rebuild = () => build();

const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Similar sold lots: { n, median, low, high, examples[] } or null when we have fewer than 2. */
export function soldLike(lot, { minN = 2 } = {}) {
  if (Date.now() - builtAt > MAX_AGE_MS) build();
  if (!isVehicle(lot)) return null;
  const id = identify(lot);
  if (!id) return null;
  let rows = (index.get(keyOf(id, lot)) || []).filter(r => r.key !== lot.key);
  if (id.year) {
    const near = rows.filter(r => r.year && Math.abs(r.year - id.year) <= 2);
    rows = near.length >= minN ? near : rows.filter(r => r.year && Math.abs(r.year - id.year) <= 4);
  }
  if (rows.length < minN) return null;
  const prices = rows.map(r => r.price);
  return {
    n: rows.length, median: Math.round(median(prices)), low: Math.min(...prices), high: Math.max(...prices),
    label: `${id.make} ${id.model}${id.year ? ` ${id.year - 2}–${id.year + 2}` : ''}`,
    examples: rows.sort((a, b) => b.at - a.at).slice(0, 5),
  };
}

/** Estimate from history, only when there's enough of it to trust (3+ results). */
export function historyEstimate(lot) {
  const h = soldLike(lot, { minN: 3 });
  return h ? h.median : null;
}
