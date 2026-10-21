import { config } from './config.js';
import { q } from './db.js';
import { push } from './notify.js';
import { isVehicle } from './extract.js';
import { finalMinutes } from './users.js';
import { historyEstimate, typeEstimate } from './history.js';
import { allIn } from './costs.js';
import { sectorOf } from './categories.js';
import { isLiveSale } from './live.js';

const FRESH_MS = 3 * 60000;
const money = n => (n == null ? '?' : '$' + Math.round(n).toLocaleString('en-AU'));

/** The estimate the alert rules use: yours, then the AI's low resale figure, then what similar lots sold for here. */
export const estimateOf = lot => lot.manual_estimate ?? lot.est_low ?? historyEstimate(lot) ?? typeEstimate(lot) ?? null;
/** Where an estimate came from, for the dashboard. 'type' = rough, from sold vehicles of the same type. */
export const estimateSource = lot => (lot.manual_estimate != null ? 'yours' : lot.est_low != null ? 'research' : historyEstimate(lot) != null ? 'history' : typeEstimate(lot) != null ? 'type' : null);

/** Which alert (if any) this lot deserves right now. Pure function: easy to test. */
export function classify(lot, now = Date.now()) {
  if (lot.status !== 'open' || !lot.end_at) return null;
  if (isLiveSale(lot)) return null; // sold in a live lane: there's no real "10 minutes to go"
  const minsLeft = (lot.end_at - now) / 60000;
  if (minsLeft <= 0 || minsLeft > config.alertMinutes) return null;
  const statutory = lot.wovr === 'Statutory Write-Off';
  // Only alert on a price we've just read from the lot's own page, never on stale listing data.
  if (!lot.last_checked || now - lot.last_checked > FRESH_MS) return null;
  if (lot.starred) return { kind: 'watched', why: 'starred lot in its final minutes' };
  if (lot.bid == null && lot.start_price == null) return null;
  const price = lot.bid ?? lot.start_price;
  if (statutory && !config.includeStatutory) return null;
  const est = estimateOf(lot);
  // Judge deals on what you'd pay the auction house (bid + buyer's premium / fees), not the bid alone.
  const paid = allIn(lot, null, price)?.landed ?? price;
  if (est && paid <= est * config.sleeperRatio) {
    return { kind: 'sleeper', why: `${Math.round((paid / est) * 100)}% of est ${money(est)}${paid > price ? ` (incl. ${money(paid - price)} fees)` : ''}` };
  }
  if (!est && isVehicle(lot) && price <= config.cheapVehicleMax) {
    return { kind: 'cheap', why: `vehicle still under ${money(config.cheapVehicleMax)}` };
  }
  // Penny lots: only in the sectors that matter (paint and household bits don't buzz your phone).
  if (price <= config.pennyMax && (config.pennyGeneral || sectorOf(lot) !== 'general')) return { kind: 'penny', why: `only ${money(price)}` };
  return null;
}

export async function checkAlerts(lot, now = Date.now()) {
  let hit = classify(lot, now);
  // Watched lots: a personal final-minutes push to each person watching (with their winning/outbid
  // status), then still judged as a deal for everyone else.
  if (hit?.kind === 'watched') {
    if (!q.alertSent.get(lot.key, 'watched')) q.addAlert.run(lot.key, 'watched', now, `WATCHED — ${lot.title}`);
    await finalMinutes(lot, now);
    hit = classify({ ...lot, starred: 0 }, now);
  }
  if (!hit || q.alertSent.get(lot.key, hit.kind)) return null;
  const mins = Math.max(1, Math.round((lot.end_at - now) / 60000));
  const where = [lot.location, lot.state].filter(Boolean).join(' ');
  const label = { sleeper: 'SLEEPER', cheap: 'CHEAP', penny: 'PENNY LOT', watched: 'WATCHED' }[hit.kind];
  const title = `${label}: ${mins} min left · ${money(lot.bid ?? lot.start_price)}`;
  const message = [lot.title, `${lot.site}${where ? ' · ' + where : ''}`, lot.odometer ? `${lot.odometer.toLocaleString('en-AU')} km` : null,
    lot.wovr, hit.why].filter(Boolean).join('\n');
  q.addAlert.run(lot.key, hit.kind, now, `${title} — ${lot.title}`);
  await push({ title, message, url: lot.url, priority: hit.kind === 'sleeper' ? 'urgent' : 'high' });
  return hit;
}
