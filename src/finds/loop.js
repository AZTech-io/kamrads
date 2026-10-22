import { config } from '../config.js';
import { log } from '../log.js';
import { db } from '../db.js';
import { findSources, sourceOn, fbAreaOf } from './sources.js';
import { fz, upsertItem } from './store.js';
import { queriesOf, runFindAlerts, placeOfItem } from './match.js';
import { locate, geocodeTexts } from '../geo.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let stopping = false, running = null;
export const stopFinds = () => { stopping = true; };

/** Every (site, phrase, area) the saved searches need, once each, and which searches each one serves. */
export function plan(searches) {
  const jobs = new Map();
  for (const s of searches) for (const site of String(s.sources || '').split(',').filter(Boolean)) {
    if (!findSources[site] || !sourceOn(site)) continue;
    for (const phrase of queriesOf(s.terms)) {
      const area = site === 'facebook' ? fbAreaOf(s) : null;
      const k = `${site}|${phrase.toLowerCase()}|${area || ''}`;
      if (!jobs.has(k)) jobs.set(k, { site, phrase, area, searches: new Set() });
      jobs.get(k).searches.add(s.id);
    }
  }
  return [...jobs.values()];
}

/** Read everything the saved searches need (or just one search's), then match and alert. */
export async function scanFinds({ only = null } = {}) {
  if (running) return running;
  running = (async () => {
    const searches = fz.searches.all().filter(s => only == null || s.id === only);
    const jobs = plan(searches);
    const failed = new Set(); // searches with a source that failed this time
    const per = {};
    for (const j of jobs) {
      if (stopping) break;
      try {
        const items = await findSources[j.site].search(j.phrase, { area: j.area });
        db.exec('BEGIN');
        try { for (const it of items) upsertItem(it); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
        per[j.site] = (per[j.site] || 0) + items.length;
        log.info('finds', `${j.site} "${j.phrase}"${j.area ? ` (${j.area})` : ''}: ${items.length} listings`);
      } catch (e) {
        for (const id of j.searches) failed.add(id);
        fz.statusErr.run(j.site, e.message.slice(0, 300), Date.now());
        log.warn('finds', `${j.site} "${j.phrase}": ${e.message}`);
      }
      await sleep(1500);
    }
    for (const [site, n] of Object.entries(per)) fz.statusOk.run(site, Date.now(), n);
    // a search counts as scanned once its sources have been read (even if one site failed, so it still starts alerting)
    for (const s of searches) fz.scanned.run(Date.now(), s.id);
    placeItems();
    fz.expire.run(Date.now() - config.finds.keepDays * 864e5);
    await runFindAlerts();
    const left = fz.unplaced.all().map(r => r.location);
    if (left.length) geocodeTexts(left, 30).then(placeItems).catch(() => {});
  })().finally(() => { running = null; });
  return running;
}

/** Pin listings to a place from their location text (known towns and earlier lookups). */
export function placeItems() {
  for (const r of fz.unplaced.all()) {
    const p = placeOfItem({ location: r.location });
    if (p && !p.approx) fz.setPlace.run(p.lat, p.lon, p.state, r.key);
  }
}

export async function findsLoop() {
  await sleep(60000);
  while (!stopping) {
    const t0 = Date.now();
    if (fz.searches.all().length) { try { await scanFinds(); } catch (e) { log.error('finds', e.stack || e.message); } }
    await sleep(Math.max(config.finds.everyMin * 60000 - (Date.now() - t0), 60000));
  }
}
