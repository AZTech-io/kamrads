// Dreams: list every auction lot that could be the vehicle we want (Isuzu D-Max, Isuzu curtainsider...),
// value each one against dealer / private listings and real auction results, and push when one is a deal.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { upsertLot } from '../db.js';
import { push } from '../notify.js';
import { log } from '../log.js';
import * as settings from '../settings.js';
import { baseByName } from '../geo.js';
import { compile } from '../searches.js';
import { isLiveSale } from '../live.js';
import { isVehicle, factsFromText } from '../extract.js';
import { withPage } from '../browser.js';
import { lotsFromCapture } from '../sites/common.js';
import { purchaseForLot } from '../purchases.js';
import { dq } from './store.js';
import { KINDS, CLASSES, damageOf } from './model.js';
import { parsePaste } from './parse.js';
import { analyze, asItem, fitRates, calibrate, valueFrom, levelRank } from './value.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const money = n => (n == null ? '?' : '$' + Math.round(n).toLocaleString('en-AU'));
const pct = p => (p == null ? '' : `${Math.round(p * 100)}%`);
const RETAIL_DAYS = 120;
const FRESH_MS = 3 * 60000;

// ---- dreams ----
export function defaults(kind) {
  const cfg = KINDS[kind] || KINDS.custom;
  return { target: 0.25, alertLevel: 'good', newListings: 'all', yearMin: null, yearMax: null, kmMax: null, budget: null, classes: [], drive: '', cab: '',
    allowRepairable: true, allowDamaged: true, transport: true, onRoad: cfg.onRoad, stigma: cfg.stigma, terms: '', notes: '' };
}
const parseJson = s => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };
export const settingsOf = d => ({ ...defaults(d.kind), ...parseJson(d.settings) });
export const allDreams = () => dq.all.all();

const num = v => (v === '' || v == null ? null : Number(String(v).replace(/[$,\s]/g, '')));
function cleanSettings(kind, b, prev = defaults(kind)) {
  const s = { ...prev };
  const n = (k, lo, hi) => { if (k in b) { const v = num(b[k]); if (v != null && !(v >= lo && v <= hi)) throw new Error(`${k} looks wrong`); s[k] = v; } };
  n('yearMin', 1950, 2040); n('yearMax', 1950, 2040); n('kmMax', 0, 3e6); n('budget', 0, 2e6); n('onRoad', 0, 1e5);
  if ('target' in b) { let t = num(b.target); if (t > 1) t /= 100; if (!(t >= 0 && t < 0.9)) throw new Error('Target saving should be between 0 and 90%'); s.target = t; }
  if ('stigma' in b) { let t = num(b.stigma); if (t > 1) t /= 100; if (!(t >= 0 && t < 0.9)) throw new Error('Write-off discount should be between 0 and 90%'); s.stigma = t; }
  if ('alertLevel' in b) s.alertLevel = ['diamond', 'good', 'fair', 'off'].includes(b.alertLevel) ? b.alertLevel : 'good';
  if ('newListings' in b) s.newListings = ['all', 'deals', 'off'].includes(b.newListings) ? b.newListings : 'all';
  if ('classes' in b) s.classes = (Array.isArray(b.classes) ? b.classes : []).filter(c => CLASSES[c]);
  if ('drive' in b) s.drive = ['4x4', '4x2'].includes(b.drive) ? b.drive : '';
  if ('cab' in b) s.cab = ['crew', 'space', 'single'].includes(b.cab) ? b.cab : '';
  for (const k of ['allowRepairable', 'allowDamaged', 'transport']) if (k in b) s[k] = !!b[k];
  if ('terms' in b) s.terms = String(b.terms || '').slice(0, 200);
  if ('notes' in b) s.notes = String(b.notes || '').slice(0, 2000);
  return s;
}

