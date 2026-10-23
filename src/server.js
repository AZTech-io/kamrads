import zlib from 'node:zlib';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { q } from './db.js';
import { estimateOf, estimateSource } from './alerts.js';
import { allIn, maxBidFor } from './costs.js';
import { baseByName, bases } from './geo.js';
import { soldLike, typeLike } from './history.js';
import { checkListing } from './inspect.js';
import { buildDigest } from './digest.js';
import { sectorOf, SECTORS } from './categories.js';
import { photo } from './photos.js';
import { isLiveSale } from './live.js';
import { parseVelocicast, importVelocicast, parseVelocicastStream, importVelocicastStream } from './results.js';
import * as purchases from './purchases.js';
import { freightRoutes } from './freight/routes.js';
import { apiRoutes } from './freight/api.js';
import { sendPage, savePref } from './pages.js';
import { findsRoutes } from './finds/routes.js';
import { isVehicle } from './extract.js';
import { push } from './notify.js';
import { watchUrl } from './scheduler.js';
import * as settings from './settings.js';
import { researchLot, testKey } from './estimate.js';
import { log } from './log.js';
import { watch, unwatch, setMyBid, bidStatus, warnRivals } from './users.js';
import { addSearch } from './searches.js';
import * as dreams from './dreams/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Each person logs in with their own name (DASH_USER/DASH_PASS plus DASH_USERS), which keeps
// their watchlist, bids and saved searches separate.
function basicAuth(req, res, next) {
  if (!Object.keys(config.users).length) { req.user = (config.dashUser || 'admin').toLowerCase(); return next(); }
  const [type, b64] = (req.headers.authorization || '').split(' ');
  if (type === 'Basic' && b64) {
    const [u, ...p] = Buffer.from(b64, 'base64').toString().split(':');
    const name = u.trim().toLowerCase();
    if (config.users[name] !== undefined && config.users[name] === p.join(':')) { req.user = name; return next(); }
  }
  res.set('WWW-Authenticate', 'Basic realm="KAMRADS"').status(401).send('Login required');
}

const sendCsv = (res, name, rows) => {
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const cell = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const iso = (k, v) => (/_at$|^first_seen$/.test(k) && typeof v === 'number' ? new Date(v).toISOString() : v);
  res.set('content-type', 'text/csv; charset=utf-8').set('content-disposition', `attachment; filename="${name}"`);
  res.send([cols.join(','), ...rows.map(r => cols.map(c => cell(iso(c, r[c]))).join(','))].join('\n'));
};
const json = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const baseOf = user => baseByName(settings.getUser(user, 'base'));
// The person's view: their home base (distances) and whether transport goes into the all-in cost.
const viewOf = user => ({ base: baseOf(user), transport: !!settings.getUser(user, 'transport') });
const shape = (l, alertKinds, view = null) => {
  const est = estimateOf(l);
  const price = l.bid ?? l.start_price;
  const cost = allIn(l, view?.base ?? null, price, { transport: !!view?.transport });
  const hist = soldLike(l) || typeLike(l);
  return {
    key: l.key, site: l.site, url: l.url, title: l.title, photo: l.image ? `/photo/${encodeURIComponent(l.key)}` : null, category: l.category,
    sector: sectorOf(l),
    year: l.year, odometer: l.odometer, wovr: l.wovr, location: l.location, state: l.state,
    buyMethod: l.buy_method, sale: l.sale_name, lotNo: l.lot_no, liveSale: isLiveSale(l),
    bid: l.bid, bidCount: l.bid_count, startPrice: l.start_price, buyNow: l.buy_now,
    endAt: l.end_at, opensAt: l.opens_at ?? null, reserve: l.reserve ?? null, reserveAmt: l.reserve_amt ?? null, lastChecked: l.last_checked, starred: !!l.starred,
    estLow: l.est_low, estHigh: l.est_high, estNote: l.est_note, manualEstimate: l.manual_estimate,
    estimate: est, estSource: est ? estimateSource(l) : null,
    // judged on what you'd pay the auction house; profit also takes off transport home
    ratio: est && cost ? cost.landed / est : null,
    profit: est && cost ? Math.round(est - cost.total) : null,
    cost, distanceKm: cost?.km ?? null, distanceApprox: cost?.kmApprox ?? null,
    history: hist ? { n: hist.n, median: hist.median, low: hist.low, high: hist.high, label: hist.label, rough: !!hist.rough } : null,
    check: l.check_verdict ? { verdict: l.check_verdict, ...(json(l.check_note) || {}), at: l.check_at } : null,
    vehicle: isVehicle(l), alerts: alertKinds.get(l.key) || [],
    marketAvg: l.est_avg ?? null, estMethod: l.est_method ?? null,
    comps: (() => { try { return l.est_comps ? JSON.parse(l.est_comps) : []; } catch { return []; } })(),
  };
};

