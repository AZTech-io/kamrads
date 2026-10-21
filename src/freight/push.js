// Sends quotes to Katara Freight (katarafreight.com.au), where they land in Admin Tools > Quoted and a won one
// becomes a booked job in one click. Every change to a quote queues it; a small loop sends the queue, retrying
// with a growing wait if Katara Freight can't be reached. Their endpoint checks our shared key.
import { db } from '../db.js';
import { config } from '../config.js';
import * as settings from '../settings.js';
import { log } from '../log.js';
import { getQuote, quoteOut, listQuotes, onQuoteChange } from './quotes.js';
import { sharedKey } from './api.js';

db.exec(`CREATE TABLE IF NOT EXISTS quote_outbox (quote_id INTEGER PRIMARY KEY, due_at INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, last_error TEXT);`);
const oq = {
  put: db.prepare(`INSERT INTO quote_outbox (quote_id, due_at, tries) VALUES (?, ?, 0) ON CONFLICT(quote_id) DO UPDATE SET due_at = excluded.due_at, tries = 0, last_error = NULL`),
  due: db.prepare('SELECT * FROM quote_outbox WHERE due_at <= ? ORDER BY due_at LIMIT 50'),
  done: db.prepare('DELETE FROM quote_outbox WHERE quote_id = ?'),
  fail: db.prepare('UPDATE quote_outbox SET tries = tries + 1, due_at = ?, last_error = ? WHERE quote_id = ?'),
  count: db.prepare('SELECT count(*) AS n, max(last_error) AS err FROM quote_outbox'),
};

export const katUrl = () => (settings.get('katFreightUrl') || config.freight.katFreightUrl || '').replace(/\/+$/, '');
export const pushOn = () => !!(sharedKey() && katUrl());

/** Queue a quote to be sent (after any change to it). */
export function queueQuote(id) { if (id) oq.put.run(id, Date.now()); }
onQuoteChange(queueQuote);
export function queueAll() { const all = listQuotes(); for (const q of all) oq.put.run(q.id, Date.now()); return all.length; }
export const outboxInfo = () => { const r = oq.count.get(); return { queued: r.n, lastError: r.err || null, lastSent: settings.get('katFreightLastSent') || null, url: katUrl(), on: pushOn() }; };

let fetchImpl = (...a) => fetch(...a);
export const _setFetch = f => { fetchImpl = f; };

/** Send what's due. Returns how many went. */
export async function flushQuotes(now = Date.now()) {
  if (!pushOn()) return 0;
  const due = oq.due.all(now);
  if (!due.length) return 0;
  const quotes = [];
  for (const d of due) { const q = getQuote(d.quote_id); if (q) quotes.push(quoteOut(q)); else oq.done.run(d.quote_id); }
  if (!quotes.length) return 0;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
    const res = await fetchImpl(`${katUrl()}/api/imports/quotes`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sharedKey()}`, 'user-agent': 'KAMRADS' },
      body: JSON.stringify({ source: 'kamrads', quotes }),
    }).finally(() => clearTimeout(t));
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
    for (const d of due) oq.done.run(d.quote_id);
    settings.set({ katFreightLastSent: Date.now() });
    log.info('push', `sent ${quotes.length} quote${quotes.length === 1 ? '' : 's'} to Katara Freight`);
    return quotes.length;
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'timed out' : e.message;
    for (const d of due) oq.fail.run(now + Math.min(60, 2 ** d.tries) * 60000, msg.slice(0, 200), d.quote_id);  // 1, 2, 4… up to 60 min
    log.warn('push', `couldn't send quotes to Katara Freight: ${msg}`);
    return 0;
  }
}

let stopping = false;
export const stopPush = () => { stopping = true; };
export async function pushLoop() {
  while (!stopping) {
    try { await flushQuotes(); } catch (e) { log.error('push', e.stack || e.message); }
    await new Promise(r => setTimeout(r, 30000));
  }
}
