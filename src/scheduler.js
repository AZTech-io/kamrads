import { config } from './config.js';
import { db, q, upsertLot } from './db.js';
import { log } from './log.js';
import { checkAlerts } from './alerts.js';
import { estimatePending } from './estimate.js';
import { ensureLogin } from './login.js';
import * as pickles from './sites/pickles.js';
import * as manheim from './sites/manheim.js';
import * as allbids from './sites/allbids.js';

export const adapters = { pickles, manheim, allbids };
const enabled = () => Object.values(adapters).filter(a => config.sites[a.site]?.enabled);

const FINAL_GRACE_MS = 6 * 60000; // soft-close extensions + one final read before we mark a lot closed
const LIVE_FIELDS = ['bid', 'bid_count', 'end_at', 'buy_now', 'start_price', 'buy_method'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let stopping = false;
export const stop = () => { stopping = true; };

async function discoverSite(a) {
  const t0 = Date.now();
  try {
    const lots = await a.discover();
    db.exec('BEGIN');
    try { for (const l of lots) upsertLot({ ...l, site: a.site }); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    q.statusOk.run(a.site, Date.now(), lots.length);
    const withBid = lots.filter(l => l.bid != null).length, withEnd = lots.filter(l => l.end_at).length;
    log.info(a.site, `discovery done: ${lots.length} lots (${withBid} with bid, ${withEnd} with close time) in ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (e) {
    q.statusErr.run(a.site, e.message.slice(0, 300), Date.now());
    log.error(a.site, `discovery failed: ${e.message}`);
  }
}

async function discoveryLoop() {
  while (!stopping) {
    const start = Date.now();
    for (const a of enabled()) { if (stopping) break; await discoverSite(a); }
    const wait = config.discoveryEveryMin * 60000 - (Date.now() - start);
    await sleep(Math.max(wait, 30000));
  }
}

/** Pick the lots that need a fresh look: closing within the hot/warm windows. */
export function dueForRefresh(now = Date.now()) {
  const rows = q.openWindow.all(now - FINAL_GRACE_MS, now + config.warmWindowMin * 60000);
  const due = rows.filter(l => {
    if (!adapters[l.site] || !config.sites[l.site]?.enabled || !l.url) return false;
    if (!l.starred && l.bid != null && l.bid > config.hotMaxBid) return false;
    const mins = (l.end_at - now) / 60000;
    const since = now - (l.last_checked || 0);
    // Past its close: one last read to capture the final price (sites hide it once sold).
    if (mins <= 0) return (l.last_checked || 0) < l.end_at;
    if (mins <= config.hotWindowMin) return since >= config.hotEverySec * 900;
    return since >= config.warmEveryMin * 60000;
  });
  // Final reads first (they can't wait), then whatever closes soonest.
  due.sort((a, b) => ((a.end_at <= now) === (b.end_at <= now) ? a.end_at - b.end_at : a.end_at <= now ? -1 : 1));
  return due.slice(0, config.hotBatch);
}

async function hotCycle() {
  const now = Date.now();
  const closed = q.closeDue.all(now, now - FINAL_GRACE_MS);
  if (closed.length) log.info('hot', `${closed.length} lots closed`);
  const due = dueForRefresh(now);
  await Promise.all(due.map(async lot => {
    try {
      const fresh = await adapters[lot.site].refresh(lot);
      // Detail pages often carry worse titles ("CP: 01/2014,Hino,...") - only take live fields,
      // and descriptive ones only where we had nothing.
      const update = { site: lot.site, ext_id: lot.ext_id };
      for (const k of LIVE_FIELDS) if (fresh[k] != null) update[k] = fresh[k];
      for (const [k, v] of Object.entries(fresh)) if (!(k in update) && lot[k] == null && v != null) update[k] = v;
      upsertLot(update, { checked: true });
      const row = q.lot.get(lot.key);
      const mins = row.end_at ? Math.round((row.end_at - Date.now()) / 60000) : '?';
      log.info('hot', `${lot.key} ${row.title?.slice(0, 40)} · bid ${row.bid ?? '-'} · ${mins} min left`);
    } catch (e) {
      upsertLot({ site: lot.site, ext_id: lot.ext_id }, { checked: true }); // don't hammer a failing page
      log.warn('hot', `${lot.key}: ${e.message}`);
    }
  }));
  // Alerts run on everything in the alert window, refreshed or not.
  for (const lot of q.openWindow.all(Date.now(), Date.now() + config.alertMinutes * 60000)) await checkAlerts(lot);
}

async function hotLoop() {
  while (!stopping) {
    const t0 = Date.now();
    try { await hotCycle(); } catch (e) { log.error('hot', e.stack || e.message); }
    await sleep(Math.max(config.hotEverySec * 1000 - (Date.now() - t0), 5000));
  }
}

async function estimateLoop() {
  while (!stopping) {
    try { await estimatePending(); } catch (e) { log.warn('estimate', e.message); }
    await sleep(120000);
  }
}

export async function startScheduler() {
  for (const a of enabled()) if (a.loginUrl) await ensureLogin(a.site, a.loginUrl).catch(e => log.warn(a.site, e.message));
  discoveryLoop();
  hotLoop();
  estimateLoop();
}
