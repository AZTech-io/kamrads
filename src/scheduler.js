import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db, q, upsertLot } from './db.js';
import { log } from './log.js';
import { checkAlerts } from './alerts.js';
import { estimatePending } from './estimate.js';
import { ensureLogin } from './login.js';
import { hasFeed } from './fast.js';
import * as pickles from './sites/pickles.js';
import * as manheim from './sites/manheim.js';
import * as allbids from './sites/allbids.js';
import * as lloyds from './sites/lloyds.js';
import { grays, slattery, auctionbarn } from './sites/extra.js';
import { checkBidders, announceResult } from './users.js';
import { runSearches, searchFinalAlert } from './searches.js';
import { geocodePending } from './geo.js';
import { digestTick } from './digest.js';
import { checkPending } from './inspect.js';
import { prunePhotos } from './photos.js';
import { freightLoop } from './freight/loop.js';
import { pushLoop } from './freight/push.js';
import { isPaused, pause, ok as pauseOk, isRateLimit } from './pause.js';
import { sectorOf } from './categories.js';

export const adapters = { pickles, manheim, allbids, lloyds, grays, slattery, auctionbarn };
// Sites where a re-read is cheap (learned JSON feed, or plain-HTML lot pages)
const quick = site => hasFeed(site) || !!adapters[site]?.cheapRefresh;
const enabled = () => Object.values(adapters).filter(a => config.sites[a.site]?.enabled);

const FINAL_GRACE_MS = 6 * 60000; // soft-close extensions + one final read before we mark a lot closed
const LIVE_FIELDS = ['bid', 'bid_count', 'end_at', 'buy_now', 'start_price', 'buy_method', 'reserve', 'opens_at'];
const REFRESH_TIMEOUT_MS = 75000;
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

/** Run fn over items with at most n at a time (page reads still queue for their browser tab). */
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let stopping = false;
export const stop = () => { stopping = true; };