export function createDream(user, b = {}) {
  const kind = KINDS[b.kind] ? b.kind : 'custom';
  const s = cleanSettings(kind, b);
  if (kind === 'custom' && !/[a-z0-9]/i.test(s.terms.replace(/(^|\s)-\S+/g, ''))) throw new Error('Say what to look for, e.g. "toyota hiace, -crash".');
  const name = String(b.name || '').trim().slice(0, 80) || KINDS[kind].label;
  const now = Date.now();
  const { id } = dq.add.get(name, kind, String(user).toLowerCase(), 'hunting', JSON.stringify(s), now, now);
  forget();
  runDreams({ quiet: true, only: id }).catch(e => log.warn('dreams', e.message));
  return id;
}

export function updateDream(id, b = {}) {
  const d = dq.one.get(id);
  if (!d) throw new Error('Not found');
  const s = cleanSettings(d.kind, b, settingsOf(d));
  const status = ['hunting', 'paused', 'found'].includes(b.status) ? b.status : d.status;
  const name = 'name' in b ? String(b.name || '').trim().slice(0, 80) || d.name : d.name;
  const found = 'foundKey' in b ? (b.foundKey || null) : d.found_key;
  dq.update.run(name, status, JSON.stringify(s), found, Date.now(), id);
  forget();
  if (d.kind === 'custom' && s.terms !== settingsOf(d).terms) runDreams({ quiet: true, only: id }).catch(e => log.warn('dreams', e.message));
}

export function deleteDream(id) { dq.delHits.run(id); dq.delAlerts.run(id); dq.del.run(id); forget(); refreshKeys(); }

// ---- matching ----
export function matchLot(d, lot, test) {
  if (!lot.title || !isVehicle(lot)) return null;
  if (d.kind === 'custom') return (test || compile(settingsOf(d).terms))(`${lot.title} ${lot.body || ''} ${lot.category || ''}`.replace(/[-_/]/g, ' ')) ? 'yes' : null;
  return (KINDS[d.kind] || KINDS.custom).match(asItem(lot).f);
}

let dreamKeys = new Set();
function refreshKeys() { dreamKeys = new Set(dq.openHitKeys.all().map(r => r.key)); }
/** Lots that belong to a dream get their live price read near the close and a final read, whatever their price. */
export const isDreamKey = key => dreamKeys.has(key);

/** After each scan: record every lot that matches a dream; push the new ones. */
export async function runDreams({ quiet = false, only = null, now = Date.now() } = {}) {
  const dreams = allDreams().filter(d => (only ? d.id === only : d.status !== 'paused'));
  let isuzu = null, everything = null;
  for (const d of dreams) {
    const s = settingsOf(d);
    const lots = d.kind === 'custom' ? (everything ||= dq.openAll.all(now)) : (isuzu ||= dq.openIsuzu.all(now));
    const test = d.kind === 'custom' ? compile(s.terms) : null;
    const fresh = [];
    const matched = new Set();
    for (const l of lots) {
      const m = matchLot(d, l, test);
      if (!m) continue;
      matched.add(l.key);
      const prev = dq.hitExists.get(d.id, l.key);
      dq.hit.run(d.id, l.key, m, now, quiet || prev ? 1 : 0);
      // new, or a "maybe" whose body turned out to be the right one
      if (!quiet && m === 'yes' && (!prev || prev.match === 'maybe')) fresh.push(l);
    }
    // a lot whose body turned out to be something else (a pantech, not a curtainsider) drops off
    for (const h of dq.hitsOf.all(d.id)) if (h.status === 'open' && !matched.has(h.key) && (h.end_at == null || h.end_at > now)) dq.dropHit.run(d.id, h.key);
    if (fresh.length && d.status === 'hunting' && s.newListings !== 'off') await announceNew(d, s, fresh).catch(e => log.warn('dreams', e.message));
  }
  refreshKeys();
}

