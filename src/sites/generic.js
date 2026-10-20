// One adapter for sites that work the usual way: a listing page (or a page of auctions, each with
// its lot list) -> lot pages. Lots are read from captured JSON plus the visible cards, like the
// other sites. Each site is just a definition: where to look and what a lot link looks like.
import { withPage, looksBlocked } from '../browser.js';
import { fastRead, learn } from '../fast.js';
import { factsFromText } from '../extract.js';
import { log } from '../log.js';
import { domCards, cardToLot, lotsFromCapture, mergeLots, absUrl, titleFromPage, alignToCards } from './common.js';

/**
 * def: { site, label, origin, detailRe, idFromUrl, listings: [url], auctionsFrom?: url, auctionRe?, maxAuctions,
 *        maxPages, pageParam ('page' | null), scrolls, enabled }
 */
export function makeSite(def) {
  const { site, origin, detailRe } = def;
  const idFromUrl = def.idFromUrl;
  const owns = u => detailRe.test(u || '');

  const finish = (lot, saleName) => {
    lot.url = absUrl(lot.url, origin);
    if (lot.url && !detailRe.test(lot.url)) lot.url = null;
    const id = idFromUrl(lot.url);
    if (id) lot.ext_id = id;
    lot.image = absUrl(lot.image, origin);
    lot.sale_name = lot.sale_name || saleName || null;
    lot.site = site;
    return lot;
  };

  async function readList(url, saleName) {
    const r = await withPage(site, url, page => domCards(page, detailRe), { scrolls: def.scrolls ?? 4 });
    if (looksBlocked(r)) throw new Error(`blocked by ${def.label} (HTTP ${r.status}) - set PROXY_URL to an Australian proxy`);
    const cards = (r.result || []).map(c => cardToLot(c, { idFromUrl })).filter(Boolean).map(l => finish(l, saleName));
    const json = alignToCards(lotsFromCapture(r).map(l => finish(l, saleName)), cards);
    return { lots: mergeLots(json, cards).filter(l => l.url), html: r.html };
  }

  const paged = (url, p) => {
    if (!def.pageParam || p === 1) return url;
    const u = new URL(url); u.searchParams.set(def.pageParam, String(p)); return u.toString();
  };

  async function auctionsList() {
    const r = await withPage(site, def.auctionsFrom, page => page.evaluate(src => {
      const re = new RegExp(src, 'i');
      const out = new Map();
      for (const a of document.querySelectorAll('a[href]')) {
        if (!re.test(a.href)) continue;
        const box = a.closest('article, li, tr, [class*="card" i], [class*="auction" i]') || a;
        const prev = out.get(a.href);
        const name = (a.innerText || '').trim() || (box.querySelector('h1,h2,h3,h4,h5')?.innerText || '').trim();
        if (!prev || name.length > prev.name.length) out.set(a.href.split('#')[0], { href: a.href.split('#')[0], name: name.slice(0, 120), text: (box.innerText || '').slice(0, 300) });
      }
      return [...out.values()];
    }, def.auctionRe.source), { scrolls: 3 });
    if (looksBlocked(r)) throw new Error(`blocked by ${def.label} (HTTP ${r.status}) - set PROXY_URL to an Australian proxy`);
    const skip = def.skipFilter ? new RegExp(def.skipFilter, 'i') : null;
    return (r.result || []).filter(a => !skip || !skip.test(`${a.name} ${a.text}`)).slice(0, def.maxAuctions ?? 15);
  }

  async function discover() {
    const all = new Map();
    const targets = [...(def.listings || []).map(url => ({ url, name: null }))];
    if (def.auctionsFrom) for (const a of await auctionsList()) targets.push({ url: a.href, name: a.name || null });
    for (const t of targets) {
      let got = 0;
      for (let p = 1; p <= (def.maxPages ?? 1); p++) {
        try {
          const { lots } = await readList(paged(t.url, p), t.name);
          let fresh = 0;
          for (const l of lots) if (!all.has(l.ext_id)) { all.set(l.ext_id, l); fresh++; }
          got += fresh;
          if (!fresh || !def.pageParam) break;
        } catch (e) {
          if (/blocked/.test(e.message)) throw e;
          log.warn(site, `${t.url}: ${e.message}`);
          break;
        }
      }
      log.info(site, `${t.name || new URL(t.url).pathname}: ${got} lots`);
    }
    return [...all.values()];
  }

  async function refresh(lot) {
    const quick = await fastRead(site, lot);
    if (quick) return { ...quick, ext_id: lot.ext_id, url: lot.url, site, fast: true };
    const r = await withPage(site, lot.url, null, { waitMs: 1500, high: true });
    if (looksBlocked(r)) throw new Error(`blocked by ${def.label} (HTTP ${r.status})`);
    learn(site, lot.ext_id, r);
    const json = lotsFromCapture(r).map(l => finish(l));
    // Only this lot's own record: lot pages also load "similar items" with their own prices and times.
    const match = json.find(l => l.ext_id === lot.ext_id);
    const merged = { ...(match || {}), ext_id: lot.ext_id, url: lot.url, site };
    for (const [k, v] of Object.entries(factsFromText(r.text))) if (merged[k] == null) merged[k] = v;
    // The site's own labelled times ("Closes: 27 October 20:00 AEDT") beat anything else.
    if (def.pageFacts) Object.assign(merged, def.pageFacts(r.text));
    merged.title = merged.title || titleFromPage(r.html, lot.url);
    return merged;
  }

  return { site, label: def.label, owns, idFromUrl, loginUrl: null, discover, refresh, timesFromLotPage: !!def.timesFromLotPage };
}
