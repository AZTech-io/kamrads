// Finds screen (/finds) and its API. Searches belong to the person who made them; listings are shared.
import { fz } from './store.js';
import { fitsSearch, auctionMatches, SOURCES, SOURCE_NAMES } from './match.js';
import { fbAreaFromLink, sourceOn, ebay } from './sources.js';
import { scanFinds } from './loop.js';
import { geocodeNow, baseByName } from '../geo.js';
import { photo } from '../photos.js';
import { sendPage } from '../pages.js';
import * as settings from '../settings.js';
import { config } from '../config.js';
import { allIn } from '../costs.js';
import { db } from '../db.js';

const num = v => (v === '' || v == null ? null : Number(String(v).replace(/[$,\s]/g, '')));
const DAY = 864e5;

/** Validate + geocode an add/edit form. */
async function readForm(b) {
  const terms = String(b.terms || '').trim().slice(0, 300);
  if (!/[a-z0-9]/i.test(terms.replace(/(^|\s)-\S+/g, ''))) throw new Error('Type what to look for, e.g. "vending machine, snack machine".');
  const place = String(b.place || '').trim().slice(0, 80);
  let p = null;
  if (place) { p = await geocodeNow(place); if (!p || p.approx) throw new Error(`Couldn't find "${place}". Try the suburb and state, e.g. "Fyshwick ACT".`); }
  const radius = place ? Math.max(1, Math.min(4000, num(b.radius) || 100)) : null;
  const sources = (Array.isArray(b.sources) ? b.sources : String(b.sources || SOURCES.join(',')).split(',')).filter(x => SOURCES.includes(x));
  if (!sources.length) throw new Error('Pick at least one site to search.');
  const fbLink = String(b.fbLink || '').trim();
  const fb = fbLink ? fbAreaFromLink(fbLink) || (/^[a-z0-9-]{3,40}$/i.test(fbLink) ? fbLink : null) : null;
  if (fbLink && !fb) throw new Error('That Facebook link has no Marketplace area in it. Open Marketplace for your area and copy the link.');
  return { name: String(b.name || '').trim().slice(0, 60) || null, terms, place: place || null, lat: p?.lat ?? null, lon: p?.lon ?? null, state: p?.state ?? null,
    radius, min: num(b.minPrice), max: num(b.maxPrice), sources: sources.join(','), fb, alerts: b.alerts === false || b.alerts === 0 ? 0 : 1 };
}

const shapeSearch = s => ({ id: s.id, name: s.name || s.terms, terms: s.terms, place: s.place, radius: s.radius_km, minPrice: s.min_price, maxPrice: s.max_price,
  sources: String(s.sources || '').split(',').filter(Boolean), fbArea: s.fb_area, alerts: !!s.alerts, scanned: !!s.scanned_at });

function results(s, now = Date.now()) {
  const hits = new Map(fz.hitsOf.all(s.id).map(h => [h.key, h]));
  const items = [];
  for (const it of fz.open.all()) {
    const f = fitsSearch(s, it);
    if (!f) continue;
    const posted = it.posted_at ?? it.first_seen;
    items.push({ key: it.key, site: it.site, siteName: SOURCE_NAMES[it.site], url: it.url, title: it.title, price: it.price, location: it.location, km: f.km,
      postedAt: posted, postedApprox: it.posted_at == null, firstSeen: it.first_seen, photo: it.image ? `/photo/find/${encodeURIComponent(it.key)}` : null,
      fresh: now - it.first_seen < DAY, alerted: hits.get(it.key)?.notified === 0 });
  }
  items.sort((a, b) => b.postedAt - a.postedAt);
  const lots = auctionMatches(s, now).slice(0, 80).map(({ l, km }) => {
    const price = l.bid ?? l.start_price;
    return { key: l.key, site: l.site, url: l.url, title: l.title, bid: l.bid, price, endAt: l.end_at, location: [l.location, l.location && l.state && new RegExp(`\\b${l.state}\\b`).test(l.location) ? '' : l.state].filter(Boolean).join(' '), km,
      allIn: price != null ? allIn(l, null, price)?.landed ?? null : null, photo: l.image ? `/photo/${encodeURIComponent(l.key)}` : null, bidCount: l.bid_count };
  });
  return { items, lots };
}

