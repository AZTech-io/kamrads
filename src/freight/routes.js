// Freight board API + page (/freight). Same logins as the auction dashboard.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fq } from './store.js';
import { fit, ends, describe } from './match.js';
import { geocodeNow, haversineKm, baseByName } from '../geo.js';
import { config } from '../config.js';
import * as settings from '../settings.js';
import { freightSites } from './sites.js';
import { scanFreight, sweepFreight } from './loop.js';
import { TIERS, tierOf, postedOf, dateFlag } from './heat.js';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));

export const OUTCOMES = ['no answer', 'left message', 'still needed', 'quoted', 'booked', 'already moved', 'not interested', 'wrong number'];
// outcomes that take a job off the board (it's done, one way or another)
const DEAD = ['already moved', 'not interested', 'wrong number'];
const cleanPhone = s => { const t = String(s || '').replace(/[^\d+]/g, ''); return t.length >= 8 ? t.slice(0, 16) : null; };
const name1 = u => (u ? u[0].toUpperCase() + u.slice(1) : u);

const shapeJob = (j, alerts, plan, base, last, nContacts, now = Date.now()) => {
  const p = postedOf(j);
  const e = ends(j);
  const fits = alerts.map(a => ({ a, f: fit(j, a, e) })).filter(x => x.f).map(x => ({ id: x.a.id, name: x.a.name || describe(x.a), how: x.f.how, extra: x.f.extra ?? null }));
  const jobKm = j.km ?? (e.from && e.to ? Math.round(haversineKm([e.from.lat, e.from.lon], [e.to.lat, e.to.lon]) * 1.25) : null);
  return {
    key: j.key, site: j.site, url: j.url, title: j.title, category: j.category, price: j.price, priceKind: j.price_kind,
    from: j.from_text, to: j.to_text, fromState: e.from?.state ?? null, toState: e.to?.state ?? null, located: !!e.from,
    km: jobKm, perKm: j.price != null && jobKm ? Math.round((j.price / jobKm) * 100) / 100 : null,
    postedAt: p.at, postedApprox: p.approx, ageBasis: j.age_basis, firstSeen: j.first_seen, lastSeen: j.last_seen, offers: j.offers, due: j.due_text,
    heat: tierOf(j, now), dates: dateFlag(j, now), dateFrom: j.date_from, dateBy: j.date_by,
    contactName: j.contact_name, contactPhone: j.contact_phone, dead: !!j.dead,
    contact: last ? { by: name1(last.user), at: last.at, outcome: last.outcome, method: last.method, quote: last.quote, n: nContacts || 1 } : null,
    fromBase: base && e.from ? Math.round(haversineKm([base.lat, base.lon], [e.from.lat, e.from.lon]) * 1.25) : null,
    fits, plan: plan ? fit(j, plan, e) : null,
  };
};

