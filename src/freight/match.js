// Matching jobs to where you are and where you're going.
//  - area:  pickup or drop-off within R km of a place ("anything in Canberra")
//  - route: A -> B with up to D km of detour, optionally both ways ("Canberra <-> Sydney day trip").
//    A job p -> d fits when  A->p + p->d + d->B  is at most D km longer than A->B.
import { haversineKm, locate } from '../geo.js';
import { fq } from './store.js';
import { push } from '../notify.js';
import { config } from '../config.js';
import { log } from '../log.js';

const ROAD = 1.25; // straight line -> rough road km
const km = (a, b) => haversineKm([a.lat, a.lon], [b.lat, b.lon]) * ROAD;
const money = n => (n == null ? '?' : '$' + Math.round(n).toLocaleString('en-AU'));

/** Where a job starts and ends (only places we really know - a state-capital guess would mislead). */
export function ends(job) {
  const f = locate(job.from_text), t = locate(job.to_text);
  return { from: f && !f.approx ? f : null, to: t && !t.approx ? t : null, fromApprox: f?.approx ?? null, toApprox: t?.approx ?? null };
}

/** How a job fits one alert / route, or null. */
export function fit(job, a, e = ends(job)) {
  if (a.min_price != null && (job.price == null || job.price < a.min_price)) return null;
  const A = a.a_lat != null ? { lat: a.a_lat, lon: a.a_lon } : null;
  const B = a.b_lat != null ? { lat: a.b_lat, lon: a.b_lon } : null;
  if (!A || !e.from) return null;
  if (a.kind === 'area') {
    const r = a.radius_km ?? 50;
    const df = km(A, e.from), dt = e.to ? km(A, e.to) : Infinity;
    if (df <= r) return { how: e.to && dt <= r ? 'local' : 'pickup', km: Math.round(df) };
    if (dt <= r) return { how: 'dropoff', km: Math.round(dt) };
    return null;
  }
  if (!B) return null;
  const D = a.radius_km ?? 30;
  const try1 = (X, Y, dir) => {
    if (!e.to) { // one-place job: near either end of the trip counts
      const d = Math.min(km(X, e.from), km(Y, e.from));
      return d <= D ? { how: dir, extra: Math.round(d * 2), km: null } : null;
    }
    const trip = km(X, Y), leg = km(e.from, e.to);
    // It has to carry the load a real part of the way: a 6 km job across town is local work, not a run.
    if (leg < Math.min(60, trip * 0.25)) return null;
    const extra = km(X, e.from) + leg + km(e.to, Y) - trip;
    return extra <= D ? { how: dir, extra: Math.max(0, Math.round(extra)), km: Math.round(leg) } : null;
  };
  return try1(A, B, 'out') || (a.both_ways ? try1(B, A, 'back') : null);
}

const describe = a => (a.kind === 'area' ? `within ${a.radius_km} km of ${a.a_text}` : `${a.a_text} ${a.both_ways ? '⇄' : '→'} ${a.b_text} (≤${a.radius_km} km detour)`);
export { describe };

/** After each scan: record matches; push new ones (one push per alert per scan). */
export async function runFreightAlerts(now = Date.now()) {
  const alerts = fq.allAlerts.all();
  if (!alerts.length) return 0;
  const jobs = fq.live.all(now - config.freight.keepHours * 3600000).map(j => ({ j, e: ends(j) }));
  let total = 0;
  for (const a of alerts) {
    const fresh = [];
    for (const { j, e } of jobs) {
      const f = fit(j, a, e);
      if (!f) continue;
      // jobs that were already listed when the alert was made are recorded quietly
      const quiet = j.first_seen < a.created_at;
      if (fq.addHit.run(a.id, j.key, now, quiet ? 1 : 0).changes && !quiet) fresh.push({ j, f });
    }
    if (!fresh.length) continue;
    total += fresh.length;
    fresh.sort((x, y) => (y.j.price ?? 0) - (x.j.price ?? 0));
    const lines = fresh.slice(0, 4).map(({ j, f }) => `• ${j.title} — ${money(j.price)} · ${j.from_text}${j.to_text ? ' → ' + j.to_text : ''}${f.how === 'back' ? ' (return leg)' : ''}`);
    await push({
      to: a.user, priority: 'high', tags: 'truck', url: fresh.length === 1 ? fresh[0].j.url : (config.dashboardPublicUrl ? config.dashboardPublicUrl + '/freight' : undefined),
      title: `${fresh.length} new freight job${fresh.length === 1 ? '' : 's'}: ${a.name || describe(a)}`.slice(0, 120),
      message: lines.join('\n') + (fresh.length > 4 ? `\n+${fresh.length - 4} more on the freight board` : ''),
    });
  }
  if (total) log.info('freight', `${total} new jobs matched saved routes`);
  return total;
}
