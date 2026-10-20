import { config } from './config.js';
import { q } from './db.js';
import { push } from './notify.js';
import { isVehicle } from './extract.js';

const FRESH_MS = 3 * 60000;
const money = n => (n == null ? '?' : '$' + Math.round(n).toLocaleString('en-AU'));

/** The estimate the alert rules use: a manual one beats the AI's low figure. */
export const estimateOf = lot => lot.manual_estimate ?? lot.est_low ?? null;

/** Which alert (if any) this lot deserves right now. Pure function: easy to test. */
export function classify(lot, now = Date.now()) {
  if (lot.status !== 'open' || !lot.end_at) return null;
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
  if (est && price <= est * config.sleeperRatio) {
    return { kind: 'sleeper', why: `${Math.round((price / est) * 100)}% of est ${money(est)}` };
  }
  if (!est && isVehicle(lot) && price <= config.cheapVehicleMax) {
    return { kind: 'cheap', why: `vehicle still under ${money(config.cheapVehicleMax)}` };
  }
  if (price <= config.pennyMax) return { kind: 'penny', why: `only ${money(price)}` };
  return null;
}

export async function checkAlerts(lot, now = Date.now()) {
  const hit = classify(lot, now);
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
