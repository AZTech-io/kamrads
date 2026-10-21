import { config } from '../config.js';
import { log } from '../log.js';
import { freightSites } from './sites.js';
import { upsertJob, fq } from './store.js';
import { geocodeTexts } from '../geo.js';
import { runFreightAlerts } from './match.js';
import { fitIdTime } from './heat.js';
import { db } from '../db.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let stopping = false;
export const stopFreight = () => { stopping = true; };

/** Boards we read in full overnight: their old jobs stay until a full read no longer finds them. */
const swept = s => config.freight.sweep.enabled && typeof s.sweep === 'function';

function save(site, jobs, { watching = false } = {}) {
  const now = Date.now();
  db.exec('BEGIN');
  try {
    // a load that just appeared on the first page of a board we were already watching was posted about now
    for (const j of jobs) upsertJob(j, now, { fresh: watching && j._page === 1 });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

const wasWatching = site => {
  const st = fq.statusAll.all().find(x => x.site === site);
  return !!st?.last_ok && Date.now() - st.last_ok < (config.freight.everyMin * 2 + 5) * 60000;
};

export async function scanFreight() {
  for (const s of Object.values(freightSites)) {
    if (!config.freight[s.site]?.enabled) continue;
    const t0 = Date.now();
    try {
      const watching = wasWatching(s.site);
      const jobs = await s.discover();
      save(s.site, jobs, { watching });
      fq.statusOk.run(s.site, Date.now(), jobs.filter(j => j.status === 'open').length);
      log.info(s.site, `scan done: ${jobs.length} jobs (${jobs.filter(j => j.from_text).length} with a place) in ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) {
      fq.statusErr.run(s.site, e.message.slice(0, 300), Date.now());
      log.error(s.site, `scan failed: ${e.message}`);
    }
  }
  expireJobs();
  datePosts();
  // Know where every job is before matching (route matches need real places, not guesses)
  const live = fq.live.all(Date.now() - config.freight.keepHours * 3600000);
  await geocodeTexts(live.flatMap(j => [j.from_text, j.to_text]).filter(Boolean), 80);
  await runFreightAlerts();
}

/** Airtasker (only its newest jobs can be read): gone once off the lists for keepHours.
 *  Swept boards: gone when a full read misses them, or after keepDays unseen if sweeps keep failing. */
export function expireJobs(now = Date.now()) {
  for (const s of Object.values(freightSites)) {
    const hours = swept(s) ? config.freight.sweep.keepDays * 24 : config.freight.keepHours;
    fq.expireSite.run(s.site, now - hours * 3600000);
  }
}

/** Date Loadshift loads (no post date shown) from the ones we watched appear. */
export function datePosts(now = Date.now()) {
  const pts = fq.anchors.all('loadshift', now - 60 * 864e5).map(r => ({ id: Number(r.ext_id), t: r.posted_at }));
  const line = fitIdTime(pts);
  if (!line) return 0;
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const r of fq.undated.all('loadshift')) {
      const id = Number(r.ext_id);
      if (!Number.isFinite(id)) continue;
      // never later than we first saw it, never in the future
      const t = Math.round(Math.min(line.at(id), r.first_seen ?? now, now));
      fq.setEst.run(t, r.key); n++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return n;
}

const localHour = (t = Date.now()) => Number(new Intl.DateTimeFormat('en-AU', { hour: 'numeric', hourCycle: 'h23', timeZone: config.digestTz }).format(t));

/** Once a day, from the sweep hour (and straight away the first time): read Truckit and Loadshift in full. */
export function sweepDue(site, now = Date.now()) {
  const st = fq.statusAll.all().find(x => x.site === site);
  if (!st?.last_sweep) return true;
  if (now - st.last_sweep < 20 * 3600000) return false;
  const h = localHour(now);
  return h >= config.freight.sweep.hour && h < config.freight.sweep.hour + 4;
}

let sweeping = false;
export async function sweepFreight({ force = false } = {}) {
  if (sweeping) return;
  sweeping = true;
  try { await sweepAll(force); } finally { sweeping = false; }
}
async function sweepAll(force) {
  for (const s of Object.values(freightSites)) {
    if (!config.freight[s.site]?.enabled || !swept(s) || stopping) continue;
    if (!force && !sweepDue(s.site)) continue;
    const t0 = Date.now();
    log.info(s.site, 'full read of the board starting (old jobs that are still listed)');
    try {
      const { jobs, complete, listed } = await s.sweep();
      save(s.site, jobs);
      let gone = 0;
      if (complete && jobs.length) gone = fq.expireSite.run(s.site, t0).changes;   // listed before, not now: taken
      fq.sweepOk.run(s.site, Date.now(), jobs.length, complete ? 1 : 0, listed);
      fq.statusOk.run(s.site, Date.now(), jobs.length);
      log.info(s.site, `full read done: ${jobs.length} jobs${listed ? ` of ${listed} listed` : ''}, ${complete ? `${gone} no longer listed` : 'incomplete (nothing marked gone)'} in ${Math.round((Date.now() - t0) / 60000)} min`);
    } catch (e) {
      fq.sweepOk.run(s.site, Date.now(), 0, 0, null);   // try again tomorrow, not every scan
      fq.statusErr.run(s.site, `full read: ${e.message}`.slice(0, 300), Date.now());
      log.error(s.site, `full read failed: ${e.message}`);
    }
  }
  datePosts();
}

export async function freightLoop() {
  if (!Object.values(freightSites).some(s => config.freight[s.site]?.enabled)) return;
  await sleep(20000); // let the auction scans get going first
  while (!stopping) {
    const t0 = Date.now();
    try { await scanFreight(); } catch (e) { log.error('freight', e.stack || e.message); }
    try { await sweepFreight(); } catch (e) { log.error('freight', e.stack || e.message); }
    await sleep(Math.max(config.freight.everyMin * 60000 - (Date.now() - t0), 60000));
  }
}