async function announceNew(d, s, lots) {
  const ctx = context(d);
  let rows = lots.map(l => ({ l, a: analyze(l, ctx) })).filter(x => x.a.inCriteria && x.a.verdict !== 'avoid');
  if (s.newListings === 'deals') rows = rows.filter(x => levelRank(x.a.verdict) >= levelRank(s.alertLevel === 'off' ? 'good' : s.alertLevel));
  if (!rows.length) return;
  rows.sort((a, b) => (b.a.score ?? -9) - (a.a.score ?? -9));
  const lines = rows.slice(0, 4).map(({ l, a }) => `• ${l.title.slice(0, 60)} — ${[l.odometer ? `${Math.round(l.odometer / 1000)}k km` : null, l.state,
    a.maxBid ? `bid up to ${money(a.maxBid)}` : null, a.retail ? `retail ~${money(a.effective)}` : null].filter(Boolean).join(' · ')}`);
  await push({ to: d.user, priority: 'default', tags: 'star', url: dashUrl(d),
    title: `${KINDS[d.kind]?.icon || '⭐'} ${rows.length} new ${d.name} at auction`, message: lines.join('\n') + (rows.length > 4 ? `\n+${rows.length - 4} more on Dreams` : '') });
}
const dashUrl = d => (config.dashboardPublicUrl ? `${config.dashboardPublicUrl.replace(/\/$/, '')}/dreams#${d.id}` : undefined);

/** Read the lot page of a few "maybe" trucks for their body type (one try each, gently). */
export async function readMaybeBodies({ max = 3, read = l => withPage(l.site, l.url, null, { waitMs: 1500 }), now = Date.now() } = {}) {
  const rows = dq.maybeUnread.all(now, max);
  if (!rows.length) return 0;
  let found = 0;
  for (const l of rows) {
    dq.addAlert.run(0, l.key, 'bodyread', now);
    try {
      const r = await read(l);
      const body = factsFromText(r.text || '').body || lotsFromCapture(r).find(x => String(x.ext_id) === String(l.ext_id))?.body || null;
      if (body) { upsertLot({ site: l.site, ext_id: l.ext_id, body }); found++; }
    } catch (e) { log.warn('dreams', `body of ${l.key}: ${e.message}`); }
  }
  if (found) await runDreams();
  return found;
}

// ---- valuation context (per dream, cached briefly) ----
let cache = new Map();
const forget = () => { cache = new Map(); };
function marketFor(d, now = Date.now()) {
  const s = settingsOf(d);
  const test = d.kind === 'custom' ? compile(s.terms) : null;
  return dq.marketAll.all(now - RETAIL_DAYS * 864e5).map(m => ({ ...m, it: asItem({ title: m.title, body: m.body, year: m.year, odometer: m.km }) }))
    .filter(m => (d.kind === 'custom' ? test(`${m.title} ${m.body || ''}`) : (KINDS[d.kind].match(m.it.f) === 'yes')));
}
const toComp = m => ({ key: `m${m.id}`, id: m.id, title: m.title, year: m.it.year, km: m.km, f: m.it.f, price: m.price ? (m.seller === 'private' ? m.price * 1.07 : m.price) : null,
  raw: m.price, seller: m.seller, source: m.source, url: m.url, state: m.state, at: m.last_seen });

function soldFor(d, now = Date.now()) {
  const s = settingsOf(d);
  const test = d.kind === 'custom' ? compile(s.terms) : null;
  const rows = d.kind === 'custom' ? dq.soldAll.all(now - 730 * 864e5) : dq.soldIsuzu.all(now - 730 * 864e5);
  return rows.filter(l => matchLot(d, l, test) === 'yes');
}

