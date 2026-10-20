// Market research: Claude searches Australian listing sites for comparable items, works out the
// average asking price, adjusts for km / condition / write-off status, and returns a resale range
// with the comparables it used. The alert rules then compare the live bid with that range.
//
// Cost control: automatic lookups are capped per day (RESEARCH_PER_DAY, settable on the dashboard)
// and only run for your watchlist, vehicles, and lots worth more than RESEARCH_MIN_BID that close soon.
import { config } from './config.js';
import { q } from './db.js';
import { log } from './log.js';
import { isVehicle } from './extract.js';
import * as settings from './settings.js';

const VEHICLE_SITES = ['carsales.com.au', 'gumtree.com.au', 'drive.com.au', 'redbook.com.au', 'autotrader.com.au',
  'carsguide.com.au', 'cars.com.au', 'pickles.com.au', 'manheim.com.au', 'trucksales.com.au', 'bikesales.com.au'];
const AU = { type: 'approximate', country: 'AU', timezone: 'Australia/Sydney' };

const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
let running = false;

/** Background loop: research the next few lots that deserve it, within the daily cap. */
export async function estimatePending() {
  const key = settings.get('anthropicKey');
  if (!key || !settings.get('researchEnabled') || running) return;
  const cap = Number(settings.get('researchPerDay')) || 0;
  const used = q.researchToday.get(startOfDay()).n;
  if (used >= cap) return;
  const now = Date.now();
  const queue = q.researchQueue.all(now, now + config.researchWithinHours * 3600000).filter(worthIt);
  running = true;
  try {
    for (const lot of queue.slice(0, Math.min(3, cap - used))) await researchLot(lot);
  } finally { running = false; }
}

function worthIt(lot) {
  if (lot.starred) return true;
  if (lot.wovr === 'Statutory Write-Off' && !config.includeStatutory) return false;
  if (isVehicle(lot)) return true;
  return (lot.bid ?? lot.start_price ?? 0) >= config.researchMinBid;
}

/** Research one lot now (also used by the dashboard's "Research" button). */
export async function researchLot(lot) {
  const key = settings.get('anthropicKey');
  if (!key) throw new Error('No Claude API key saved - add one in Settings.');
  const t0 = Date.now();
  try {
    const r = await ask(lot, key);
    q.setResearch.run(r.low, r.high, r.avg, JSON.stringify(r.comps), r.note, 'web', Date.now(), lot.key);
    log.info('research', `${lot.key} ${lot.title?.slice(0, 40)} -> market ~$${r.avg ?? '?'} (${r.comps.length} comps), resale $${r.low}-${r.high} in ${Math.round((Date.now() - t0) / 1000)}s`);
    return r;
  } catch (e) {
    q.setResearch.run(null, null, null, null, `error: ${e.message}`.slice(0, 200), 'error', Date.now(), lot.key);
    log.warn('research', `${lot.key}: ${e.message}`);
    throw e;
  }
}

function prompt(lot) {
  const facts = {
    title: lot.title, year: lot.year, make: lot.make, model: lot.model, odometer_km: lot.odometer,
    write_off_status: lot.wovr, location: [lot.location, lot.state].filter(Boolean).join(' '),
    category: lot.category, auction_site: lot.site, sale: lot.sale_name, lot_page: lot.url,
  };
  return `You value auction lots for an Australian buyer who resells them.

Lot: ${JSON.stringify(facts)}

1. Search for comparable items currently or recently for sale in Australia (same or very close year, make, model, variant and kilometres for vehicles; same item/model for goods). Prefer 3-6 real listings with prices.
2. Work out the average asking price of the comparables.
3. Estimate what THIS lot would realistically resell for privately, adjusting for kilometres, condition, and write-off status:
   - Statutory write-off: can never be re-registered anywhere - value as parts only.
   - Repairable write-off: must pass a written-off vehicle inspection before registration; resale value is well below a clean car's.
   - Asking prices are above sale prices; be realistic, not optimistic.
Ignore the current auction bid.

Reply with ONLY this JSON, no other text:
{"market_avg": number|null, "resale_low": number, "resale_high": number, "confidence": "low"|"medium"|"high",
 "note": "max 15 words on how you got there",
 "comparables": [{"title": "...", "price": number, "km": number|null, "url": "https://..."}]}`;
}

async function call(key, body) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(120000),
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Claude API HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function ask(lot, key) {
  const tool = { type: 'web_search_20250305', name: 'web_search', max_uses: 4, user_location: AU };
  if (isVehicle(lot)) tool.allowed_domains = VEHICLE_SITES;
  const messages = [{ role: 'user', content: prompt(lot) }];
  let data;
  for (let turn = 0; turn < 4; turn++) {
    data = await call(key, { model: config.anthropicModel, max_tokens: 1500, tools: [tool], messages });
    if (data.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: data.content }); // long search: resend unchanged to continue
  }
  const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  // Sources Claude actually cited, as a fallback list of comparables
  const cited = [];
  for (const c of data.content || []) for (const cit of c.citations || []) if (cit.url && !cited.some(x => x.url === cit.url)) cited.push({ title: cit.title, url: cit.url });
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no valuation in reply');
  const j = JSON.parse(m[0]);
  const low = Number(j.resale_low), high = Number(j.resale_high);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0) throw new Error('could not value this lot');
  const comps = (Array.isArray(j.comparables) ? j.comparables : [])
    .filter(c => c && /^https?:\/\//.test(c.url || ''))
    .slice(0, 6)
    .map(c => ({ title: String(c.title || '').slice(0, 100), price: Number(c.price) || null, km: Number(c.km) || null, url: c.url }));
  return {
    low: Math.round(Math.min(low, high)), high: Math.round(Math.max(low, high)),
    avg: Number.isFinite(Number(j.market_avg)) && Number(j.market_avg) > 0 ? Math.round(Number(j.market_avg)) : null,
    comps: comps.length ? comps : cited.slice(0, 6),
    note: `${j.confidence || '?'} · ${String(j.note || '').slice(0, 110)}`,
    searches: data.usage?.server_tool_use?.web_search_requests ?? null,
  };
}

/** Cheapest possible call to check a key works. */
export async function testKey(key) {
  const data = await call(key, { model: config.anthropicModel, max_tokens: 5, messages: [{ role: 'user', content: 'Reply OK' }] });
  return !!data.content;
}
