// Freight board API + page (/freight). Same logins as the auction dashboard.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fq } from './store.js';
import { fit, ends, describe } from './match.js';
import { geocodeNow, haversineKm, baseByName } from '../geo.js';
import { config } from '../config.js';
import * as settings from '../settings.js';
import { freightSites } from './sites.js';
import { scanFreight } from './loop.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const shapeJob = (j, alerts, plan, base) => {
  const e = ends(j);
  const fits = alerts.map(a => ({ a, f: fit(j, a, e) })).filter(x => x.f).map(x => ({ id: x.a.id, name: x.a.name || describe(x.a), how: x.f.how, extra: x.f.extra ?? null }));
  const jobKm = j.km ?? (e.from && e.to ? Math.round(haversineKm([e.from.lat, e.from.lon], [e.to.lat, e.to.lon]) * 1.25) : null);
  return {
    key: j.key, site: j.site, url: j.url, title: j.title, category: j.category, price: j.price, priceKind: j.price_kind,
    from: j.from_text, to: j.to_text, fromState: e.from?.state ?? null, toState: e.to?.state ?? null, located: !!e.from,
    km: jobKm, perKm: j.price != null && jobKm ? Math.round((j.price / jobKm) * 100) / 100 : null,
    postedAt: j.posted_at ?? j.first_seen, firstSeen: j.first_seen, lastSeen: j.last_seen, offers: j.offers, due: j.due_text,
    fromBase: base && e.from ? Math.round(haversineKm([base.lat, base.lon], [e.from.lat, e.from.lon]) * 1.25) : null,
    fits, plan: plan ? fit(j, plan, e) : null,
  };
};

export function freightRoutes(app) {
  app.get('/freight', (_req, res) => res.sendFile(path.join(here, '..', '..', 'public', 'freight.html')));

  app.get('/api/freight/jobs', async (req, res) => {
    const now = Date.now();
    const hours = Math.min(Number(req.query.hours) || config.freight.keepHours, 24 * 14);
    const alerts = fq.alertsOf.all(req.user);
    let plan = null, planErr = null;
    if (req.query.a) {
      const A = await geocodeNow(String(req.query.a));
      const B = req.query.b ? await geocodeNow(String(req.query.b)) : null;
      if (!A || A.approx) planErr = `Couldn't find "${req.query.a}"`;
      else if (req.query.b && (!B || B.approx)) planErr = `Couldn't find "${req.query.b}"`;
      else plan = { kind: B ? 'route' : 'area', a_lat: A.lat, a_lon: A.lon, b_lat: B?.lat ?? null, b_lon: B?.lon ?? null,
        radius_km: Number(req.query.d) || (B ? 30 : 50), both_ways: req.query.both === '1' ? 1 : 0, min_price: null };
    }
    const base = baseByName(settings.getUser(req.user, 'base'));
    const jobs = fq.live.all(now - hours * 3600000).map(j => shapeJob(j, alerts, plan, base));
    res.json({ now, base: base?.name, planErr, jobs });
  });

  app.get('/api/freight/status', (_req, res) => res.json({ sites: fq.statusAll.all(), stats: fq.stats.get(),
    enabled: Object.values(freightSites).map(s => ({ site: s.site, label: s.label, on: !!config.freight[s.site]?.enabled })) }));

  app.get('/api/freight/alerts', (req, res) => {
    const counts = new Map(fq.counts.all(Date.now() - config.freight.keepHours * 3600000).map(c => [c.alert_id, c.n]));
    res.json(fq.alertsOf.all(req.user).map(a => ({ id: a.id, kind: a.kind, name: a.name || describe(a), a: a.a_text, b: a.b_text, radius: a.radius_km, bothWays: !!a.both_ways, minPrice: a.min_price, matches: counts.get(a.id) || 0 })));
  });

  app.post('/api/freight/alerts', async (req, res) => {
    const b = req.body || {};
    const aText = String(b.a || '').trim(), bText = String(b.b || '').trim();
    if (!aText) return res.status(400).json({ error: 'Type a place, e.g. Canberra.' });
    const A = await geocodeNow(aText);
    if (!A || A.approx) return res.status(400).json({ error: `Couldn't find "${aText}". Try the suburb and state, e.g. "Fyshwick ACT".` });
    let B = null;
    if (bText) { B = await geocodeNow(bText); if (!B || B.approx) return res.status(400).json({ error: `Couldn't find "${bText}".` }); }
    const radius = Math.max(1, Math.min(500, Number(b.radius) || (B ? 30 : 50)));
    const minPrice = b.minPrice === '' || b.minPrice == null ? null : Number(String(b.minPrice).replace(/[$,\s]/g, '')) || null;
    const { id } = fq.addAlert.get(req.user, B ? 'route' : 'area', String(b.name || '').trim().slice(0, 60) || null, aText, A.lat, A.lon,
      bText || null, B?.lat ?? null, B?.lon ?? null, radius, b.bothWays ? 1 : 0, minPrice, Date.now());
    res.json({ ok: true, id });
  });

  app.delete('/api/freight/alerts/:id', (req, res) => {
    const r = fq.delAlert.run(Number(req.params.id), req.user);
    if (r.changes) fq.delHits.run(Number(req.params.id));
    res.json({ ok: true });
  });

  let scanning = false;
  app.post('/api/freight/scan', (_req, res) => {
    if (!scanning) { scanning = true; scanFreight().finally(() => { scanning = false; }); }
    res.json({ ok: true });
  });
}