export function freightRoutes(app) {
  app.get('/freight', (_req, res) => res.sendFile(path.join(here, '..', '..', 'public', 'freight.html')));

  app.get('/api/freight/jobs', async (req, res) => {
    const now = Date.now();
    // heat=ultra,hot (default: everything still listed). hours= is the old age filter, kept for links.
    const want = new Set(String(req.query.heat || '').split(',').filter(k => TIERS.some(t => t.key === k) || k === 'unknown'));
    const hours = Number(req.query.hours) || null;
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
    const last = new Map(fq.lastContacts.all().map(c => [c.job_key, c]));
    const nc = new Map(fq.contactCounts.all().map(c => [c.job_key, c.n]));
    const showDead = req.query.dead === '1';
    const heat = { ultra: 0, hot: 0, warm: 0, luke: 0, cold: 0, unknown: 0 };
    const out = [];
    let dead = 0;
    for (const j of fq.open.all()) {
      if (j.dead && !showDead) { dead++; continue; }
      const t = tierOf(j, now);
      heat[t]++;
      if (want.size && !want.has(t)) continue;
      if (hours && (postedOf(j).at ?? j.first_seen) < now - hours * 3600000) continue;
      out.push(shapeJob(j, alerts, plan, base, last.get(j.key), nc.get(j.key), now));
    }
    const body = JSON.stringify({ now, base: base?.name, planErr, heat, dead, tiers: TIERS.map(t => ({ key: t.key, label: t.label })), jobs: out });
    // a few thousand jobs: send it compressed when the browser can take it
    if (/\bgzip\b/.test(req.get('accept-encoding') || '') && body.length > 20000) {
      res.set({ 'content-type': 'application/json; charset=utf-8', 'content-encoding': 'gzip', vary: 'accept-encoding' });
      return res.send(zlib.gzipSync(body, { level: 6 }));
    }
    res.type('json').send(body);
  });

  // ---- Contacting shippers about a job: their details (typed in from the board), message, call log ----
  const jobOr404 = (req, res) => { const j = fq.job.get(req.params.key); if (!j) res.status(404).json({ error: 'Job not found' }); return j; };
  const contactView = j => ({ key: j.key, name: j.contact_name, phone: j.contact_phone, dead: !!j.dead,
    log: fq.contactsOf.all(j.key).map(c => ({ id: c.id, by: name1(c.user), at: c.at, method: c.method, outcome: c.outcome, quote: c.quote, note: c.note })) });
  app.get('/api/freight/jobs/:key/contact', (req, res) => { const j = jobOr404(req, res); if (j) res.json({ ...contactView(j), outcomes: OUTCOMES }); });
  app.post('/api/freight/jobs/:key/contact', (req, res) => {
    const j = jobOr404(req, res); if (!j) return;
    const b = req.body || {};
    if ('name' in b || 'phone' in b) {
      const phone = 'phone' in b ? (b.phone ? cleanPhone(b.phone) : null) : j.contact_phone;
      if (b.phone && !phone) return res.status(400).json({ error: 'That phone number looks too short.' });
      fq.setContact.run('name' in b ? String(b.name || '').trim().slice(0, 80) || null : j.contact_name, phone, j.key);
    }
    if (b.outcome || b.note || b.method) {
      const outcome = OUTCOMES.includes(b.outcome) ? b.outcome : null;
      const quote = b.quote === '' || b.quote == null ? null : Number(String(b.quote).replace(/[$,\s]/g, '')) || null;
      fq.addContact.get(j.key, req.user, Date.now(), ['call', 'text', 'message', 'email'].includes(b.method) ? b.method : null, outcome, quote, String(b.note || '').trim().slice(0, 300) || null);
      if (DEAD.includes(outcome)) fq.setDead.run(1, j.key);
      else if (outcome) fq.setDead.run(0, j.key);
    }
    if (b.dead != null) fq.setDead.run(b.dead ? 1 : 0, j.key);
    res.json(contactView(fq.job.get(j.key)));
  });
  app.delete('/api/freight/jobs/:key/contact/:id', (req, res) => {
    const j = jobOr404(req, res); if (!j) return;
    fq.delContact.run(Number(req.params.id), j.key);
    res.json(contactView(j));
  });

  // The message we send shippers (per login), with {name} {me} {item} {from} {to} {site} {day} {booking}
  const DEFAULT_MSG = "Hi{name}, it's {me} from Katara. Saw your {item} job from {from} to {to} on {site}. We've got a truck doing that run {day}. Do you still need it moved?{booking}";
  app.get('/api/freight/message', (req, res) => res.json({ template: settings.getUser(req.user, 'freightMsg') || DEFAULT_MSG, def: DEFAULT_MSG,
    me: settings.getUser(req.user, 'freightName') || name1(req.user), day: settings.getUser(req.user, 'freightDay') || '' }));
  app.post('/api/freight/message', (req, res) => {
    const b = req.body || {};
    const patch = {};
    if (typeof b.template === 'string') patch.freightMsg = b.template.trim() === DEFAULT_MSG ? '' : b.template.slice(0, 600);
    if (typeof b.me === 'string') patch.freightName = b.me.slice(0, 40);
    if (typeof b.day === 'string') patch.freightDay = b.day.slice(0, 40);
    settings.setUser(req.user, patch);
    res.json({ ok: true });
  });

  app.get('/api/freight/status', (_req, res) => res.json({ sites: fq.statusAll.all(), stats: fq.stats.get(), sweep: config.freight.sweep.enabled,
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
  // Read Truckit and Loadshift in full now, instead of waiting for tonight
  app.post('/api/freight/sweep', (_req, res) => {
    if (!scanning) { scanning = true; sweepFreight({ force: true }).finally(() => { scanning = false; }); }
    res.json({ ok: true });
  });
}
