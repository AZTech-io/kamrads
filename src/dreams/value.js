// Valuing a dream lot.
//   Retail value: what the same vehicle costs from a dealer, from the Trucksales / Carsales listings we hold.
//     Each comparable listing is re-priced to this lot's year and kilometres (depreciation rates learned from
//     the listings themselves), then the closest ones by spec (drive, cab, truck class...) are blended.
//   Expected hammer: what it will probably sell for at auction - from our own sold results where we have
//     them, else retail value x the auction/retail ratio (learned from sold results, starting at a default).
//   Deal: what it's worth to you once fixed (retail less any write-off stigma) against what you'd pay all-in
//     (bid + buyer's fees + GST + transport home + repairs + roadworthy/rego).
import { allIn, maxBidFor } from '../costs.js';
import { features, damageOf, specGap, trimRatio, KINDS } from './model.js';

const LOG = Math.log;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, to = 50) => (v == null || !Number.isFinite(v) ? null : Math.round(v / to) * to);

/** Weighted quantile of [{ v, w }] */
function wq(rows, p) {
  const s = [...rows].sort((a, b) => a.v - b.v);
  const tot = s.reduce((t, r) => t + r.w, 0);
  let acc = 0;
  for (const r of s) { acc += r.w; if (acc >= tot * p) return r.v; }
  return s[s.length - 1]?.v ?? null;
}

/**
 * Depreciation rates from a pool of priced vehicles: log(price) against year and km, within groups of the
 * same spec (so a 16 t FVL and a 4.5 t NLR don't distort each other). Shrunk towards sensible defaults.
 * { year: +share per year newer, km: -share per 100,000 km more, n }
 */
export function fitRates(pool, kind) {
  const cfg = KINDS[kind] || KINDS.custom;
  const groups = new Map();
  for (const c of pool) {
    if (!(c.price > 0) || !c.year || c.km == null) continue;
    const g = cfg.group(c.f);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ y: LOG(c.price), x: c.year, k: c.km / 100000 });
  }
  let sxx = 0, sxk = 0, skk = 0, sxy = 0, sky = 0, n = 0;
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const m = rows.reduce((a, r) => ({ y: a.y + r.y / rows.length, x: a.x + r.x / rows.length, k: a.k + r.k / rows.length }), { y: 0, x: 0, k: 0 });
    for (const r of rows) {
      const y = r.y - m.y, x = r.x - m.x, k = r.k - m.k;
      sxx += x * x; sxk += x * k; skk += k * k; sxy += x * y; sky += k * y; n++;
    }
  }
  const def = cfg.rates;
  const det = sxx * skk - sxk * sxk;
  if (n < 8 || Math.abs(det) < 1e-9) return { ...def, n, fitted: false };
  const by = (sxy * skk - sky * sxk) / det;   // per year
  const bk = (sky * sxx - sxy * sxk) / det;   // per 100,000 km (negative = cheaper with more km)
  const w = n / (n + 12);
  const year = by > 0 ? clamp(w * by + (1 - w) * def.year, 0.03, 0.16) : def.year;
  const km = bk < 0 ? clamp(w * -bk + (1 - w) * def.km, 0.02, 0.3) : def.km;
  return { year: Math.round(year * 1000) / 1000, km: Math.round(km * 1000) / 1000, n, fitted: true };
}

/**
 * Value one vehicle ({ year, km, f }) from comparables ({ key, price, year, km, f, ... }).
 * Each comparable is re-priced to this vehicle's year and km, the nearest k blended (weighted median).
 */
