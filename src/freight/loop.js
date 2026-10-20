import { config } from '../config.js';
import { log } from '../log.js';
import { freightSites } from './sites.js';
import { upsertJob, fq } from './store.js';
import { geocodeTexts } from '../geo.js';
import { runFreightAlerts } from './match.js';
import { db } from '../db.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let stopping = false;
export const stopFreight = () => { stopping = true; };

export async function scanFreight() {
  for (const s of Object.values(freightSites)) {
    if (!config.freight[s.site]?.enabled) continue;
    const t0 = Date.now();
    try {
      const jobs = await s.discover();
      db.exec('BEGIN');
      try { for (const j of jobs) upsertJob(j); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      fq.statusOk.run(s.site, Date.now(), jobs.filter(j => j.status === 'open').length);
      log.info(s.site, `scan done: ${jobs.length} jobs (${jobs.filter(j => j.from_text).length} with a place) in ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) {
      fq.statusErr.run(s.site, e.message.slice(0, 300), Date.now());
      log.error(s.site, `scan failed: ${e.message}`);
    }
  }
  fq.expire.run(Date.now() - config.freight.keepHours * 3600000);
  // Know where every job is before matching (route matches need real places, not guesses)
  const live = fq.live.all(Date.now() - config.freight.keepHours * 3600000);
  await geocodeTexts(live.flatMap(j => [j.from_text, j.to_text]).filter(Boolean), 80);
  await runFreightAlerts();
}

export async function freightLoop() {
  if (!Object.values(freightSites).some(s => config.freight[s.site]?.enabled)) return;
  await sleep(20000); // let the auction scans get going first
  while (!stopping) {
    const t0 = Date.now();
    try { await scanFreight(); } catch (e) { log.error('freight', e.stack || e.message); }
    await sleep(Math.max(config.freight.everyMin * 60000 - (Date.now() - t0), 60000));
  }
}
