// /api/v1: what Katara Freight (katarafreight.com.au/tools) reads. Machine-to-machine, so it uses a key
// ("Authorization: Bearer <key>") instead of the dashboard logins. Only quotes, nothing else.
//   GET  /api/v1/quotes?status=won,quoted&since=<ISO>   quotes (default: quoted and won)
//   GET  /api/v1/quotes/:id
//   POST /api/v1/quotes/:id/convert  { jobId, jobNo, url }   a job was made from it (safe to repeat)
import crypto from 'node:crypto';
import express from 'express';
import * as settings from '../settings.js';
import { config } from '../config.js';
import { listQuotes, getQuote, convert, quoteOut, QUOTE_STATUSES } from './quotes.js';
import { log } from '../log.js';

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** A new shared key. Shown once in the dashboard; kept in data/settings.json (like the Claude key) because we
 *  also use it to authenticate what we send to Katara Freight. */
export function newApiKey(user) {
  const key = 'kmr_' + crypto.randomBytes(24).toString('base64url');
  settings.set({ freightApiKey: key, freightApiKeyHash: sha(key), freightApiKeyAt: Date.now(), freightApiKeyBy: user, freightApiKeyTail: key.slice(-4) });
  return key;
}
export function revokeApiKey() { settings.set({ freightApiKey: '', freightApiKeyHash: '', freightApiKeyAt: null, freightApiKeyTail: '' }); }
/** The key in use (dashboard-made, else FREIGHT_API_KEY from .env). */
export const sharedKey = () => settings.get('freightApiKey') || config.freight.apiKey || '';
export function apiKeyInfo() {
  return { set: !!(settings.get('freightApiKeyHash') || config.freight.apiKey), fromEnv: !!config.freight.apiKey,
    madeAt: settings.get('freightApiKeyAt') || null, madeBy: settings.get('freightApiKeyBy') || null, tail: settings.get('freightApiKeyTail') || null,
    lastUsed: settings.get('freightApiLastUsed') || null };
}

function keyAuth(req, res, next) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  const hashes = [settings.get('freightApiKeyHash'), config.freight.apiKey && sha(config.freight.apiKey)].filter(Boolean);
  if (!hashes.length) return res.status(503).json({ ok: false, error: 'No API key set up yet. Make one on the KAMRADS Freight screen.' });
  if (!m || !hashes.some(h => same(sha(m[1]), h))) {
    log.warn('api', `refused ${req.method} ${req.path} from ${req.ip}`);
    return res.status(401).json({ ok: false, error: 'Bad or missing API key' });
  }
  const last = settings.get('freightApiLastUsed') || 0;
  if (Date.now() - last > 60000) settings.set({ freightApiLastUsed: Date.now() });   // don't rewrite settings on every call
  next();
}

export function apiRoutes(app) {
  const r = express.Router();
  r.use(keyAuth);
  r.use((_req, res, next) => { res.set('cache-control', 'no-store'); next(); });
  const baseOf = req => `${String(req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim()}://${req.get('host')}`;

  r.get('/quotes', (req, res) => {
    const want = String(req.query.status || 'quoted,won').split(',').map(s => s.trim()).filter(s => QUOTE_STATUSES.includes(s) || s === 'all');
    const since = req.query.since ? Date.parse(String(req.query.since)) : null;
    if (req.query.since && !Number.isFinite(since)) return res.status(400).json({ ok: false, error: 'since should be an ISO date' });
    const rows = listQuotes({ statuses: want.includes('all') ? null : want, since });
    res.json({ ok: true, now: new Date().toISOString(), quotes: rows.map(q => quoteOut(q, { base: baseOf(req) })) });
  });
  r.get('/quotes/:id', (req, res) => {
    const q = getQuote(Number(req.params.id));
    if (!q) return res.status(404).json({ ok: false, error: 'Quote not found' });
    res.json({ ok: true, quote: quoteOut(q, { base: baseOf(req) }) });
  });
  r.post('/quotes/:id/convert', (req, res) => {
    const out = convert(Number(req.params.id), req.body || {});
    if (out.error) return res.status(out.status).json({ ok: false, error: out.error, quote: out.quote ? quoteOut(out.quote, { base: baseOf(req) }) : undefined });
    log.info('api', `quote ${req.params.id} → job ${req.body?.jobNo || req.body?.jobId}${out.already ? ' (already linked)' : ''}`);
    res.json({ ok: true, already: !!out.already, quote: quoteOut(out.quote, { base: baseOf(req) }) });
  });
  r.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found' }));
  app.use('/api/v1', r);
}
