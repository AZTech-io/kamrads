import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { q } from './db.js';
import { estimateOf } from './alerts.js';
import { isVehicle } from './extract.js';
import { push } from './notify.js';
import { watchUrl } from './scheduler.js';
import { log } from './log.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function basicAuth(req, res, next) {
  if (!config.dashPass) return next();
  const [type, b64] = (req.headers.authorization || '').split(' ');
  if (type === 'Basic' && b64) {
    const [u, ...p] = Buffer.from(b64, 'base64').toString().split(':');
    if (u === config.dashUser && p.join(':') === config.dashPass) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="KAMRADS"').status(401).send('Login required');
}

const shape = (l, alertKinds) => {
  const est = estimateOf(l);
  const price = l.bid ?? l.start_price;
  return {
    key: l.key, site: l.site, url: l.url, title: l.title, image: l.image, category: l.category,
    year: l.year, odometer: l.odometer, wovr: l.wovr, location: l.location, state: l.state,
    buyMethod: l.buy_method, sale: l.sale_name, lotNo: l.lot_no,
    bid: l.bid, bidCount: l.bid_count, startPrice: l.start_price, buyNow: l.buy_now,
    endAt: l.end_at, lastChecked: l.last_checked, starred: !!l.starred,
    estLow: l.est_low, estHigh: l.est_high, estNote: l.est_note, manualEstimate: l.manual_estimate,
    estimate: est, ratio: est && price != null ? price / est : null,
    profit: est && price != null ? est - price : null,
    vehicle: isVehicle(l), alerts: alertKinds.get(l.key) || [],
  };
};

export function startServer() {
  const app = express();
  app.use(express.json());
  app.get('/healthz', (_req, res) => res.send('ok'));
  app.use(basicAuth);
  app.use(express.static(path.join(here, '..', 'public')));

  app.get('/api/lots', (req, res) => {
    const now = Date.now();
    const hours = Math.min(Number(req.query.hours) || 48, 24 * 14);
    const rows = q.dashboard.all(now - 60000, now + hours * 3600000, 3000);
    const alertKinds = new Map();
    for (const a of q.alertKinds.all(now - 7 * 86400000)) alertKinds.set(a.key, [...(alertKinds.get(a.key) || []), a.kind]);
    res.json({ now, lots: rows.map(l => shape(l, alertKinds)) });
  });
  app.get('/api/closed', (req, res) => {
    const hours = Math.min(Number(req.query.hours) || 24, 24 * 90);
    const rows = q.recentClosed.all(Date.now() - hours * 3600000);
    res.json({ now: Date.now(), lots: rows.map(l => {
      const out = shape({ ...l, bid: l.final_bid }, new Map());
      out.finalBid = l.final_bid;
      out.closedAt = l.closed_at;
      // How close to the end our last look was: 0-1 min = the real hammer price, more = it may have gone higher.
      out.seenMinsBeforeClose = l.final_seen_at && l.end_at ? Math.max(0, Math.round((l.end_at - l.final_seen_at) / 60000)) : null;
      return out;
    }) });
  });
  app.get('/api/watchlist', (_req, res) => {
    const now = Date.now();
    const alertKinds = new Map();
    for (const a of q.alertKinds.all(now - 7 * 86400000)) alertKinds.set(a.key, [...(alertKinds.get(a.key) || []), a.kind]);
    res.json({ now, every: config.watchEverySec, lots: q.watchlist.all(now - 24 * 3600000).map(l => ({
      ...shape(l.status === 'closed' ? { ...l, bid: l.final_bid ?? l.bid } : l, alertKinds),
      status: l.status, finalBid: l.final_bid, closedAt: l.closed_at,
      seenMinsBeforeClose: l.final_seen_at && l.end_at ? Math.max(0, Math.round((l.end_at - l.final_seen_at) / 60000)) : null,
    })) });
  });
  app.post('/api/watch', (req, res) => {
    try { res.json({ ok: true, key: watchUrl(String(req.body.url || '').trim()) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/api/status', (_req, res) => res.json({ sites: q.statusAll.all(), alerts: q.recentAlerts.all(), ai: !!config.anthropicKey, push: !!config.ntfyUrl }));
  app.get('/api/lots/:key/bids', (req, res) => res.json(q.bidHistory.all(req.params.key)));
  app.post('/api/lots/:key/star', (req, res) => { q.star.run(req.body.starred ? 1 : 0, req.params.key); res.json({ ok: true }); });
  app.post('/api/lots/:key/estimate', (req, res) => {
    const v = req.body.value === '' || req.body.value == null ? null : Number(req.body.value);
    if (v != null && !(v >= 0)) return res.status(400).json({ error: 'bad value' });
    q.manualEstimate.run(v, req.params.key);
    res.json({ ok: true });
  });
  app.post('/api/test-alert', async (_req, res) => {
    const ok = await push({ title: 'KAMRADS test alert', message: 'If you can read this on your phone, alerts are working.', url: config.dashboardPublicUrl || undefined, priority: 'default', tags: 'satellite' });
    res.json({ ok, configured: !!config.ntfyUrl });
  });

  app.listen(config.port, config.host, () => log.info('web', `dashboard on http://${config.host}:${config.port}${config.dashPass ? '' : ' (WARNING: no DASH_PASS set)'}`));
}