export function startServer() {
  const app = express();
  // Big JSON answers (the board is a few MB) go compressed: about a tenth of the size over a phone connection
  app.use((req, res, next) => {
    if (!/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return next();
    const json = res.json.bind(res);
    res.json = body => {
      const text = JSON.stringify(body);
      if (text.length < 20000 || res.get('content-encoding')) return json(body);
      res.set({ 'content-type': 'application/json; charset=utf-8', 'content-encoding': 'gzip', vary: 'Accept-Encoding' });
      return res.send(zlib.gzipSync(text, { level: 5 }));
    };
    next();
  });
  app.use(express.json({ limit: '6mb' }));   // pasted results pages (Dreams) can be large
  // Private tool: never pass our address on to the auction sites, never get indexed.
  app.use((_req, res, next) => { res.set({ 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', 'X-Frame-Options': 'DENY' }); next(); });
  app.get('/robots.txt', (_req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  app.get('/healthz', (_req, res) => res.send('ok'));
  apiRoutes(app);   // Katara Freight's key-based API: before the logins
  app.use(basicAuth);
  // Pages carry the person's saved view settings; changes come back here
  app.get(['/', '/index.html'], (req, res) => sendPage(res, 'index.html', req.user));
  app.post('/api/prefs', (req, res) => {
    const b = req.body || {};
    try {
      if (b.all && typeof b.all === 'object') for (const [k, v] of Object.entries(b.all).slice(0, 60)) savePref(req.user, k, v);
      else savePref(req.user, b.key, b.value);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  freightRoutes(app);
  findsRoutes(app);
  // ---- Bought: items we've won, every cost logged, what each one owes us ----
  app.get('/bought', (req, res) => sendPage(res, 'bought.html', req.user));
  app.get('/api/purchases', (_req, res) => res.json(purchases.list()));
  const ok = fn => (req, res) => { try { res.json({ ok: true, ...(fn(req) || {}) }); } catch (e) { res.status(400).json({ error: e.message }); } };
  app.post('/api/purchases', ok(req => ({ id: req.body?.lotKey ? purchases.addFromLot(req.body.lotKey, req.user, req.body) : purchases.addManual(req.user, req.body || {}) })));
  app.patch('/api/purchases/:id', ok(req => { purchases.update(Number(req.params.id), req.body || {}); }));
  app.delete('/api/purchases/:id', ok(req => { purchases.remove(Number(req.params.id)); }));
  app.post('/api/purchases/:id/costs', ok(req => ({ costId: purchases.addCost(Number(req.params.id), req.user, req.body || {}) })));
  app.delete('/api/purchases/:id/costs/:costId', ok(req => { purchases.delCost(Number(req.params.id), Number(req.params.costId)); }));
  // ---- Dreams: the vehicles we want to own, every auction lot that could be one, valued against the market ----
  app.get('/dreams', (req, res) => sendPage(res, 'dreams.html', req.user));
  app.get('/api/dreams', (req, res) => res.json({ dreams: dreams.summary(req.user), imports: dreams.imports(), marketListings: dreams.marketCount(),
    kinds: Object.fromEntries(Object.entries(dreams.KINDS).map(([k, v]) => [k, { label: v.label, icon: v.icon }])), classes: dreams.CLASSES }));
  app.post('/api/dreams', ok(req => ({ id: dreams.createDream(req.user, req.body || {}) })));
  app.get('/api/dreams/:id', (req, res) => {
    const v = dreams.dreamView(Number(req.params.id), req.user);
    if (!v) return res.status(404).json({ error: 'Not found' });
    const mine = new Map(q.myWatchKeys.all(req.user).map(w => [w.key, w.my_bid]));
    for (const l of [...v.lots, ...v.maybes]) { l.starred = mine.has(l.key); l.myBid = mine.get(l.key) ?? null; }
    res.json(v);
  });
  app.patch('/api/dreams/:id', ok(req => { dreams.updateDream(Number(req.params.id), req.body || {}); }));
  app.delete('/api/dreams/:id', ok(req => { dreams.deleteDream(Number(req.params.id)); }));
  // Pickles live-lane results: a Velocicast page saved (or copied) by the person from their own session
  app.post('/api/results/velocicast', ok(req => importVelocicast(parseVelocicast(String(req.body?.text || '')))));
  // ...and the bid stream from a saved HAR of that page (the browser sends only the socket messages, never the file)
  app.post('/api/results/velocicast-stream', ok(req => importVelocicastStream(parseVelocicastStream(req.body?.messages || []))));
  app.post('/api/dreams-import', ok(req => {
    const tz = /^[A-Za-z]+\/[A-Za-z_]+$/.test(req.body?.tz || '') ? req.body.tz : config.digestTz;
    return dreams.importPaste(req.user, req.body?.text, { tz });
  }));
  app.post('/api/dreams-market/:id/hide', ok(req => { dreams.hideListing(Number(req.params.id), req.body?.hidden !== false); }));
  app.post('/api/dreams-note/:key', ok(req => { dreams.setLotNote(req.params.key, req.user, req.body || {}); }));
  app.get('/api/export/bought.csv', (_req, res) => sendCsv(res, `kamrads-bought-${new Date().toISOString().slice(0, 10)}.csv`, purchases.exportRows()));
  app.use(express.static(path.join(here, '..', 'public')));

  app.get('/api/lots', (req, res) => {
    const now = Date.now();
    const hours = Math.min(Number(req.query.hours) || 48, 24 * 14);
    const rows = q.dashboard.all(now - 60000, now + hours * 3600000, hours >= 168 ? 1 : 0, 4000);
    const alertKinds = new Map();
    for (const a of q.alertKinds.all(now - 7 * 86400000)) alertKinds.set(a.key, [...(alertKinds.get(a.key) || []), a.kind]);
    const mine = new Set(q.myWatchKeys.all(req.user).map(w => w.key));
    const view = viewOf(req.user);
    res.json({ now, base: view.base?.name, transport: view.transport, lots: rows.map(l => ({ ...shape(l, alertKinds, view), starred: mine.has(l.key) })) });
  });
  app.get('/api/me', (req, res) => res.json({ user: req.user, users: Object.keys(config.users), sectors: SECTORS }));
  app.get('/photo/:key', async (req, res) => {
    try {
      const p = await photo(q.lot.get(req.params.key));
      if (!p) return res.status(404).end();
      res.set({ 'content-type': p.type, 'cache-control': 'private, max-age=86400' }).sendFile(p.file);
    } catch { res.status(404).end(); }
  });
  // Deals that got away: closed lots whose final price was a bargain.
  app.get('/api/missed', (req, res) => {
    const days = Math.min(Number(req.query.days) || 7, 365);
    const mine = new Map(q.myWatchKeys.all(req.user).map(w => [w.key, w.my_bid]));
    const out = [];
    for (const l of q.missed.all(Date.now() - days * 86400000)) {
      const price = l.final_bid;
      const seen = l.final_seen_at && l.end_at ? Math.max(0, Math.round((l.end_at - l.final_seen_at) / 60000)) : null;
      if (seen == null || seen > 15) continue; // too long before the close to know what it really went for
      const statutory = l.wovr === 'Statutory Write-Off';
      if (statutory && !config.includeStatutory) continue;
      const est = estimateOf(l), market = l.est_avg;
      let why = null;
      if (est && price <= est * 0.5) why = `${Math.round((price / est) * 100)}% of estimate`;
      else if (market && price <= market * 0.5) why = `${Math.round((price / market) * 100)}% of market price`;
      else if (isVehicle(l) && price <= config.cheapVehicleMax) why = `vehicle under $${config.cheapVehicleMax.toLocaleString('en-AU')}`;
      else if (price <= config.pennyMax) why = 'penny lot';
      if (!why) continue;
      const myBid = mine.get(l.key);
      if (myBid != null && price <= myBid) continue; // you won it, not missed
      out.push({ ...shape({ ...l, bid: price }, new Map(), viewOf(req.user)), finalBid: price, closedAt: l.closed_at, seenMinsBeforeClose: seen, why,
        saving: (est || market) ? Math.round((est || market) - price) : null });
    }
    out.sort((a, b) => (b.saving ?? -1) - (a.saving ?? -1) || b.endAt - a.endAt);
    res.json({ now: Date.now(), days, lots: out.slice(0, 500) });
  });
  // Everything we've collected, for spreadsheets.
  app.get('/api/export/closed.csv', (req, res) => {
    const days = Math.min(Number(req.query.days) || 30, 3650);
    sendCsv(res, `kamrads-results-${new Date().toISOString().slice(0, 10)}.csv`, q.exportClosed.all(Date.now() - days * 86400000));
  });
  app.get('/api/export/bids.csv', (req, res) => {
    const days = Math.min(Number(req.query.days) || 30, 3650);
    sendCsv(res, 'kamrads-bid-history.csv', q.bidExport.all(Date.now() - days * 86400000));
  });
  app.get('/api/history', (_req, res) => res.json({ ...q.dbStats.get(), bids: q.bidRows.get().n }));
  // Saved searches
  app.get('/api/searches', (req, res) => {
    const counts = new Map(q.hitCount.all().map(h => [h.search_id, h.n]));
    res.json(q.searchesOf.all(req.user).map(s => ({ id: s.id, terms: s.terms, maxPrice: s.max_price, site: s.site, matches: counts.get(s.id) || 0, lastMatchAt: s.last_match_at })));
  });
  app.post('/api/searches', (req, res) => {
    const b = req.body || {};
    const maxPrice = b.maxPrice === '' || b.maxPrice == null ? null : Number(String(b.maxPrice).replace(/[$,\s]/g, ''));
    if (maxPrice != null && !(maxPrice >= 0)) return res.status(400).json({ error: 'Max price should be a number.' });
    try { res.json(addSearch(req.user, { terms: b.terms, maxPrice, site: b.site || null })); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.delete('/api/searches/:id', (req, res) => { const r = q.delSearch.run(Number(req.params.id), req.user); if (r.changes) q.delSearchHits.run(Number(req.params.id)); res.json({ ok: true }); });
  app.get('/api/searches/:id/lots', (req, res) => {
    const s = q.searchesOf.all(req.user).find(x => x.id === Number(req.params.id));
    if (!s) return res.status(404).json({ error: 'not found' });
    res.json(q.hitsOf.all(s.id).map(l => shape(l, new Map(), viewOf(req.user))));
  });
  app.get('/api/closed', (req, res) => {
    const hours = Math.min(Number(req.query.hours) || 24, 24 * 90);
    const rows = q.recentClosed.all(Date.now() - hours * 3600000);
    res.json({ now: Date.now(), stats: q.closedStats.all(Date.now() - hours * 3600000), lots: rows.map(l => {
      const out = shape({ ...l, bid: l.final_bid }, new Map(), viewOf(req.user));
      out.finalBid = l.final_bid;
      out.closedAt = l.closed_at;
      out.endedEarly = !!l.ended_early;
      out.purchaseId = purchases.purchaseForLot(l.key)?.id ?? null;
      // How close to the end our last look was: 0-1 min = the real hammer price, more = it may have gone higher.
      out.seenMinsBeforeClose = l.final_seen_at && l.end_at ? Math.max(0, Math.round((l.end_at - l.final_seen_at) / 60000)) : null;
      return out;
    }) });
  });
  app.get('/api/watchlist', (req, res) => {
    const now = Date.now();
    const alertKinds = new Map();
    for (const a of q.alertKinds.all(now - 7 * 86400000)) alertKinds.set(a.key, [...(alertKinds.get(a.key) || []), a.kind]);
    res.json({ now, every: config.watchEverySec, lots: q.userWatchlist.all(req.user, now - 24 * 3600000).map(l => ({
      ...shape(l.status === 'closed' ? { ...l, bid: l.final_bid ?? l.bid } : l, alertKinds, viewOf(req.user)),
      rivals: q.rivals.all(l.key, req.user).map(r => ({ user: r.user, myBid: r.my_bid })),
      status: l.status, finalBid: l.final_bid, closedAt: l.closed_at,
      seenMinsBeforeClose: l.final_seen_at && l.end_at ? Math.max(0, Math.round((l.end_at - l.final_seen_at) / 60000)) : null,
      starred: true, myBid: l.my_bid, bidStatus: bidStatus(l, l.my_bid), purchaseId: purchases.purchaseForLot(l.key)?.id ?? null,
      others: q.watchersOf.all(l.key).filter(w => w.user !== req.user).map(w => w.user),
    })) });
  });
  app.post('/api/watch', (req, res) => {
    try { res.json({ ok: true, key: watchUrl(String(req.body.url || '').trim(), req.user) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  const mySettings = user => ({ user, transport: !!settings.getUser(user, 'transport'), myNtfyUrl: settings.getUser(user, 'ntfyUrl') || '', base: baseOf(user)?.name, bases: bases().map(b => b.name),
    digestHour: settings.getUser(user, 'digestHour') ?? config.digestHour, digestTz: settings.getUser(user, 'digestTz') || config.digestTz,
    digestOn: !settings.getUser(user, 'digestOff') });
  app.get('/api/settings', (req, res) => res.json({ ...settings.publicView(), ...mySettings(req.user) }));
  app.post('/api/settings', (req, res) => {
    const b = req.body || {};
    const patch = {};
    if (typeof b.anthropicKey === 'string' && b.anthropicKey.trim()) {
      if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(b.anthropicKey.trim())) return res.status(400).json({ error: 'That does not look like a Claude API key (it should start with sk-ant-).' });
      patch.anthropicKey = b.anthropicKey;
    }
    if (b.clearKey) patch.anthropicKey = '';
    if (typeof b.ntfyUrl === 'string') {
      if (b.ntfyUrl && !/^https:\/\/\S+$/.test(b.ntfyUrl.trim())) return res.status(400).json({ error: 'The alert link should start with https://' });
      patch.ntfyUrl = b.ntfyUrl;
    }
    if (b.researchPerDay != null) patch.researchPerDay = Math.max(0, Math.min(1000, Number(b.researchPerDay) || 0));
    if (b.researchEnabled != null) patch.researchEnabled = !!b.researchEnabled;
    if (typeof b.myNtfyUrl === 'string') {
      if (b.myNtfyUrl && !/^https:\/\/\S+$/.test(b.myNtfyUrl.trim())) return res.status(400).json({ error: 'Your alert link should start with https://' });
      settings.setUser(req.user, { ntfyUrl: b.myNtfyUrl });
    }
    if (typeof b.base === 'string' && bases().some(x => x.name === b.base)) settings.setUser(req.user, { base: b.base });
    if (b.digestHour != null && Number(b.digestHour) >= 0 && Number(b.digestHour) <= 23) settings.setUser(req.user, { digestHour: Number(b.digestHour) });
    if (typeof b.digestTz === 'string' && /^(Australia|Asia|Pacific|Europe|America)\/[A-Za-z_]+$/.test(b.digestTz)) settings.setUser(req.user, { digestTz: b.digestTz });
    if (b.digestOn != null) settings.setUser(req.user, { digestOff: !b.digestOn });
    if (b.transport != null) settings.setUser(req.user, { transport: !!b.transport });
    settings.set(patch);
    res.json({ ...settings.publicView(), ...mySettings(req.user) });
  });
  app.post('/api/settings/test-key', async (_req, res) => {
    const key = settings.get('anthropicKey');
    if (!key) return res.json({ ok: false, error: 'No key saved yet.' });
    try { res.json({ ok: await testKey(key) }); } catch (e) { res.json({ ok: false, error: e.message.slice(0, 200) }); }
  });
  // What similar lots sold for here
  app.get('/api/lots/:key/history', (req, res) => {
    const lot = q.lot.get(req.params.key);
    if (!lot) return res.status(404).json({ error: 'Lot not found' });
    res.json(soldLike(lot) || typeLike(lot) || { n: 0, examples: [] });
  });
  app.post('/api/lots/:key/check', async (req, res) => {
    const lot = q.lot.get(req.params.key);
    if (!lot) return res.status(404).json({ error: 'Lot not found' });
    try { res.json({ ok: true, result: await checkListing(lot) }); } catch (e) { res.status(400).json({ error: e.message.slice(0, 200) }); }
  });
  // Bid panel: what a given bid really costs, and the most you can bid for a budget
  app.get('/api/lots/:key/cost', (req, res) => {
    const lot = q.lot.get(req.params.key);
    if (!lot) return res.status(404).json({ error: 'Lot not found' });
    const view = viewOf(req.user);
    const bid = Number(String(req.query.bid ?? '').replace(/[$,\s]/g, ''));
    const budget = Number(String(req.query.budget ?? '').replace(/[$,\s]/g, ''));
    const mine = q.myWatchKeys.all(req.user).find(w => w.key === lot.key);
    res.json({
      current: allIn(lot, view.base, undefined, view), atBid: bid > 0 ? allIn(lot, view.base, bid, view) : null,
      maxForBudget: budget > 0 ? maxBidFor(lot, view.base, budget, view) : null,
      myBid: mine?.my_bid ?? null, status: mine?.my_bid != null ? bidStatus(lot, mine.my_bid) : null,
      rivals: q.rivals.all(lot.key, req.user).map(r => ({ user: r.user, myBid: r.my_bid })), transport: view.transport,
    });
  });
  app.get('/api/digest/preview', (req, res) => res.json({ text: buildDigest(req.user) }));
  app.post('/api/lots/:key/research', async (req, res) => {
    const lot = q.lot.get(req.params.key);
    if (!lot) return res.status(404).json({ error: 'Lot not found' });
    try { res.json({ ok: true, result: await researchLot(lot) }); } catch (e) { res.status(400).json({ error: e.message.slice(0, 200) }); }
  });
  app.get('/api/status', (_req, res) => res.json({ sites: q.statusAll.all(), alerts: q.recentAlerts.all(), ai: !!settings.get('anthropicKey'), push: !!settings.get('ntfyUrl') }));
  app.get('/api/lots/:key/bids', (req, res) => res.json(q.bidHistory.all(req.params.key)));
  app.post('/api/lots/:key/star', (req, res) => {
    if (!q.lot.get(req.params.key)) return res.status(404).json({ error: 'Lot not found' });
    (req.body.starred ? watch : unwatch)(req.user, req.params.key);
    res.json({ ok: true });
  });
  // "I'm bidding: my max is $5,000" (null clears it)
  app.post('/api/lots/:key/mybid', (req, res) => {
    const raw = req.body.value;
    const v = raw === '' || raw == null ? null : Number(String(raw).replace(/[$,\s]/g, ''));
    if (v != null && !(v > 0)) return res.status(400).json({ error: 'Enter your bid in dollars, e.g. 5000.' });
    if (!q.lot.get(req.params.key)) return res.status(404).json({ error: 'Lot not found' });
    const rivals = setMyBid(req.user, req.params.key, v);
    warnRivals(req.user, req.params.key, v).catch(e => log.warn('alert', e.message));
    res.json({ ok: true, rivals: rivals.map(r => ({ user: r.user, myBid: r.my_bid })) });
  });
  app.post('/api/lots/:key/estimate', (req, res) => {
    const v = req.body.value === '' || req.body.value == null ? null : Number(req.body.value);
    if (v != null && !(v >= 0)) return res.status(400).json({ error: 'bad value' });
    q.manualEstimate.run(v, req.params.key);
    res.json({ ok: true });
  });
  app.post('/api/test-alert', async (req, res) => {
    const ok = await push({ to: req.user, title: 'KAMRADS test alert', message: 'If you can read this on your phone, alerts are working.', url: config.dashboardPublicUrl || undefined, priority: 'default', tags: 'satellite' });
    res.json({ ok, configured: !!settings.get('ntfyUrl') });
  });

  app.listen(config.port, config.host, () => log.info('web', `dashboard on http://${config.host}:${config.port} · logins: ${Object.keys(config.users).join(', ') || 'NONE (no DASH_PASS set)'}`));
}
