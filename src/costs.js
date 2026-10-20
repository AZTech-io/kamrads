// What a lot really costs you: the bid, plus the auction house's buyer's premium / fee, plus GST
// where the listing says "+GST", plus a rough transport estimate to your home base.
// Every figure here is an estimate you can change in .env - the sites' own terms are the final word.
import { config } from './config.js';
import { distanceKm } from './geo.js';
import { isVehicle } from './extract.js';

/** Pickles / Manheim charge a flat buyer's fee by price band: "1000:110,5000:275,15000:440,*:660" */
function tierFee(spec, price) {
  for (const part of String(spec || '').split(',')) {
    const [lim, fee] = part.split(':').map(s => s.trim());
    if (lim === '*' || price <= Number(lim)) return Number(fee) || 0;
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

/** All-in cost breakdown for a price (defaults to the lot's current bid / start price). */
export function allIn(lot, base, price = lot.bid ?? lot.start_price) {
  if (price == null) return null;
  const f = config.fees[lot.site] || {};
  const flat = f.tiers && isVehicle(lot);
  const pct = lot.buyer_premium ?? (flat ? 0 : f.premiumPct ?? f.goodsPct ?? 0);
  const premium = pct ? Math.round(price * pct / 100) : 0;
  const fee = flat && lot.buyer_premium == null ? tierFee(f.tiers, price) : 0;
  const gst = lot.gst_extra ? Math.round(price * 0.1) : 0;
  const tr = base ? transportCost(lot, base) : { cost: null };
  const fees = premium + fee + gst;
  return {
    price, premiumPct: pct || null, premium, fee, gst, fees,
    transport: tr.cost, km: tr.km ?? null, kmApprox: tr.approx, how: tr.how || null,
    total: price + fees + (tr.cost || 0),
    landed: price + fees, // what you pay the auction house
  };
}