/** First visit: a "Vending machines" search around the person's base, so there's something to look at straight away. */
async function seed(user) {
  if (settings.getUser(user, 'findsSeeded')) return;
  settings.setUser(user, { findsSeeded: true });
  if (fz.searchesOf.all(user).length) return;
  const base = baseByName(settings.getUser(user, 'base'));
  const now = Date.now();
  const { id } = fz.addSearch.get(user, 'Vending machines', 'vending machine -toy -miniature, snack machine, drink vending machine',
    base?.name || null, base?.lat ?? null, base?.lon ?? null, base?.state ?? (/\b(ACT|NSW|VIC|QLD|WA|SA|TAS|NT)\b/.exec(base?.name || '') || [])[1] ?? null,
    base ? 300 : null, null, null, SOURCES.join(','), null, 1, now, now);
  scanFinds({ only: id }).catch(() => {});
}

export function findsRoutes(app) {
  app.get('/finds', (req, res) => sendPage(res, 'finds.html', req.user));

  app.get('/api/finds/searches', async (req, res) => {
    await seed(req.user);
    const now = Date.now();
    const list = fz.searchesOf.all(req.user).map(s => {
      const r = results(s, now);
      return { ...shapeSearch(s), count: r.items.length, fresh: r.items.filter(i => now - i.firstSeen < DAY).length, auctions: r.lots.length };
    });
    res.json({ searches: list, now });
  });

  app.get('/api/finds/searches/:id', (req, res) => {
    const s = fz.search.get(Number(req.params.id));
    if (!s || s.user !== req.user) return res.status(404).json({ error: 'Search not found' });
    res.json({ search: shapeSearch(s), ...results(s), now: Date.now() });
  });

  app.post('/api/finds/searches', async (req, res) => {
    try {
      const f = await readForm(req.body || {});
      const now = Date.now();
      const { id } = fz.addSearch.get(req.user, f.name, f.terms, f.place, f.lat, f.lon, f.state, f.radius, f.min, f.max, f.sources, f.fb, f.alerts, now, now);
      scanFinds({ only: id }).catch(() => {});
      res.json({ ok: true, id });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.patch('/api/finds/searches/:id', async (req, res) => {
    const s = fz.search.get(Number(req.params.id));
    if (!s || s.user !== req.user) return res.status(404).json({ error: 'Search not found' });
    try {
      const b = req.body || {};
      // just switching alerts on or off
      if (Object.keys(b).length === 1 && 'alerts' in b) { db.prepare('UPDATE find_searches SET alerts = ?, updated_at = ? WHERE id = ?').run(b.alerts ? 1 : 0, Date.now(), s.id); return res.json({ ok: true }); }
      const f = await readForm({ ...shapeSearch(s), fbLink: s.fb_area || '', minPrice: s.min_price, maxPrice: s.max_price, ...b });
      const reach = f.terms !== s.terms || f.place !== s.place || f.radius !== s.radius_km || f.sources !== s.sources || f.fb !== s.fb_area;
      db.prepare(`UPDATE find_searches SET name = ?, terms = ?, place = ?, lat = ?, lon = ?, state = ?, radius_km = ?, min_price = ?, max_price = ?, sources = ?, fb_area = ?, alerts = ?, updated_at = ?
        ${reach ? ', scanned_at = NULL, primed = 0' : ''} WHERE id = ?`).run(f.name, f.terms, f.place, f.lat, f.lon, f.state, f.radius, f.min, f.max, f.sources, f.fb, f.alerts, Date.now(), s.id);
      // a wider/different search starts over: what's already out there doesn't buzz the phone
      if (reach) { fz.delHits.run(s.id); scanFinds({ only: s.id }).catch(() => {}); }
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.delete('/api/finds/searches/:id', (req, res) => {
    const r = fz.delSearch.run(Number(req.params.id), req.user);
    if (r.changes) fz.delHits.run(Number(req.params.id));
    res.json({ ok: true });
  });

  app.get('/api/finds/status', (_req, res) => {
    const st = new Map(fz.statusAll.all().map(s => [s.site, s]));
    res.json({ sources: SOURCES.map(k => ({ site: k, label: SOURCE_NAMES[k], on: sourceOn(k), needsKeys: k === 'ebay' && !ebay.enabled(), ...(st.get(k) || {}) })), everyMin: config.finds.everyMin });
  });

  app.post('/api/finds/scan', (_req, res) => { scanFinds().catch(() => {}); res.json({ ok: true }); });

  // listing photos come through us (cached), like auction photos: only listings we've found
  app.get('/photo/find/:key', async (req, res) => {
    try {
      const it = fz.item.get(req.params.key);
      const p = it ? await photo({ ...it, key: it.key }) : null;
      if (!p) return res.status(404).end();
      res.set({ 'content-type': p.type, 'cache-control': 'private, max-age=86400' }).sendFile(p.file);
    } catch { res.status(404).end(); }
  });
}
