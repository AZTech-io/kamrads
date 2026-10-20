// What a lot really costs you: the bid, plus the auction house's buyer's premium / fee, plus GST
// where the listing says "+GST", plus a rough transport estimate to your home base.
// Every figure here is an estimate you can change in .env - the sites' own terms are the final word.
import { config } from './config.js';
import { distanceKm } from './geo.js';
import { isVehicle } from './extract.js';

/** Buyer's fee by price band: "2000:495,5000:650,30000:7%,*:5%" (a flat $ or a % of the price). */
export function tierFee(spec, price) {
  for (const part of String(spec || '').split(',')) {
    const [lim, fee] = part.split(':').map(s => s.trim());
    if (lim === '*' || price <= Number(lim)) return /%$/.test(fee) ? Math.round(price * parseFloat(fee) / 100) : Number(fee) || 0;
  }
  return 0;
}

const heavy = l => /\btrucks?\b|prime mover|tipper|trailer|excavat|loader|tractor|bus\b|machinery|plant/i.test(`${l.category || ''} ${l.title || ''} ${l.url || ''}`);

export function transportCost(lot, base) {
  const d = distanceKm(lot, base);
  if (!d) return { cost: null, km: null, approx: true };
  const t = config.transport;
  if (d.km <= t.pickupKm) return { cost: 0, km: d.km, approx: d.approx, how: 'pick up yourself' };
  let cost;
  if (isVehicle(lot)) cost = (t.vehicleBase + t.vehiclePerKm * d.km) * (heavy(lot) ? t.heavyFactor : 1);
  else cost = t.goodsBase + t.goodsPerKm * d.km;
  return { cost: Math.round(cost / 10) * 10, km: d.km, approx: d.approx, how: isVehicle(lot) ? (heavy(lot) ? 'heavy transport' : 'car carrier') : 'freight' };
}

// Which of an auction house's fee schedules applies (Pickles has one per product line).
const writtenOff = l => /write-?off|statutory|repairable|inspection passed/i.test(l.wovr || '') || /salvage|damaged|insurance/i.test(`${l.sale_name || ''} ${l.url || ''} ${l.category || ''}`);
export function feeLine(lot) {
  if (writtenOff(lot) && isVehicle(lot)) return 'salvage';
  if (/\btrucks?\b|trailer|machinery|plant|forklift|excavat|tractor|industrial|mining|agricultur/i.test(`${lot.category || ''} ${lot.url || ''} ${lot.title || ''}`)) return 'industrial';
  if (isVehicle(lot)) return 'cars';
  return 'general';
}

/** The fee schedule for one lot: { tiers | pct, processing } */
function scheduleFor(lot) {
  const f = config.fees[lot.site] || {};
  if (f.lines) { const line = feeLine(lot); return { ...(f.lines[line] || f.lines.general || {}), line }; }
  // older single-schedule sites: flat tiers for vehicles, % for goods
  if (f.tiers && isVehicle(lot)) return { tiers: f.tiers };
  return { pct: f.premiumPct ?? f.goodsPct ?? 0 };
}

/**
 * All-in cost for a price (defaults to the lot's current bid / start price).
 * Transport is only added when the person has it turned on (Settings) - otherwise it's left for you to work out.
 */
export function allIn(lot, base, price = lot.bid ?? lot.start_price, { transport = false } = {}) {
  if (price == null) return null;
  const sch = scheduleFor(lot);
  // a lot's own "Buyer's Premium x%" (read from its page) wins over the schedule
  const pct = lot.buyer_premium ?? (sch.tiers ? 0 : sch.pct ?? 0);
  const premium = pct ? Math.round(price * pct / 100) : 0;
  const fee = lot.buyer_premium == null && sch.tiers ? tierFee(sch.tiers, price) : 0;
  const processing = Number(sch.processing) || 0;
  const gst = lot.gst_extra ? Math.round(price * 0.1) : 0;
  const tr = base ? transportCost(lot, base) : { cost: null };
  const freight = transport ? tr.cost : null;
  const fees = premium + fee + processing + gst;
  return {
    price, premiumPct: pct || null, premium, fee, processing, gst, fees, feeLine: sch.line || null,
    transport: freight, transportOn: !!transport, km: tr.km ?? null, kmApprox: tr.approx, how: transport ? tr.how || null : null,
    total: price + fees + (freight || 0),
    landed: price + fees, // what you pay the auction house
  };
}

/** The highest bid whose all-in cost stays within a budget (for "I can spend $X all-in"). */
export function maxBidFor(lot, base, budget, opts = {}) {
  if (!(budget > 0)) return null;
  let lo = 0, hi = Math.ceil(budget);
  if ((allIn(lot, base, 0, opts)?.total ?? 0) > budget) return 0;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (allIn(lot, base, mid, opts).total <= budget) lo = mid; else hi = mid - 1; }
  return lo;
}
