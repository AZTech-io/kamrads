import { withPage, looksBlocked } from '../browser.js';
import { factsFromText } from '../extract.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { domCards, cardToLot, lotsFromCapture, mergeLots, absUrl } from './common.js';

export const site = 'pickles';
const ORIGIN = 'https://www.pickles.com.au';
const DETAIL_RE = /pickles\.com\.au\/used\/details\/[^/]+\/(?:[^/]+\/)?\d{6,9}/;
export const loginUrl = ORIGIN + '/';

const idFromUrl = u => (/\/used\/details\/[^?#]*?\/(\d{6,9})(?:[/?#]|$)/.exec(u || '') || [])[1] || null;
const categoryFromUrl = u => (/\/used\/details\/([^/]+)\//.exec(u || '') || [])[1] || null;

function finish(lot) {
  lot.url = absUrl(lot.url, ORIGIN);
  // Prefer the public stock number as the id so JSON and page data merge.
  const fromUrl = idFromUrl(lot.url);
  if (fromUrl) lot.ext_id = fromUrl;
  if (lot.url && !DETAIL_RE.test(lot.url)) lot.url = null;
  lot.category = lot.category || categoryFromUrl(lot.url);
  lot.image = absUrl(lot.image, ORIGIN);
  lot.site = site;
  return lot;
}

const withPaging = (url, page, size) => {
  const u = new URL(url);
  u.searchParams.set('page', String(page));
  u.searchParams.set('limit', String(size));
  return u.toString();
};

/** Scan the configured search pages. */
export async function discover() {
  const { searches, maxPages, pageSize } = config.sites.pickles;
  const all = new Map();
  for (const search of searches) {
    for (let p = 1; p <= maxPages; p++) {
      const url = withPaging(search, p, pageSize);
      const r = await withPage(site, url, page => domCards(page, DETAIL_RE));
      if (looksBlocked(r)) throw new Error(`blocked by Pickles (HTTP ${r.status}) - set PROXY_URL to an Australian proxy`);
      const fromDom = (r.result || []).map(c => cardToLot(c, { idFromUrl })).filter(Boolean).map(finish);
      // The page shows every lot as a card, so a JSON "lot" that isn't on the page is an internal record, not a lot.
      const onPage = new Set(fromDom.map(l => l.ext_id));
      const fromJson = lotsFromCapture(r).map(finish)
        .filter(l => (onPage.size ? onPage.has(l.ext_id) : !!idFromUrl(l.url)));
      if (p === 1 && search === searches[0] && fromJson[0]) log.info(site, `sample: ${JSON.stringify(fromJson[0]).slice(0, 400)}`);
      const lots = mergeLots(fromJson, fromDom);
      let fresh = 0;
      for (const l of lots) if (!all.has(l.ext_id)) { all.set(l.ext_id, l); fresh++; }
      log.info(site, `${new URL(search).pathname} p${p}: ${lots.length} lots (${fromJson.length} json, ${fromDom.length} cards)`);
      if (fresh === 0 || lots.length < Math.min(pageSize, 30)) break;
    }
  }
  return [...all.values()].filter(l => l.url);
}

/** Re-read one lot's detail page for its live bid and close time. */
export async function refresh(lot) {
  const r = await withPage(site, lot.url, null, { waitMs: 1500, high: true });
  if (looksBlocked(r)) throw new Error(`blocked by Pickles (HTTP ${r.status})`);
  const json = lotsFromCapture(r).map(finish);
  const match = json.find(l => l.ext_id === lot.ext_id) || (json.length === 1 ? json[0] : null);
  const facts = factsFromText(r.text);
  const merged = { ...(match || {}), ext_id: lot.ext_id, url: lot.url, site };
  for (const [k, v] of Object.entries(facts)) if (merged[k] == null) merged[k] = v;
  if (/pickles\s*live/i.test(r.text) && !merged.buy_method) merged.buy_method = 'Pickles Live';
  else if (/pickles\s*online|\(online\)/i.test(r.text) && !merged.buy_method) merged.buy_method = 'Pickles Online';
  return merged;
}