export function context(d, user = d.user) {
  const key = `${d.id}|${d.updated_at}|${user}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 120000) return hit.ctx;
  const s = settingsOf(d);
  const market = marketFor(d);
  const retailPool = market.filter(m => m.price > 0).map(toComp);
  const rates = fitRates(retailPool, d.kind);
  const sold = soldFor(d);
  const soldRows = sold.map(l => ({ l, it: asItem(l), dmg: damageOf(l).level }));
  const asComp = r => ({ key: r.l.key, title: r.l.title, year: r.it.year, km: r.it.km, f: r.it.f, price: r.l.final_bid, source: r.l.site, url: r.l.url, state: r.l.state, at: r.l.end_at });
  const auctionClean = soldRows.filter(r => r.dmg === 'clean').map(asComp);
  const auctionDamaged = soldRows.filter(r => r.dmg !== 'clean' && r.dmg !== 'statutory').map(asComp);
  const cal = calibrate(auctionClean, retailPool, { kind: d.kind, rates });
  const ctx = { kind: d.kind, s, rates, retailPool, market, auctionClean, auctionDamaged, sold, cal,
    base: baseByName(settings.getUser(user, 'base')), notes: new Map(dq.notes.all().map(n => [n.key, n])) };
  cache.set(key, { at: Date.now(), ctx });
  return ctx;
}

// ---- the Dreams page ----
const SITE_PHOTO = l => (l.image ? `/photo/${encodeURIComponent(l.key)}` : null);
function lotView(l, a, extra = {}, lean = false) {
  if (lean) a = { ...a, retail: a.retail && { ...a.retail, comps: undefined }, auction: a.auction && { ...a.auction, comps: undefined } };
  return {
    key: l.key, site: l.site, url: l.url, title: l.title, photo: SITE_PHOTO(l), location: l.location, state: l.state, body: l.body || null,
    year: a.item.year, km: a.item.km, wovr: l.wovr, buyMethod: l.buy_method, liveSale: isLiveSale(l), opensAt: l.opens_at ?? null, endAt: l.end_at,
    bid: l.bid, bidCount: l.bid_count, startPrice: l.start_price, buyNow: l.buy_now, reserve: l.reserve, lastChecked: l.last_checked, status: l.status,
    finalBid: l.final_bid ?? null, purchaseId: purchaseForLot(l.key)?.id ?? null, ...a, ...extra,
  };
}

export function dreamView(id, user, now = Date.now()) {
  const d = dq.one.get(id);
  if (!d) return null;
  const ctx = context(d, user);
  const s = ctx.s;
  const hits = dq.hitsOf.all(d.id);
  const open = hits.filter(h => h.status === 'open' && (h.end_at == null || h.end_at > now - 6 * 3600000));
  const lots = [], maybes = [];
  for (const h of open) {
    const a = analyze(h, ctx);
    if (a.damage.level === 'statutory' && !config.includeStatutory) continue;
    (h.match === 'maybe' ? maybes : lots).push(lotView(h, a, { match: h.match, firstSeen: h.hit_at }));
  }
  const order = (x, y) => (y.inCriteria - x.inCriteria) || ((y.score ?? -9) - (x.score ?? -9)) || ((x.endAt ?? Infinity) - (y.endAt ?? Infinity));
  lots.sort(order); maybes.sort((x, y) => (x.endAt ?? Infinity) - (y.endAt ?? Infinity));
  // sold at auction: what each went for, against what it was worth
  const sold = ctx.sold.slice(0, 400).map(l => {
    const a = analyze(l, ctx);
    return lotView(l, a, { soldAt: l.end_at, price: l.final_bid, ofRetail: a.retail ? l.final_bid / a.retail.value : null, winnerPct: a.now?.pct ?? null }, true);
  });
  const pricedKeys = new Set(sold.map(x => x.key));
  const unpriced = dq.closedHits.all(d.id, now - 90 * 864e5).filter(l => !pricedKeys.has(l.key)).slice(0, 60)
    .map(l => ({ key: l.key, site: l.site, url: l.url, title: l.title, endAt: l.end_at, lastBid: l.final_bid ?? l.bid ?? null, state: l.state, km: l.odometer }));
  // retail: each listing against the others (a dealer ad 20% under the rest is a deal too)
  const market = ctx.market.map(m => {
    const it = toComp(m);
    const v = m.price ? valueFrom({ year: it.year, km: m.km, f: it.f }, ctx.retailPool, { kind: d.kind, rates: ctx.rates, exclude: it.key }) : null;
    return { id: m.id, source: m.source, title: m.title, year: it.year, km: m.km, price: m.price, prevPrice: m.prev_price, priceNote: m.price_note, seller: m.seller, condition: m.condition,
      state: m.state, location: m.location, url: m.url, body: m.body, cls: it.f.cls, code: it.f.code, drive: it.f.drive, cab: it.f.cab, firstSeen: m.first_seen, lastSeen: m.last_seen,
      model: v?.value ?? null, vsModel: v && it.price ? it.price / v.value - 1 : null };
  });
  const fh = d.found_key ? hits.find(h => h.key === d.found_key) : null;
  const found = fh ? lotView(fh, analyze(fh, ctx), {}, true) : d.found_key ? { key: d.found_key, title: d.found_key } : null;
  const bought = hits.map(h => ({ h, p: purchaseForLot(h.key) })).filter(x => x.p).map(x => ({ key: x.h.key, title: x.h.title, purchaseId: x.p.id }));
  const ratios = sold.filter(x => x.ofRetail != null && x.damage.level === 'clean').map(x => x.ofRetail).sort((a, b) => a - b);
  return {
    now, dream: { id: d.id, name: d.name, kind: d.kind, user: d.user, status: d.status, icon: KINDS[d.kind]?.icon || '⭐', foundKey: d.found_key, settings: s, createdAt: d.created_at },
    classes: d.kind === 'curtainsider' ? CLASSES : null,
    model: { rates: ctx.rates, cal: ctx.cal, retailN: ctx.retailPool.length, soldN: ctx.auctionClean.length + ctx.auctionDamaged.length,
      soldOfRetail: ratios.length ? ratios[ratios.length >> 1] : null, base: ctx.base?.name || null },
    lots, maybes, sold, unpriced, market, found, bought,
  };
}

export function summary(user) {
  return allDreams().map(d => {
    const hits = dq.hitsOf.all(d.id);
    const open = hits.filter(h => h.status === 'open' && h.match === 'yes' && (h.end_at == null || h.end_at > Date.now()));
    let best = null;
    try {
      const ctx = context(d, user);
      for (const h of open) { const a = analyze(h, ctx); if (a.inCriteria && a.verdict !== 'avoid' && (best == null || (a.score ?? -9) > best.score)) best = { key: h.key, title: h.title, score: a.score, verdict: a.verdict }; }
    } catch (e) { log.warn('dreams', e.message); }
    return { id: d.id, name: d.name, kind: d.kind, icon: KINDS[d.kind]?.icon || '⭐', status: d.status, user: d.user, open: open.length,
      maybes: hits.filter(h => h.status === 'open' && h.match === 'maybe').length, best };
  });
}

// ---- imports: pasted Trucksales / Carsales / Pickles pages ----
const uidOf = l => `${l.source}:${l.extId || [l.title, l.year, l.km, l.state, l.seller].join('|').toLowerCase().replace(/\s+/g, ' ')}`;
const sydneyEndOfDay = t => {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date(t));
  const [y, m, dd] = ymd.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, dd, 23, 59, 59);
  const off = new Date(naive).toLocaleString('en-US', { timeZone: 'Australia/Sydney', timeZoneName: 'shortOffset' }).match(/GMT([+-]\d+)/);
  return naive - (off ? Number(off[1]) : 10) * 3600000;
};

export function importPaste(user, text, { tz = 'Australia/Sydney', now = Date.now(), source, quiet = true } = {}) {
  if (!String(text || '').trim()) throw new Error('Paste a results page first.');
  if (String(text).length > 3e6) throw new Error('That is too much at once - paste a few pages at a time.');
  const { source: src, listings } = parsePaste(text, { now, tz, source });
  if (!listings.length) throw new Error('No listings found in that. Copy the whole results page (Ctrl+A, Ctrl+C) and paste it here.');
  const { id: importId } = dq.addImport.get(String(user || '').toLowerCase(), now, src, listings.length, 0, 0, 0, null);
  let added = 0, updated = 0, lots = 0, skipped = 0;
  for (const l of listings) {
    if (src === 'pickles') {
      // auction lots: into the board like any other lot (the scraper fills in the rest)
      const end = l.endsAt || (l.startsAt ? sydneyEndOfDay(l.startsAt) : null);
      if (end && end < Date.now()) { skipped++; continue; }
      upsertLot({ site: 'pickles', ext_id: l.stock, url: l.url, title: l.title, year: l.year, odometer: l.km, location: l.location, state: l.state,
        buy_method: l.buyMethod, buy_now: l.buyNow, bid: l.bid, end_at: end, opens_at: l.startsAt, body: l.body, lot_no: l.lotNo, category: l.category, wovr: l.wovr });
      lots++;
      continue;
    }
    const uid = uidOf(l);
    const prev = dq.marketByUid.get(uid);
    if (prev) { dq.marketSeen.run(now, l.price ?? null, l.price ?? null, l.price ?? null, l.km ?? null, l.url ?? null, importId, prev.id); updated++; }
    else {
      dq.marketAdd.run(uid, l.source, l.title.slice(0, 200), l.year, l.price ?? null, l.priceNote ?? null, l.km ?? null, l.gvm ?? null, l.hp ?? null, l.trans ?? null, l.body ?? null,
        l.seller ?? null, l.condition ?? null, l.state ?? null, l.location ?? null, l.url ?? null, now, now, importId);
      added++;
    }
  }
  dq.setImport.run(listings.length, added, updated, lots, importId);
  forget();
  runDreams({ quiet }).catch(e => log.warn('dreams', e.message));
  const dmax = listings.filter(l => l.features.dmax).length, curtain = listings.filter(l => l.features.isuzu && l.features.curtain).length;
  log.info('dreams', `import from ${src}: ${listings.length} found, ${added} new, ${updated} updated, ${lots} auction lots${skipped ? `, ${skipped} already sold` : ''}`);
  return { source: src, found: listings.length, added, updated, lots, skipped, dmax, curtain, other: listings.length - dmax - curtain };
}

export const hideListing = (id, hidden = true) => { dq.marketHide.run(hidden ? 1 : 0, id); forget(); };
export function setLotNote(key, user, { repair, note }) {
  const r = num(repair);
  if (r != null && !(r >= 0 && r < 1e6)) throw new Error('Repair estimate should be in dollars, e.g. 2500.');
  dq.setNote.run(key, r, note ? String(note).slice(0, 500) : null, user, Date.now());
  forget();
}

// ---- alerts ----
const tzOf = user => settings.getUser(user, 'digestTz') || config.digestTz;
const clock = (t, tz) => new Date(t).toLocaleString('en-AU', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** Final minutes of a timed auction: a dream lot still at a deal price. Needs a price read in the last 3 minutes. */
export async function dreamFinalAlert(lot, now = Date.now()) {
  if (!isDreamKey(lot.key) || isLiveSale(lot) || lot.status !== 'open') return;
  if (!lot.last_checked || now - lot.last_checked > FRESH_MS) return;
  for (const d of dq.hitsForKey.all(lot.key)) {
    const s = settingsOf(d);
    if (d.status !== 'hunting' || s.alertLevel === 'off' || d.match !== 'yes') continue;
    if (dq.alertSent.get(d.id, lot.key, 'final')) continue;
    const a = analyze(lot, context(d));
    if (!a.inCriteria || a.verdictNow === 'avoid' || levelRank(a.verdictNow) < levelRank(s.alertLevel)) continue;
    dq.addAlert.run(d.id, lot.key, 'final', now);
    const mins = Math.max(1, Math.round((lot.end_at - now) / 60000));
    await push({ to: d.user, priority: 'urgent', tags: 'gem', url: lot.url,
      title: `DREAM ${a.verdictNow === 'diamond' ? '💎' : '✅'} ${mins} min left · ${money(a.current)}`,
      message: [lot.title, `${pct(a.now.pct)} under what it's worth (~${money(a.effective)}) · all-in ${money(a.now.total)}`,
        a.maxBid ? `Bid up to ${money(a.maxBid)}` : null, [lot.site, lot.location || lot.state, lot.odometer ? `${lot.odometer.toLocaleString('en-AU')} km` : null].filter(Boolean).join(' · ')].filter(Boolean).join('\n') });
  }
}

