// Saved searches ("alert me about Renault Master, Sprinter, van under $8,000").
// Terms: commas (or "or") separate alternatives; words inside one alternative must all appear;
// "-word" excludes. Matching is on whole words in the title/category, plurals allowed.
import { q } from './db.js';
import { push } from './notify.js';
import { config } from './config.js';
import { log } from './log.js';

const money = n => (n == null ? '?' : '$' + Math.round(n).toLocaleString('en-AU'));
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "renault master, sprinter -crash, van" -> matcher function */
export function compile(terms) {
  const alts = String(terms || '').toLowerCase().split(/\s*(?:,|;|\||\bor\b)\s*/).map(s => s.trim()).filter(Boolean).map(alt => {
    const words = alt.split(/\s+/).filter(Boolean);
    const need = words.filter(w => !w.startsWith('-')).map(w => new RegExp(`(^|[^a-z0-9])${escRe(w)}(s|es)?($|[^a-z0-9])`, 'i'));
    const not = words.filter(w => w.startsWith('-') && w.length > 1).map(w => new RegExp(`(^|[^a-z0-9])${escRe(w.slice(1))}`, 'i'));
    return { need, not };
  }).filter(a => a.need.length);
  return text => {
    const t = String(text || '');
    return alts.some(a => a.need.every(r => r.test(t)) && !a.not.some(r => r.test(t)));
  };
}

const haystack = l => `${l.title || ''} ${l.category || ''}`.replace(/[-_/]/g, ' ');
const priceOf = l => l.bid ?? l.start_price;

export function matches(search, lot, test = compile(search.terms)) {
  if (search.site && lot.site !== search.site) return false;
  return test(haystack(lot));
}

/** Create a search. Lots already listed are recorded as matches without a push (no flood). */
export function addSearch(user, { terms, maxPrice, site }) {
  const clean = String(terms || '').trim().slice(0, 200);
  if (!/[a-z0-9]/i.test(clean.replace(/(^|\s)-\S+/g, ''))) throw new Error('Type what to look for, e.g. "renault master, sprinter".');
  const { id } = q.addSearch.get(user, clean, maxPrice ?? null, site || null, Date.now());
  const s = { id, user, terms: clean, max_price: maxPrice ?? null, site: site || null };
  const test = compile(clean);
  let n = 0;
  for (const l of q.openLots.all(Date.now())) if (matches(s, l, test)) { q.addHit.run(id, l.key, Date.now(), 1); n++; }
  return { id, matches: n };
}

/** After each scan: new matching lots -> one push per search (not one per lot). */
export async function runSearches(now = Date.now()) {
  const searches = q.allSearches.all();
  if (!searches.length) return 0;
  const lots = q.openLots.all(now);
  let total = 0;
  for (const s of searches) {
    const test = compile(s.terms);
    const fresh = [];
    for (const l of lots) {
      if (!matches(s, l, test)) continue;
      const r = q.addHit.run(s.id, l.key, now, 0);
      if (r.changes) fresh.push(l);
    }
    if (!fresh.length) continue;
    total += fresh.length;
    q.touchSearch.run(now, s.id);
    // Statutory write-offs never come up in pushes (they stay listed on the dashboard).
    const worth = fresh.filter(l => l.wovr !== 'Statutory Write-Off' || config.includeStatutory)
      .filter(l => s.max_price == null || priceOf(l) == null || priceOf(l) <= s.max_price)
      .sort((a, b) => (a.end_at ?? Infinity) - (b.end_at ?? Infinity));
    if (!worth.length) continue;
    const top = worth.slice(0, 4).map(l => `• ${l.title} — ${money(priceOf(l))}${l.state ? ' · ' + l.state : ''}`);
    await push({
      to: s.user, priority: 'default', tags: 'mag', url: worth.length === 1 ? worth[0].url : config.dashboardPublicUrl || undefined,
      title: `${worth.length} new match${worth.length === 1 ? '' : 'es'}: ${s.terms.slice(0, 40)}`,
      message: top.join('\n') + (worth.length > 4 ? `\n+${worth.length - 4} more on the dashboard` : ''),
    });
  }
  if (total) log.info('search', `${total} new lots matched saved searches`);
  return total;
}

/** Final minutes: a matching lot still at or under the search's max price. Needs a fresh price. */
export async function searchFinalAlert(lot, now = Date.now()) {
  const price = priceOf(lot);
  if (price == null || !lot.last_checked || now - lot.last_checked > 3 * 60000) return;
  for (const s of q.searchesForLot.all(lot.key)) {
    if (s.max_price == null || price > s.max_price) continue;
    if (q.userAlertSent.get(s.user, lot.key, 'search')) continue;
    if (lot.wovr === 'Statutory Write-Off' && !config.includeStatutory) continue;
    q.addUserAlert.run(s.user, lot.key, 'search', now);
    const mins = Math.max(1, Math.round((lot.end_at - now) / 60000));
    await push({ to: s.user, priority: 'urgent', tags: 'dart', url: lot.url,
      title: `MATCH: ${mins} min left · ${money(price)} (under your ${money(s.max_price)})`,
      message: `${lot.title}\nYour search: ${s.terms}\n${lot.site}${lot.state ? ' · ' + lot.state : ''}` });
  }
}