async function discoverSite(a) {
  const t0 = Date.now();
  if (isPaused(a.site)) return;
  try {
    const lots = await a.discover();
    db.exec('BEGIN');
    try { for (const l of lots) upsertLot({ ...l, site: a.site }); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    q.statusOk.run(a.site, Date.now(), lots.length);
    const withBid = lots.filter(l => l.bid != null).length, withEnd = lots.filter(l => l.end_at).length;
    log.info(a.site, `discovery done: ${lots.length} lots (${withBid} with bid, ${withEnd} with close time) in ${Math.round((Date.now() - t0) / 1000)}s`);
    // Sites whose lists don't show close times (Grays): read some lot pages each pass to fill them in.
    if (a.timesFromLotPage) await fillTimes(a);
    await runSearches().catch(e => log.warn('search', e.message));
  } catch (e) {
    q.statusErr.run(a.site, e.message.slice(0, 300), Date.now());
    log.error(a.site, `discovery failed: ${e.message}`);
    if (isRateLimit(e.message)) pause(a.site, e.message.slice(0, 60));
  }
}

async function fillTimes(a) {
  const now = Date.now();
  const seen = new Set();
  const todo = [...q.missingTimes.all(a.site, config.fillTimesPerScan),
    ...q.missingPlace.all(a.site, now, now + 3 * 864e5, now - 12 * 3600000, Math.ceil(config.fillTimesPerScan / 2))].filter(l => !seen.has(l.key) && seen.add(l.key));
  let got = 0;
  for (const lot of todo) {
    if (stopping || isPaused(a.site)) break;
    try {
      const fresh = await withTimeout(a.refresh(lot), REFRESH_TIMEOUT_MS, 'took too long');
      const update = { site: lot.site, ext_id: lot.ext_id };
      for (const [k, v] of Object.entries(fresh)) if (v != null && (LIVE_FIELDS.includes(k) || lot[k] == null)) update[k] = v;
      upsertLot(update, { checked: true });
      if (fresh.end_at) got++;
    } catch (e) {
      if (isRateLimit(e.message)) { pause(a.site, e.message.slice(0, 60)); break; }
      upsertLot({ site: lot.site, ext_id: lot.ext_id }, { checked: true });
      log.warn(a.site, `${lot.key}: ${e.message}`);
    }
  }
  if (todo.length) log.info(a.site, `close times read for ${got} of ${todo.length} lots`);
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
  const usable = l => adapters[l.site] && config.sites[l.site]?.enabled && l.url && !isPaused(l.site, now);
  // Your watchlist: every WATCH_EVERY_SEC (faster in the final minutes), whatever the price or close time.
  const watched = q.watchedOpen.all().filter(l => usable(l) && (l.end_at == null || l.end_at > now - FINAL_GRACE_MS)).filter(l => {
    const since = now - (l.last_checked || 0);
    if (l.end_at && l.end_at <= now) return (l.last_checked || 0) < l.end_at;
    const left = l.end_at ? l.end_at - now : Infinity;
    const every = left <= config.finalWindowMin * 60000 ? config.finalEverySec
      : left <= config.hotWindowMin * 60000 ? Math.min(config.hotEverySec, config.watchEverySec) : config.watchEverySec;
    return since >= every * 900;
  });
  const rows = q.openWindow.all(now - FINAL_GRACE_MS, now + config.warmWindowMin * 60000).filter(l => !l.starred);
  const due = rows.filter(l => {
    if (!usable(l)) return false;
    // Expensive lots aren't worth a slow page read; with a fast feed they're cheap, so keep them (final prices).
    if (!quick(l.site) && !l.starred && l.bid != null && l.bid > config.hotMaxBid) return false;
    const mins = (l.end_at - now) / 60000;
    const since = now - (l.last_checked || 0);
    // Past its close: one last read to capture the final price (sites hide it once sold).
    if (mins <= 0) return (l.last_checked || 0) < l.end_at;
    // Final minutes: as often as the loop runs (every FINAL_EVERY_SEC) so the stored price is as close to the hammer as we can get.
    if (mins <= config.finalWindowMin && quick(l.site)) return since >= config.finalEverySec * 800;
    if (mins <= config.hotWindowMin) return since >= config.hotEverySec * 900;
    return since >= config.warmEveryMin * 60000;
  });
  // Final reads first (they can't wait), then whatever closes soonest; general goods (wine, paint, toys)
  // after vehicles and equipment, so when a site's cap bites it's the junk that waits.
  const goods = l => (sectorOf(l) === 'general' ? 1 : 0);
  due.sort((a, b) => goods(a) - goods(b) || ((a.end_at <= now) === (b.end_at <= now) ? a.end_at - b.end_at : a.end_at <= now ? -1 : 1));
  // Sites with a fast price feed can take many reads a cycle (up to SITE_PER_CYCLE each); full page reads are limited to HOT_BATCH.
  const perSite = {};
  const capOk = l => { const cap = config.perCycle[l.site] ?? config.fastBatch; perSite[l.site] = (perSite[l.site] || 0) + 1; return perSite[l.site] <= cap; };
  for (const l of watched) perSite[l.site] = (perSite[l.site] || 0) + 1;   // the watchlist uses the same allowance
  const fast = due.filter(l => quick(l.site)).filter(capOk).slice(0, config.fastBatch);
  const paged = due.filter(l => !quick(l.site)).slice(0, config.hotBatch);
  // Lots closing later today/tomorrow: a light check every few hours, so a lot sold early (or with a
  // changed close time) doesn't sit on the board as "ending in 6 hours".
  const seen = new Set([...watched, ...fast, ...paged].map(l => l.key));
  const day = q.dayWindow.all(now + config.warmWindowMin * 60000, now + config.dayWindowHours * 3600000, now - config.dayEveryHours * 3600000, config.fastBatch)
    .filter(l => usable(l) && !seen.has(l.key));
  const dayFast = day.filter(l => quick(l.site)).filter(capOk).slice(0, Math.max(0, config.fastBatch - fast.length));
  const dayPaged = day.filter(l => !quick(l.site)).slice(0, paged.length < config.hotBatch ? 1 : 0);
  // Watchlist always goes first and doesn't count against the limits.
  return [...watched, ...fast, ...paged, ...dayFast, ...dayPaged];
}

async function hotCycle() {
  const now = Date.now();
  const closed = q.closeDue.all(now, now - FINAL_GRACE_MS);
  if (closed.length) log.info('hot', `${closed.length} lots closed`);
  for (const { key } of closed) { const l = q.lot.get(key); if (l?.starred) await announceResult(l).catch(e => log.warn('alert', e.message)); }
  const due = dueForRefresh(now);
  let viaFeed = 0;
  await pool(due, 6, async lot => {
    if (isPaused(lot.site)) return;   // a 429 earlier in this cycle: leave the rest of that site alone
    try {
      const fresh = await withTimeout(adapters[lot.site].refresh(lot), REFRESH_TIMEOUT_MS, 're-check took too long');
      pauseOk(lot.site);
      // Detail pages often carry worse titles ("CP: 01/2014,Hino,...") - only take live fields,
      // and descriptive ones only where we had nothing.
      const update = { site: lot.site, ext_id: lot.ext_id };
      for (const k of LIVE_FIELDS) if (fresh[k] != null) update[k] = fresh[k];
      for (const [k, v] of Object.entries(fresh)) if (!(k in update) && lot[k] == null && v != null) update[k] = v;
      upsertLot(update, { checked: true });
      if (fresh.gone) {
        // The lot page says it's gone (sold early / withdrawn): close it with the last price seen before that.
        q.closeEarly.run(lot.last_checked ?? null, Date.now(), Date.now(), Date.now(), lot.key);
        log.info('hot', `${lot.key} ${lot.title?.slice(0, 40)} ended before its listed close (last seen $${lot.bid ?? '?'})`);
        const row = q.lot.get(lot.key);
        if (row?.starred) await announceResult(row).catch(e => log.warn('alert', e.message));
        return;
      }
      if (lot.starred) await checkBidders(q.lot.get(lot.key)).catch(e => log.warn('alert', e.message));
      if (fresh.fast) { viaFeed++; return; } // fast reads are too frequent to log one by one
      const row = q.lot.get(lot.key);
      const mins = row.end_at ? Math.round((row.end_at - Date.now()) / 60000) : '?';
      log.info('hot', `${lot.key} ${row.title?.slice(0, 40)} · bid ${row.bid ?? '-'} · ${mins} min left`);
    } catch (e) {
      if (isRateLimit(e.message)) { pause(lot.site, e.message.slice(0, 60)); return; }   // the lot wasn't read: try it once the pause is over
      upsertLot({ site: lot.site, ext_id: lot.ext_id }, { checked: true }); // don't hammer a failing page
      log.warn('hot', `${lot.key}: ${e.message}`);
    }
  });
  if (viaFeed) log.info('hot', `${viaFeed} lots re-read via fast price feed`);
  const took = Math.round((Date.now() - now) / 1000);
  if (took > 90) log.warn('hot', `re-check cycle took ${took}s for ${due.length} lots - watchlist may be falling behind`);
  // Alerts run on everything in the alert window, refreshed or not.
  for (const lot of q.openWindow.all(Date.now(), Date.now() + config.alertMinutes * 60000)) {
    await checkAlerts(lot);
    await searchFinalAlert(lot).catch(e => log.warn('search', e.message));
  }
}

async function hotLoop() {
  while (!stopping) {
    const t0 = Date.now();
    try { await hotCycle(); } catch (e) { log.error('hot', e.stack || e.message); }
    // Speed up while anything we can read cheaply is in its final minutes (or a watched lot is).
    const now = Date.now();
    const closing = q.openWindow.all(now - 60000, now + config.finalWindowMin * 60000).some(l => l.starred || quick(l.site));
    const every = closing ? config.finalEverySec : config.hotEverySec;
    await sleep(Math.max(every * 1000 - (Date.now() - t0), 3000));
  }
}

// Daily copy of the whole database (data/backups, last BACKUP_KEEP days), so years of results are safe.
async function backupLoop() {
  const dir = path.join(config.dataDir, 'backups');
  while (!stopping) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      const file = path.join(dir, `auctions-${day}.db`);
      if (!fs.existsSync(file)) {
        db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
        log.info('backup', `saved ${file} (${Math.round(fs.statSync(file).size / 1048576)} MB)`);
        const old = fs.readdirSync(dir).filter(f => /^auctions-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -config.backupKeep);
        for (const f of old) fs.rmSync(path.join(dir, f));
      }
    } catch (e) { log.warn('backup', e.message); }
    await sleep(3600000);
  }
}