/** Live-lane sales (most Pickles D-Maxes): one push per dream a few hours before the lane starts. */
export async function dreamLiveAlerts(now = Date.now()) {
  for (const d of allDreams()) {
    const s = settingsOf(d);
    if (d.status !== 'hunting' || s.alertLevel === 'off') continue;
    let ctx = null;
    const due = [];
    for (const h of dq.hitsOf.all(d.id)) {
      if (h.status !== 'open' || h.match !== 'yes' || !isLiveSale(h) || !h.end_at) continue;
      const start = h.opens_at || h.end_at - 17 * 3600000;   // no start time: early on the sale day
      if (start - now > 3 * 3600000 || start < now - 2 * 3600000 || dq.alertSent.get(d.id, h.key, 'live')) continue;
      ctx ||= context(d);
      const a = analyze(h, ctx);
      dq.addAlert.run(d.id, h.key, 'live', now);
      if (a.inCriteria && a.verdict !== 'avoid' && a.maxBid > 0) due.push({ h, a, start });
    }
    if (!due.length) continue;
    due.sort((x, y) => x.start - y.start);
    const tz = tzOf(d.user);
    await push({ to: d.user, priority: 'high', tags: 'loudspeaker', url: due.length === 1 ? due[0].h.url : dashUrl(d),
      title: `${KINDS[d.kind]?.icon || '⭐'} ${due.length} ${d.name} in live lanes soon`,
      message: due.slice(0, 5).map(({ h, a, start }) => `• ${h.title.slice(0, 55)} — ${h.location || h.state || h.site}, ${h.opens_at ? clock(start, tz) : 'today'} · bid up to ${money(a.maxBid)}${a.effective ? ` (worth ~${money(a.effective)})` : ''}`).join('\n') });
  }
}

