// Does a listing (or an auction lot) fit a saved search: the words, the price range and the distance.
import { compile } from '../searches.js';
import { haversineKm, locate, distanceKm } from '../geo.js';
import { fz } from './store.js';
import { push } from '../notify.js';
import { q } from '../db.js';
import { config } from '../config.js';
import { log } from '../log.js';

export const SOURCES = ['facebook', 'gumtree', 'ebay'];
export const SOURCE_NAMES = { facebook: 'Facebook', gumtree: 'Gumtree', ebay: 'eBay' };
const money = n => (n == null ? 'no price' : '$' + Math.round(n).toLocaleString('en-AU'));
const ROAD = 1.25; // straight line -> rough road distance

/** The search words to send to the sites: each alternative ("vending machine, snack machine"), without "-exclusions". */
export function queriesOf(terms) {
  return String(terms || '').split(/\s*(?:,|;|\||\bor\b)\s*/i)
    .map(a => a.split(/\s+/).filter(w => w && !w.startsWith('-')).join(' ').trim()).filter(Boolean).slice(0, 4);
}

const tests = new Map();
const testOf = s => { if (!tests.has(s.terms)) tests.set(s.terms, compile(s.terms)); return tests.get(s.terms); };

/** Where a listing is: its stored coordinates, or its location text looked up. */
export function placeOfItem(it) {
  if (it.lat != null && it.lon != null) return { lat: it.lat, lon: it.lon, state: it.state, approx: false };
  if (!it.location) return null;
  const p = locate(it.location);
  if (p && !p.approx) return p;
  // "Queanbeyan NSW 2620" / "Fyshwick, ACT": try again without the postcode / comma
  const bare = it.location.replace(/\s+\d{4}\s*$/, '').replace(/,\s*/g, ' ').trim();
  return (bare !== it.location ? locate(bare) : null) || p;
}

/**
 * { km, near } if the listing fits, else null. km: road-ish distance from the search's place (null if unknown).
 * A listing whose place can't be pinned down only fits when it's in the search's state (shown as "distance unknown").
 */
export function fitsSearch(s, it) {
  if (!testOf(s)(`${it.title || ''} ${it.description || ''}`)) return null;
  if (s.min_price != null && it.price != null && it.price < s.min_price) return null;
  if (s.max_price != null && it.price != null && it.price > s.max_price) return null;
  if (s.sources && !String(s.sources).split(',').includes(it.site)) return null;
  if (s.lat == null || !s.radius_km) return { km: null };
  const p = placeOfItem(it);
  if (!p || p.approx) return (it.state || p?.state) && (it.state || p?.state) === s.state ? { km: null } : null;
  const km = Math.round(haversineKm([s.lat, s.lon], [p.lat, p.lon]) * ROAD);
  return km <= s.radius_km ? { km } : null;
}

/** Auction lots that match a search (any distance; nearest first), with how far they are from the search's place. */
export function auctionMatches(s, now = Date.now()) {
  const test = testOf(s);
  const base = s.lat != null ? { name: s.place, lat: s.lat, lon: s.lon } : null;
  return q.openWindow.all(now - 60000, now + 30 * 864e5).concat(q.noEndOpen ? q.noEndOpen.all() : [])
    .filter(l => test(`${l.title || ''} ${l.category || ''}`.replace(/[-_/]/g, ' ')))
    .filter(l => s.max_price == null || (l.bid ?? l.start_price ?? 0) <= s.max_price)
    .map(l => ({ l, km: base ? distanceKm(l, base)?.km ?? null : null }))
    .sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9) || (a.l.end_at ?? 9e15) - (b.l.end_at ?? 9e15));
}

/** After each scan: record new matches, one push per search for the ones that are new since the search was made. */
export async function runFindAlerts(now = Date.now()) {
  const searches = fz.searches.all();
  if (!searches.length) return 0;
  const items = fz.open.all();
  let total = 0;
  for (const s of searches) {
    const fresh = [];
    for (const it of items) {
      const f = fitsSearch(s, it);
      if (!f) continue;
      // Quiet: alerts off; listed before the search was made; found by the search's first scan (what's already
      // out there); or posted days ago (just newly seen by us)
      const quiet = !s.alerts || !s.primed || it.first_seen < s.created_at || (it.posted_at != null && it.posted_at < now - 3 * 864e5);
      if (fz.addHit.run(s.id, it.key, now, quiet ? 1 : 0).changes && !quiet) fresh.push({ it, f });
    }
    if (!s.primed && s.scanned_at) fz.primed.run(s.id);
    if (!fresh.length) continue;
    total += fresh.length;
    fresh.sort((a, b) => (a.f.km ?? 1e9) - (b.f.km ?? 1e9));
    const lines = fresh.slice(0, 4).map(({ it, f }) => `• ${it.title} — ${money(it.price)} · ${it.location || '?'}${f.km != null ? ` (${f.km} km)` : ''} · ${SOURCE_NAMES[it.site]}`);
    await push({
      to: s.user, priority: 'high', tags: 'mag', url: fresh.length === 1 ? fresh[0].it.url : (config.dashboardPublicUrl ? config.dashboardPublicUrl + '/finds' : undefined),
      title: `${fresh.length} new: ${s.name || s.terms}`.slice(0, 120),
      message: lines.join('\n') + (fresh.length > 4 ? `\n+${fresh.length - 4} more in Finds` : ''),
    });
  }
  if (total) log.info('finds', `${total} new listings matched saved searches`);
  return total;
}