export function valueFrom(item, pool, { kind, rates, k = 8, exclude = null } = {}) {
  const cfg = KINDS[kind] || KINDS.custom;
  const rows = [];
  for (const c of pool) {
    if (!(c.price > 0) || (exclude && c.key === exclude)) continue;
    const dy = item.year && c.year ? item.year - c.year : null;
    const dk = item.km != null && c.km != null ? item.km - c.km : null;
    const gap = specGap(kind, item.f, c.f);
    const d = (dy == null ? 1.5 : Math.abs(dy) * 0.5) + (dk == null ? 0.6 : Math.abs(dk) / cfg.kmScale) + gap;
    let factor = 1;
    if (dy != null) factor *= Math.exp(rates.year * dy);
    if (dk != null) factor *= Math.exp(-rates.km * dk / 100000);
    // a different trim (an SX against X-Terrains): re-price by the trims' usual gap
    const crossTrim = !!(item.f.trim && c.f?.trim && item.f.trim !== c.f.trim);
    if (crossTrim) factor *= trimRatio(item.f.trim, c.f.trim);
    factor = clamp(factor, 0.4, 2.5);
    rows.push({ c, d, adj: c.price * factor, factor, crossTrim });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => a.d - b.d);
  const near = rows.slice(0, k);
  const w = near.map(r => ({ v: r.adj, w: 1 / (1 + r.d) ** 2 }));
  const meanD = near.reduce((t, r) => t + r.d, 0) / near.length;
  const cross = near.filter(r => r.crossTrim).length;
  const confidence = cross * 2 > near.length ? 'rough' : near.length >= 5 && meanD <= 1.6 ? 'good' : near.length >= 3 && meanD <= 3 ? 'fair' : 'rough';
  return {
    value: round(wq(w, 0.5), 100), low: round(wq(w, 0.25), 100), high: round(wq(w, 0.75), 100),
    n: near.length, of: rows.length, gap: Math.round(meanD * 10) / 10, confidence, otherTrim: cross,
    comps: near.slice(0, 8).map(r => ({ key: r.c.key, title: r.c.title, price: r.c.raw ?? r.c.price, adj: Math.round(r.adj), year: r.c.year, km: r.c.km, seller: r.c.seller,
      source: r.c.source, url: r.c.url || null, state: r.c.state || null, at: r.c.at || null, d: Math.round(r.d * 10) / 10 })),
  };
}

/** Auction price as a share of retail value, from sold results we can value. Starts at the type's default. */
export function calibrate(sold, retailPool, { kind, rates }) {
  const f0 = (KINDS[kind] || KINDS.custom).factor;
  const ratios = [];
  for (const s of sold) {
    const v = valueFrom(s, retailPool, { kind, rates });
    if (!v || v.confidence === 'rough') continue;
    const r = s.price / v.value;
    if (r > 0.3 && r < 1.3) ratios.push(r);
  }
  if (!ratios.length) return { factor: f0, n: 0, observed: null, start: f0 };
  ratios.sort((a, b) => a - b);
  const med = ratios[ratios.length >> 1];
  const n = ratios.length;
  return { factor: Math.round(((n * med + 4 * f0) / (n + 4)) * 1000) / 1000, n, observed: Math.round(med * 1000) / 1000, start: f0 };
}

export const asItem = (l, extra = {}) => {
  const f = features(`${l.title || ''} ${l.body || ''}`);
  // the site's own category says truck (Pickles /used/details/trucks/...) even when the title has no model code
  if (!f.truck && f.isuzu && !f.dmax && !f.mux && /\btrucks?\b/i.test(`${l.category || ''} ${(l.url || '').replace(/[/_-]/g, ' ')}`)) f.truck = true;
  return { key: l.key, title: l.title, year: l.year || Number((/\b(19[5-9]\d|20[0-3]\d)\b/.exec(l.title || '') || [])[1]) || null, km: l.odometer ?? l.km ?? null, f, ...extra };
};

const LEVELS = ['avoid', 'unknown', 'market', 'fair', 'good', 'diamond'];
export const levelRank = v => LEVELS.indexOf(v);
export function verdictOf(pct, target) {
  if (pct == null) return 'unknown';
  if (pct >= target) return 'diamond';
  if (pct >= target * 0.6) return 'good';
  if (pct >= 0.05) return 'fair';
  return 'market';
}

/**
 * Everything about one auction lot for one dream.
 * ctx: { kind, s (dream settings), retailPool, rates, auctionClean, auctionDamaged, cal, base, notes: Map }
 */