/** Lines for the morning digest. */
export function dreamDigest(user, now = Date.now()) {
  const out = [];
  for (const d of allDreams().filter(x => x.user === user && x.status === 'hunting')) {
    const ctx = context(d, user);
    const today = dq.hitsOf.all(d.id).filter(h => h.status === 'open' && h.match === 'yes' && h.end_at && h.end_at > now && h.end_at < now + 24 * 3600000)
      .map(h => ({ h, a: analyze(h, ctx) })).filter(x => x.a.inCriteria && x.a.verdict !== 'avoid');
    if (!today.length) continue;
    today.sort((x, y) => (y.a.score ?? -9) - (x.a.score ?? -9));
    const b = today[0];
    out.push(`${KINDS[d.kind]?.icon || '⭐'} ${today.length} ${d.name} selling today — best: ${b.h.title.slice(0, 50)}${b.a.maxBid ? `, bid up to ${money(b.a.maxBid)}` : ''}`);
  }
  return out;
}

// ---- first run: the two dreams asked for, and the listings pasted in while building this ----
export function seed(now = Date.now()) {
  if (dq.meta.get('seeded')?.v) return;
  const user = (config.dashUser || 'admin').toLowerCase();
  if (!allDreams().length) {
    const t = Date.now();
    dq.add.get('Isuzu D-Max — Katara 3 upgrade', 'dmax', user, 'hunting', JSON.stringify(defaults('dmax')), t, t);
    dq.add.get('Isuzu curtainsider', 'curtainsider', user, 'hunting', JSON.stringify(defaults('curtainsider')), t, t);
  }
  const dir = path.join(here, '..', '..', 'seed', 'dreams');
  try {
    // copied off the sites on 22 Oct 2026, 8:50 pm Perth time
    const at = Date.parse('2026-10-22T12:50:00Z');
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.txt')).sort()) {
      try { importPaste(user, fs.readFileSync(path.join(dir, f), 'utf8'), { now: at, tz: 'Australia/Perth', quiet: true }); }
      catch (e) { log.warn('dreams', `seed ${f}: ${e.message}`); }
    }
  } catch { /* no seed folder */ }
  dq.setMeta.run('seeded', String(now));
}

export function startDreams() {
  try { seed(); } catch (e) { log.warn('dreams', `seed: ${e.message}`); }
  runDreams({ quiet: true }).catch(e => log.warn('dreams', e.message));
}

export { CLASSES, KINDS };
export const imports = () => dq.imports.all();
export const marketCount = () => dq.marketCount.get().n;
