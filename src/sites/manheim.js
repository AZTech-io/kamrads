import { withPage, looksBlocked } from '../browser.js';
import { factsFromText } from '../extract.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { domCards, cardToLot, lotsFromCapture, mergeLots, absUrl, titleFromPage } from './common.js';

export const site = 'manheim';
const ORIGIN = 'https://www.manheim.com.au';
// Lot detail links: same site, a lot-ish path segment and a long number.
const DETAIL_RE = /manheim\.com\.au\/[^?#]*(?:lot|item|vehicle|asset|detail|stock|listing|passenger|truck|machinery|damage)[^?#]*\d{5,}/;
export const owns = u => DETAIL_RE.test(u || '');
export const loginUrl = ORIGIN + '/';

export const idFromUrl = u => { const m = (u || '').split(/[?#]/)[0].match(/\d{5,}/g); return m ? m[m.length - 1] : null; };

function finish(lot, saleName) {
  lot.url = absUrl(lot.url, ORIGIN);
  const fromUrl = lot.url && DETAIL_RE.test(lot.url) ? idFromUrl(lot.url) : null;
  if (fromUrl) lot.ext_id = fromUrl;
  lot.image = absUrl(lot.image, ORIGIN);
  lot.sale_name = lot.sale_name || saleName || null;
  lot.site = site;
  return lot;
}

/** Event links on the home page look like "Statutory Write off Vehicles | (173) lots". */
async function listEvents() {
  const r = await withPage(site, config.sites.manheim.home, page => page.evaluate(() => {
    const out = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const box = a.closest('li, tr, div') || a;
      const text = (box.innerText || a.innerText || '').replace(/\s+/g, ' ').trim();
      if (/\(\s*\d+\s*\)\s*lots?/i.test(text) || /\d+\s*lots?\b/i.test(a.innerText || '')) {
        out.push({ href: a.href.split('#')[0], name: (a.innerText || text).replace(/\s+/g, ' ').trim().slice(0, 120), text: text.slice(0, 200) });
      }
    }
    return out;
  }));
  if (looksBlocked(r)) throw new Error(`blocked by Manheim (HTTP ${r.status}) - set PROXY_URL to an Australian proxy`);
  const seen = new Set();
  const events = (r.result || []).filter(e => e.href.startsWith('http') && !seen.has(e.href) && seen.add(e.href));
  // Lots may also already be in the home page JSON
  const homeLots = lotsFromCapture(r).map(l => finish(l));
  return { events, homeLots };
}

export async function discover() {
  const cfg = config.sites.manheim;
  const { events, homeLots } = await listEvents();
  const filter = new RegExp(cfg.eventFilter, 'i');
  const chosen = events.filter(e => filter.test(e.name) || filter.test(e.text)).slice(0, cfg.maxEvents);
  log.info(site, `${events.length} events on home page, scanning ${chosen.length}: ${chosen.map(e => e.name).join(' / ')}`);
  const all = new Map();
  for (const l of homeLots) all.set(l.ext_id, l);
  for (const ev of chosen) {
    try {
      const r = await withPage(site, ev.href, page => domCards(page, DETAIL_RE), { scrolls: cfg.scrolls });
      if (looksBlocked(r)) throw new Error(`blocked (HTTP ${r.status})`);
      const name = ev.name.replace(/\|?\s*\(\s*\d+\s*\)\s*lots?/i, '').trim();
      const fromJson = lotsFromCapture(r).map(l => finish(l, name));
      const fromDom = (r.result || []).map(c => cardToLot(c, { idFromUrl })).filter(Boolean).map(l => finish(l, name));
      const lots = mergeLots(fromJson, fromDom);
      for (const l of lots) all.set(l.ext_id, { ...(all.get(l.ext_id) || {}), ...l });
      log.info(site, `${name}: ${lots.length} lots (${fromJson.length} json, ${fromDom.length} cards)`);
    } catch (e) {
      log.warn(site, `event "${ev.name}": ${e.message}`);
    }
  }
  return [...all.values()].filter(l => l.url);
}

export async function refresh(lot) {
  const r = await withPage(site, lot.url, null, { waitMs: 1500, high: true });
  if (looksBlocked(r)) throw new Error(`blocked by Manheim (HTTP ${r.status})`);
  const json = lotsFromCapture(r).map(l => finish(l, lot.sale_name));
  const match = json.find(l => l.ext_id === lot.ext_id) || (json.length === 1 ? json[0] : null);
  const facts = factsFromText(r.text);
  const merged = { ...(match || {}), ext_id: lot.ext_id, url: lot.url, site };
  for (const [k, v] of Object.entries(facts)) if (merged[k] == null) merged[k] = v;
  merged.title = merged.title || titleFromPage(r.html, lot.url);
  return merged;
}
