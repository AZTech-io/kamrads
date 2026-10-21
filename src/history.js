// "What did similar lots actually sell for?" from our own results - free, and real auction prices.
// Vehicles are grouped by make + model (and write-off class: a statutory write-off is a different
// market), then narrowed to a similar year.
import { q } from './db.js';
import { isVehicle } from './extract.js';

import { identify } from './vehicle.js';
export { identify };

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

/**
 * Similar sold lots: { n, median, low, high, label, examples[] } or null when we have fewer than minN.
 * The closest matches by year and kilometres count most (a 90,000 km van is valued against other low-km ones).
 */
export function soldLike(lot, { minN = 2, k = 9 } = {}) {
  if (Date.now() - builtAt > MAX_AGE_MS) build();
  if (!isVehicle(lot)) return null;
  const id = identify(lot);
  if (!id) return null;
  let rows = (index.get(keyOf(id, lot)) || []).filter(r => r.key !== lot.key);
  if (id.year) rows = rows.filter(r => !r.year || Math.abs(r.year - id.year) <= 4);
  if (rows.length < minN) return null;
  const km = lot.odometer || null;
  const dist = r => (id.year && r.year ? Math.abs(r.year - id.year) / 2 : 0.75) + (km && r.km ? Math.abs(r.km - km) / 40000 : 0.75);
  const near = rows.map(r => ({ ...r, d: dist(r) })).sort((a, b) => a.d - b.d).slice(0, k);
  // weighted median: closer results weigh more
  const w = near.map(r => ({ p: r.price, w: 1 / (1 + r.d) })).sort((a, b) => a.p - b.p);
  const half = w.reduce((t, x) => t + x.w, 0) / 2;
  let acc = 0, med = w[w.length - 1].p;
  for (const x of w) { acc += x.w; if (acc >= half) { med = x.p; break; } }
  const kms = near.map(r => r.km).filter(Boolean);
  return {
    n: near.length, of: rows.length, median: Math.round(med), low: Math.min(...near.map(r => r.price)), high: Math.max(...near.map(r => r.price)),
    label: `${id.make} ${id.model}${id.year ? ` ${id.year - 2}–${id.year + 2}` : ''}${kms.length ? `, ${Math.round(Math.min(...kms) / 1000)}–${Math.round(Math.max(...kms) / 1000)}k km` : ''}`,
    examples: near.sort((a, b) => a.d - b.d).slice(0, 6),
  };
}

/** Estimate from history, only when there's enough of it to trust (3+ results). */
export function historyEstimate(lot) {
  const h = soldLike(lot, { minN: 3 });
  return h ? h.median : null;
}
