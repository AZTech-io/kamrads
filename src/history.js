// "What did similar lots actually sell for?" from our own results - free, and real auction prices.
// Vehicles are grouped by make + model (and write-off class: a statutory write-off is a different
// market), then narrowed to a similar year.
import { q } from './db.js';
import { isVehicle } from './extract.js';

import { identify } from './vehicle.js';
import { sectorOf } from './categories.js';
export { identify };

// Write-off class, and which market it sold in: salvage sales (hail, insurance, non-runners) go for a
// fraction of what the same car makes at a general vehicle auction, so they're never compared.
const SALVAGE = /salvage|insurance|insurer|write-?\s?off|damaged|\bhail\b|non[\s-]?runner|flood|fire\s+damage|repairable|wovr(?!\s*n\/a)/i;
// (KAMRADS only searches Pickles' salvage sales, so every Pickles result is salvage)
const marketOf = l => (l.site === 'pickles' || SALVAGE.test(`${l.category || ''} ${l.sale_name || ''} ${l.url || ''} ${l.buy_method || ''} ${l.title || ''} ${l.wovr && !/n\/a/i.test(l.wovr) ? l.wovr : ''}`) ? 'salvage' : 'retail');
const wclass = l => `${/statutory/i.test(l.wovr || '') ? 'stat' : /repairable/i.test(l.wovr || '') ? 'rep' : 'clean'}|${marketOf(l)}`;
const keyOf = (id, l) => `${id.make}|${id.model}|${wclass(l)}`;

let index = new Map(), byType = new Map(), builtAt = 0, memo = new Map();
const MAX_AGE_MS = 10 * 60000;

function build(now = Date.now()) {
  const next = new Map(), types = new Map();
  for (const l of q.historyRows.all(now - 365 * 86400000)) {
    if (!isVehicle(l)) continue;
    const id = identify(l);
    if (!id) continue;
    const k = keyOf(id, l);
    if (!next.has(k)) next.set(k, []);
    const row = { key: l.key, title: l.title, price: l.final_bid, year: id.year, km: l.odometer, at: l.end_at, url: l.url, site: l.site, make: id.make };
    next.get(k).push(row);
    const t = `${sectorOf(l)}|${wclass(l)}`;
    if (!types.has(t)) types.set(t, []);
    types.get(t).push(row);
  }
  index = next; byType = types; builtAt = now; memo = new Map();
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

export { marketOf };
const TYPE_NAME = { cars: 'cars', vans: 'vans', trucks: 'trucks', trailers: 'trailers', bikes: 'motorbikes', marine: 'boats' };
/**
 * A rough value when we haven't seen enough of this model sell: sold vehicles of the same type (vans, utes,
 * trucks...) and write-off class, of a similar age and kilometres; the same make counts closer.
 * Needs the year. { n, median, low, high, label, rough: true, examples } or null.
 */
export function typeLike(lot, { minN = 8, k = 15 } = {}) {
  if (Date.now() - builtAt > MAX_AGE_MS) build();
  if (!isVehicle(lot)) return null;
  if (memo.has(lot.key)) return memo.get(lot.key);
  const id = identify(lot);
  let out = null;
  if (id?.year) {
    const type = sectorOf(lot);
    const km = lot.odometer || null;
    let rows = (byType.get(`${type}|${wclass(lot)}`) || []).filter(r => r.key !== lot.key && r.year && Math.abs(r.year - id.year) <= 3);
    if (km) rows = rows.filter(r => !r.km || Math.abs(r.km - km) <= 120000);
    if (rows.length >= minN) {
      const dist = r => Math.abs(r.year - id.year) / 2 + (km && r.km ? Math.abs(r.km - km) / 50000 : 0.75) + (r.make === id.make ? 0 : 0.6);
      const near = rows.map(r => ({ ...r, d: dist(r) })).sort((a, b) => a.d - b.d).slice(0, k);
      const w = near.map(r => ({ p: r.price, w: 1 / (1 + r.d) })).sort((a, b) => a.p - b.p);
      const half = w.reduce((t, x) => t + x.w, 0) / 2;
      let acc = 0, med = w[w.length - 1].p;
      for (const x of w) { acc += x.w; if (acc >= half) { med = x.p; break; } }
      const sorted = near.map(r => r.price).sort((a, b) => a - b);
      out = {
        n: near.length, of: rows.length, median: Math.round(med), rough: true,
        // middle of the spread, not the extremes (one wreck or one show car shouldn't set the range)
        low: sorted[Math.floor(sorted.length * 0.25)], high: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))],
        label: `rough: ${near.length} ${TYPE_NAME[type] || type} ${id.year - 3}–${id.year + 3}${km ? `, ${Math.round(Math.max(0, km - 120000) / 1000)}–${Math.round((km + 120000) / 1000)}k km` : ''}`,
        examples: near.slice(0, 6),
      };
    }
  }
  memo.set(lot.key, out);
  return out;
}
export const typeEstimate = lot => (lot.key ? typeLike(lot)?.median ?? null : null);