// Small jobs: morning digests (every minute), listing checks, suburb lookups (every 5 minutes).
async function choresLoop() {
  let n = 0;
  while (!stopping) {
    try { await digestTick(); } catch (e) { log.warn('digest', e.message); }
    try { await checkPending(); } catch (e) { log.warn('check', e.message); }
    if (n % 60 === 0) prunePhotos();
    if (n++ % 5 === 0) { try { await geocodePending(q.openLots.all(Date.now())); } catch (e) { log.warn('geo', e.message); } }
    await sleep(60000);
  }
}

async function estimateLoop() {
  while (!stopping) {
    try { await estimatePending(); } catch (e) { log.warn('estimate', e.message); }
    await sleep(60000);
  }
}

/** Add any lot by its link. Returns the stored key, or throws if the site isn't supported. */
export function watchUrl(url, user = config.dashUser) {
  const a = Object.values(adapters).find(x => x.owns(url));
  if (!a) throw new Error('That link is not a lot page on a site KAMRADS watches (Pickles, Manheim, ALLBIDS, Lloyds, Grays, Slattery, The Auction Barn).');
  const id = a.idFromUrl(url);
  if (!id) throw new Error('Could not find the lot number in that link.');
  const now = Date.now();
  const key = `${a.site}:${id}`;
  q.addWatch.run(key, a.site, id, url.split('#')[0], now, now, now);
  q.watch.run(String(user).toLowerCase(), key, now);
  return key;
}

export async function startScheduler() {
  for (const a of enabled()) if (a.loginUrl) await ensureLogin(a.site, a.loginUrl).catch(e => log.warn(a.site, e.message));
  runSearches().catch(e => log.warn('search', e.message));
  discoveryLoop();
  hotLoop();
  estimateLoop();
  backupLoop();
  choresLoop();
  freightLoop();
  pushLoop();
}