export function analyze(lot, ctx) {
  const { kind, s, rates } = ctx;
  const cfg = KINDS[kind] || KINDS.custom;
  const item = asItem(lot);
  const dmg = damageOf({ ...lot, check_flags: lot.check_note || '' }, { stigma: s.stigma ?? cfg.stigma });
  let retail = valueFrom(item, ctx.retailPool, { kind, rates });
  // No dealer / private listings to go by yet: work back from what clean ones sold for at auction
  if (!retail && ctx.auctionClean?.length >= 3) {
    const a = valueFrom(item, ctx.auctionClean, { kind, rates, k: 6, exclude: lot.key });
    if (a && a.n >= 3 && a.gap <= 3) {
      const up = v => round(v / ctx.cal.factor, 100);
      retail = { ...a, value: up(a.value), low: up(a.low), high: up(a.high), confidence: 'from auction', comps: a.comps };
    }
  }
  const effective = retail ? Math.round(retail.value * (1 - dmg.stigmaPct)) : null;
  const note = ctx.notes?.get(lot.key) || null;
  const repair = note?.repair != null ? note.repair : retail ? round(retail.value * dmg.allowancePct, 50) : 0;
  const onRoad = Number(s.onRoad ?? cfg.onRoad) || 0;
  const transport = s.transport !== false;
  const current = lot.status === 'closed' ? lot.final_bid : lot.bid ?? lot.start_price ?? null;
  // what it'll probably go for
  const pool = dmg.level === 'clean' ? ctx.auctionClean : ctx.auctionDamaged;
  const auction = pool?.length ? valueFrom(item, pool, { kind, rates, k: 6, exclude: lot.key }) : null;
  const formula = effective != null ? Math.max(0, (effective - repair) * ctx.cal.factor) : null;
  let expected = null, expectedFrom = null;
  if (lot.buy_now && !lot.bid && lot.status !== 'closed') { expected = lot.buy_now; expectedFrom = 'buy now price'; }
  else if (auction && auction.n >= 3 && auction.gap <= 3) {
    const w = auction.n / (auction.n + 3);
    expected = formula != null ? w * auction.value + (1 - w) * formula : auction.value;
    expectedFrom = `${auction.n} similar sold at auction${formula != null ? ' + retail' : ''}`;
  } else if (formula != null) { expected = formula; expectedFrom = `retail × ${Math.round(ctx.cal.factor * 100)}%`; }
  if (expected != null && current != null && lot.status !== 'closed') expected = Math.max(expected, current);
  expected = round(expected, 100);

  const costAt = price => {
    if (price == null) return null;
    const c = allIn(lot, ctx.base, price, { transport });
    const total = Math.round(c.total + repair + onRoad);
    return { price, fees: c.fees, gst: c.gst, transport: c.transport, transportHow: c.how, km: c.km, repair, onRoad, total,
      saving: effective != null ? effective - total : null, pct: effective ? (effective - total) / effective : null };
  };
  const now = costAt(current);
  const atExpected = costAt(expected);
  // the most you can bid and still land it target% under what it's worth (and within the budget)
  let maxBid = null;
  if (effective != null) {
    let room = effective * (1 - s.target);
    if (s.budget > 0) room = Math.min(room, s.budget);
    room -= repair + onRoad;
    maxBid = room > 0 ? round(maxBidFor(lot, ctx.base, room, { transport }), 50) : 0;
  }
  const verdict = dmg.avoid ? 'avoid' : verdictOf(atExpected?.pct ?? null, s.target);
  const verdictNow = dmg.avoid ? 'avoid' : verdictOf(now?.pct ?? null, s.target);

  // the dream's own limits (lots outside them stay listed, but never buzz your phone)
  const misses = [];
  if (s.yearMin && item.year && item.year < s.yearMin) misses.push(`older than ${s.yearMin}`);
  if (s.yearMax && item.year && item.year > s.yearMax) misses.push(`newer than ${s.yearMax}`);
  if (s.kmMax && item.km && item.km > s.kmMax) misses.push(`over ${Math.round(s.kmMax / 1000)}k km`);
  if (s.classes?.length && item.f.cls && !s.classes.includes(item.f.cls)) misses.push('not a class you want');
  if (s.drive && item.f.drive && item.f.drive !== s.drive) misses.push(`not ${s.drive}`);
  if (s.cab && item.f.cab && item.f.cab !== s.cab) misses.push(`not ${s.cab} cab`);
  if (s.trims?.length && kind === 'dmax' && !(item.f.trim && s.trims.includes(item.f.trim))) misses.push(item.f.trim ? `${item.f.trim.toUpperCase()}, not a trim you want` : 'trim not stated');
  if (dmg.level === 'statutory') misses.push('statutory write-off');
  if (dmg.level === 'repairable' && !s.allowRepairable) misses.push('repairable write-off');
  if (dmg.level === 'damaged' && !s.allowDamaged) misses.push('damaged');
  if (s.budget > 0 && atExpected && atExpected.total > s.budget) misses.push(`likely over your $${Math.round(s.budget / 1000)}k budget`);

  return {
    item: { year: item.year, km: item.km, ...item.f },
    damage: { ...dmg, repair, repairFrom: note?.repair != null ? 'yours' : dmg.allowancePct ? `${Math.round(dmg.allowancePct * 100)}% allowance` : null, note: note?.note || null },
    retail, effective, auction: auction && auction.n >= 2 && auction.gap <= 3 ? auction : null, factor: ctx.cal.factor,
    expected, expectedFrom, current, now, atExpected, maxBid, onRoad, transportOn: transport,
    verdict, verdictNow, score: atExpected?.pct ?? null, inCriteria: !misses.length, misses,
  };
}
