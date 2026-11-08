// Cruises: read every departure port's page on OzCruising (hourly), save every cruise and its fares,
// then push each person the new red-hot deals that fit their filters.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import { db } from '../db.js';
import { withPage, looksBlocked } from '../browser.js';
import { push } from '../notify.js';
import { PORTS, PORT_KEYS, OZ, portUrl, cardFromText, cardsFromJson, cardsFromPageText, dedupe } from './parse.js';
import { cz, upsertCruise } from './store.js';
import { viewOf, hasView, fits, isRedHot, nightOf, leadOf } from './view.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let stopping = false, running = null;
export const stopCruises = () => { stopping = true; };
export const todayYmd = (now = Date.now()) => new Date(now).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });

/** In the page: sort by price if there's a control for it, then open more results ("Load more" / scrolling). */
async function readPage(page, clicks) {
  // sort cheapest first, so the deals are in what we read even when the list is long
  try {
    const sorted = await page.evaluate(() => {
      for (const s of document.querySelectorAll('select')) {
        const o = [...s.options].find(x => /price/i.test(x.text) && /low|cheap|asc|↑/i.test(x.text));
        if (o && s.value !== o.value) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; }
      }
      return false;
    });
    if (!sorted) {
      const b = page.locator('button, a, [role="option"], li').filter({ hasText: /^\s*(?:price[:\s(-]*(?:low(?:est)?(?:\s+to\s+high)?)?\)?|lowest price|cheapest(?: first)?)\s*$/i }).first();
      if (await b.isVisible({ timeout: 800 }).catch(() => false)) await b.click({ timeout: 2000 }).catch(() => {});
    }
    await page.waitForTimeout(2000);
  } catch { /* no sort control */ }
  for (let i = 0; i < clicks; i++) {
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(700);
    const more = page.locator('a, button').filter({ hasText: /^\s*(?:load|show|view|see)\s+more(?:\s+(?:cruises|results|deals|sailings))?\s*$|^\s*more\s+cruises\s*$/i });
    const n = await more.count().catch(() => 0);
    let clicked = false;
    for (let j = 0; j < n && !clicked; j++) {
      const el = more.nth(j);
      if (await el.isVisible().catch(() => false)) { await el.click({ timeout: 3000 }).catch(() => {}); clicked = true; await page.waitForTimeout(2200); }
    }
    if (!clicked && i > 1) break;
  }
  return page.evaluate(() => {
    const rx = /\/cruise\/([a-z0-9][a-z0-9.-]{3,40})(?:[/?#]|$)/i;
    const out = new Map();
    for (const a of document.querySelectorAll('a[href]')) {
      const m = rx.exec(a.href);
      if (!m) continue;
      let box = a;
      for (let i = 0; i < 8 && box.parentElement; i++) {
        const p = box.parentElement;
        const ids = new Set([...p.querySelectorAll('a[href]')].map(x => (rx.exec(x.href) || [])[1]).filter(Boolean));
        if (ids.size > 1) break;
        box = p;
      }
      const text = (box.innerText || '').trim();
      const prev = out.get(m[1]);
      if (!prev || text.length > prev.text.length) out.set(m[1], { href: a.href.split('#')[0].split('?')[0], text });
    }
    const next = [...document.querySelectorAll('a[rel="next"], a[aria-label*="next" i], a')].find(a => /^(?:next|›|»|>)$/i.test((a.innerText || a.getAttribute('aria-label') || '').trim()) || a.rel === 'next');
    return { cards: [...out.values()], next: next?.href || null };
  });
}

/** One departure port: every cruise on its page(s). */
export async function readPort(slug, { maxPages = config.cruises.maxPages } = {}) {
  const portKey = PORTS[slug]?.key || null;
  let url = portUrl(slug);
  const all = [];
  for (let pg = 0; pg < maxPages && url; pg++) {
    const r = await withPage('ozcruising', url, page => readPage(page, maxPages), { waitMs: 2500 });
    if (looksBlocked(r)) throw new Error(`blocked by OzCruising (HTTP ${r.status})`);
    if (r.status === 404 || r.status >= 500) throw new Error(`OzCruising page ${url.replace(OZ, '')} answered HTTP ${r.status}`);
    let recs = dedupe([
      ...cardsFromJson(r.json, { portKey }),
      ...(r.result?.cards || []).map(c => cardFromText(c.text, { href: c.href, portKey })),
    ]);
    if (!recs.length) recs = cardsFromPageText(r.text, { portKey });
    if (!recs.length && !pg) { snapshot(slug, r); throw new Error('the page loaded but no cruises could be read from it (layout changed?) - snapshot saved in data/probe'); }
    const had = dedupe(all).length;
    all.push(...recs);
    // a further page of results, on the same port's listing only (and only while it keeps giving new cruises)
    const next = r.result?.next;
    url = next && next !== url && next.startsWith(portUrl(slug)) && dedupe(all).length > had ? next : null;
    if (url) await sleep(config.cruises.gapMs);
  }
  // a port page only lists cruises leaving from it: anything without a port belongs to this one
  return dedupe(all).map(c => ({ ...c, port: c.port || portKey, url: c.url || null }));
}

function snapshot(slug, r) {
  try {
    const dir = path.join(config.dataDir, 'probe', `cruises-${slug}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'page.html'), r.html || '');
    fs.writeFileSync(path.join(dir, 'page.txt'), r.text || '');
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(r.json.map(j => ({ url: j.url, body: j.body })), null, 1).slice(0, 5e6));
  } catch (e) { log.warn('cruises', `snapshot: ${e.message}`); }
}

/** Save what was read (a scan, or a page pasted in). Returns how many were new. */
export function saveCruises(recs, src = 'scan', now = Date.now()) {
  let fresh = 0;
  const today = todayYmd(now);
  db.exec('BEGIN');
  try {
    for (const r of recs) {
      if (!r?.nights || r.depart && r.depart < today) continue;
      if (upsertCruise(r, now, src).isNew) fresh++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return fresh;
}

/** Read every port (or just some), save, expire what's gone, alert. */
export async function scanCruises({ only = null } = {}) {
  if (running) return running;
  running = (async () => {
    const ports = config.cruises.ports.filter(s => PORTS[s] && (!only || only.includes(s)));
    for (const slug of ports) {
      if (stopping) break;
      try {
        const recs = await readPort(slug);
        const fresh = saveCruises(recs);
        cz.statusOk.run(slug, Date.now(), recs.length);
        log.info('cruises', `${PORTS[slug].name}: ${recs.length} cruises (${fresh} new)`);
      } catch (e) {
        cz.statusErr.run(slug, e.message.slice(0, 300), Date.now());
        log.warn('cruises', `${slug}: ${e.message}`);
      }
      await sleep(config.cruises.gapMs);   // gently: one port page at a time
    }
    const now = Date.now();
    cz.expire.run(now - config.cruises.keepHours * 3600e3, todayYmd(now));
    await runCruiseAlerts(now);
  })().finally(() => { running = null; });
  return running;
}

const money = v => (v == null ? '?' : '$' + Math.round(v).toLocaleString('en-AU'));
const when = ymd => (ymd ? new Date(ymd + 'T00:00:00Z').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'date?');
export const portName = k => PORT_KEYS[k]?.name.replace(/ \(.*\)$/, '') || '?';

/** Red-hot cruises (by each person's own filters) that haven't buzzed them before. */
export function redHotFor(user, now = Date.now()) {
  const v = viewOf(user);
  const told = new Set(cz.alerted.all(user).map(r => r.key));
  const hot = cz.open.all(todayYmd(now)).filter(c => fits(c, v, now) && isRedHot(c, v));
  return { v, hot, fresh: hot.filter(c => !told.has(c.key)) };
}

/** Quietly mark everything red-hot right now as already told (when someone sets up or changes their filters). */
export function primeAlerts(user, now = Date.now()) {
  const { v, fresh } = redHotFor(user, now);
  for (const c of fresh) cz.addAlert.run(user, c.key, now, nightOf(c, v.share).night);
  return fresh.length;
}

export async function runCruiseAlerts(now = Date.now()) {
  let total = 0;
  for (const user of Object.keys(config.users).length ? Object.keys(config.users) : [(config.dashUser || 'admin').toLowerCase()]) {
    if (!hasView(user)) continue;   // only people who've opened the Cruises page
    const { v, fresh } = redHotFor(user, now);
    if (!v.alerts || !fresh.length) continue;
    fresh.sort((a, b) => nightOf(a, v.share).night - nightOf(b, v.share).night);
    for (const c of fresh) cz.addAlert.run(user, c.key, now, nightOf(c, v.share).night);
    total += fresh.length;
    const best = nightOf(fresh[0], v.share).night;
    const lines = fresh.slice(0, 4).map(c => `• ${money(nightOf(c, v.share).night)}/night · ${c.ship || c.title || 'Cruise'} · ${c.nights} nights from ${portName(c.port)}, ${when(c.depart)} · ${money(leadOf(c, v.share))} pp`);
    await push({
      to: user, priority: 'high', tags: 'ship,fire',
      url: fresh.length === 1 && fresh[0].url ? fresh[0].url : config.dashboardPublicUrl ? config.dashboardPublicUrl + '/cruises' : undefined,
      title: fresh.length === 1 ? `Red-hot cruise: ${money(best)}/night` : `${fresh.length} red-hot cruises from ${money(best)}/night`,
      message: lines.join('\n') + (fresh.length > 4 ? `\n+${fresh.length - 4} more in Cruises` : ''),
    });
  }
  if (total) log.info('cruises', `${total} new red-hot cruises pushed`);
  return total;
}

export async function cruisesLoop() {
  if (!config.cruises.enabled) return;
  await sleep(90000);   // after the auction scans get going
  while (!stopping) {
    const t0 = Date.now();
    try { await scanCruises(); } catch (e) { log.error('cruises', e.stack || e.message); }
    await sleep(Math.max(config.cruises.everyMin * 60000 - (Date.now() - t0), 5 * 60000));
  }
}

