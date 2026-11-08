// Cruises screen (/cruises) and its API. Cruises are shared; each person has their own filters and red-hot level.
import { sendPage } from '../pages.js';
import { config } from '../config.js';
import { PORTS, PORT_KEYS, portUrl, cardsFromPageText } from './parse.js';
import { cz } from './store.js';
import { scanCruises, saveCruises, primeAlerts, todayYmd } from './loop.js';
import { viewOf, hasView, saveView, cleanView, defaultView } from './view.js';

const json = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const shape = c => ({
  key: c.key, code: c.code, url: c.url || (PORT_KEYS[c.port] ? portUrl(PORT_KEYS[c.port].slug) : null), direct: !!c.url,
  title: c.title, ship: c.ship, line: c.line, port: c.port, nights: c.nights, depart: c.depart,
  twin: c.twin, triple: c.triple, quad: c.quad, solo: c.solo, fares: json(c.fares) || [], badge: c.badge,
  firstSeen: c.first_seen, lastSeen: c.last_seen, firstTwin: c.first_twin, lowTwin: c.low_twin, prevTwin: c.prev_twin, priceAt: c.price_at, pasted: c.src === 'paste',
});

export function cruisesRoutes(app) {
  app.get('/cruises', (req, res) => sendPage(res, 'cruises.html', req.user));

  app.get('/api/cruises', (req, res) => {
    // first visit: start with the defaults, and what's red hot right now doesn't buzz the phone (it's on the screen)
    if (!hasView(req.user)) { saveView(req.user, defaultView()); primeAlerts(req.user); }
    const status = new Map(cz.statusAll.all().map(s => [s.port, s]));
    const cruises = cz.open.all(todayYmd()).map(shape);
    const ports = config.cruises.ports.filter(s => PORTS[s]).map(slug => {
      const p = PORTS[slug], st = status.get(slug) || {};
      return { key: p.key, slug, name: p.name, short: p.short, url: portUrl(slug), lastOk: st.last_ok ?? null, lastCount: st.last_count ?? null,
        error: st.last_error_at && (!st.last_ok || st.last_error_at > st.last_ok) ? st.last_error : null };
    });
    res.json({ cruises, view: viewOf(req.user), ports, everyMin: config.cruises.everyMin, enabled: config.cruises.enabled, hotDefault: config.cruises.hotPerNight, now: Date.now() });
  });

  app.post('/api/cruises/view', (req, res) => {
    const before = viewOf(req.user);
    const v = cleanView(req.body || {}, before);
    saveView(req.user, v);
    // filters or red-hot level changed: what now shows as red hot is on screen already, so only later ones push
    const reach = ['ports', 'line', 'len', 'maxPrice', 'maxNight', 'within', 'share', 'hot'].some(k => JSON.stringify(before[k]) !== JSON.stringify(v[k]));
    if (reach || (v.alerts && !before.alerts)) primeAlerts(req.user);
    res.json({ ok: true, view: v });
  });

  app.post('/api/cruises/scan', (_req, res) => { scanCruises().catch(() => {}); res.json({ ok: true }); });

  // A page copied off OzCruising by hand (Ctrl+A, Ctrl+C) when the hourly read can't get it
  app.post('/api/cruises/paste', (req, res) => {
    const text = String(req.body?.text || '');
    if (text.length < 40) return res.status(400).json({ error: 'Paste the whole page: on OzCruising press Ctrl+A then Ctrl+C.' });
    const port = PORT_KEYS[req.body?.port] ? req.body.port : null;
    const recs = cardsFromPageText(text, { portKey: port }).map(r => ({ ...r, port: r.port || port }));
    if (!recs.length) return res.status(400).json({ error: "No cruises found in that. It needs each cruise's nights and price, e.g. \"7 nights\" and \"Twin From $899 pp\"." });
    if (recs.some(r => !r.port)) return res.status(400).json({ error: 'Pick which port these cruises leave from.' });
    const fresh = saveCruises(recs, 'paste');
    res.json({ ok: true, read: recs.length, fresh });
  });

  app.get('/api/cruises/history/:key', (req, res) => {
    const c = cz.get.get(req.params.key);
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json({ cruise: shape(c), history: cz.history.all(c.key) });
  });
}
