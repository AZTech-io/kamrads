// ALLBIDS family (allbids, carbids, boatbids, ehva): AngularJS pages that load lots as JSON.
// Bids and close times are public, so no login is needed.
import { withPage, looksBlocked } from '../browser.js';
import { factsFromText } from '../extract.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { domCards, cardToLot, lotsFromCapture, mergeLots, absUrl, alignToCards } from './common.js';

export const site = 'allbids';
const ORIGIN = 'https://www.allbids.com.au';
// Lot pages look like /c/office-business/phone-communication-systems/panasonic-kxns700al-...-1100784
const DETAIL_RE = /(?:allbids|carbids|boatbids|ehva)\.com\.au\/c\/[^?#]+-\d{5,}(?:[/?#]|$)/;
export const loginUrl = null; // no login needed

const idFromUrl = u => (/-(\d{5,})\/?(?:[?#]|$)/.exec(u || '') || [])[1] || null;
const categoryFromUrl = u => (/\/c\/([^/]+)\//.exec(u || '') || [])[1] || null;

function finish(lot, origin = ORIGIN) {
  lot.url = absUrl(lot.url, origin);
  if (lot.url && !DETAIL_RE.test(lot.url)) lot.url = null;
  const fromUrl = idFromUrl(lot.url);
  if (fromUrl) lot.ext_id = fromUrl;
  lot.image = absUrl(lot.image, origin);
  lot.category = lot.category || categoryFromUrl(lot.url);
  lot.site = site;
  return lot;
}

export async function discover() {
  const cfg = config.sites.allbids;
  const all = new Map();
  for (const url of cfg.pages) {
    const origin = new URL(url).origin;
    try {
      const r = await withPage(site, url, page => domCards(page, DETAIL_RE), { scrolls: cfg.scrolls });
      if (looksBlocked(r)) throw new Error(`blocked (HTTP ${r.status})`);
      const cards = (r.result || []).map(c => cardToLot(c, { idFromUrl })).filter(Boolean).map(l => finish(l, origin));
      const json = alignToCards(lotsFromCapture(r).map(l => finish(l, origin)), cards);
      const lots = mergeLots(json, cards).filter(l => l.url);
      for (const l of lots) all.set(l.ext_id, { ...(all.get(l.ext_id) || {}), ...l });
      log.info(site, `${new URL(url).hostname}${new URL(url).pathname}: ${lots.length} lots (${json.length} json, ${cards.length} cards)`);
      if (json[0] && url === cfg.pages[0]) log.info(site, `sample: ${JSON.stringify(json[0]).slice(0, 400)}`);
    } catch (e) {
      log.warn(site, `${url}: ${e.message}`);
    }
  }
  return [...all.values()];
}

export async function refresh(lot) {
  const r = await withPage(site, lot.url, null, { waitMs: 1500, high: true });
  if (looksBlocked(r)) throw new Error(`blocked by ALLBIDS (HTTP ${r.status})`);
  const json = lotsFromCapture(r).map(l => finish(l, new URL(lot.url).origin));
  const match = json.find(l => l.ext_id === lot.ext_id) || (json.length === 1 ? json[0] : null);
  const facts = factsFromText(r.text);
  const merged = { ...(match || {}), ext_id: lot.ext_id, url: lot.url, site };
  for (const [k, v] of Object.entries(facts)) if (merged[k] == null) merged[k] = v;
  return merged;
}
