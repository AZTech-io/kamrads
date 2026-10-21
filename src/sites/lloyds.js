// Lloyds Auctions (lloydsonline.com.au): ASP.NET pages, server-rendered, no login needed for prices.
// Auction list -> each auction's lot list (AuctionLots.aspx) -> lot pages (LotDetails.aspx?...&lid=N).
// Lots in an auction close one after another, so each lot carries its own countdown ("1d 5h 06m").
import { withPage, looksBlocked, browserFetch } from '../browser.js';
import { factsFromText, parseCountdown, parseAuDate, parseMoney, placeFromAddress } from '../extract.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { cardToLot, absUrl, titleFromPage, goodTitle } from './common.js';

export const site = 'lloyds';
const ORIGIN = 'https://www.lloydsonline.com.au';
const DETAIL_RE = /lloydsonline\.com\.au\/LotDetails\.aspx\?[^#]*\blid=\d+/i;
const AUCTION_RE = /lloydsonline\.com\.au\/AuctionDetails\.aspx\?[^#]*\baid=\d+/i;
export const owns = u => DETAIL_RE.test(u || '');
export const loginUrl = null;
// Lot pages are plain HTML: a re-read is a ~0.3 s fetch, so closing lots can be read as often as fast-feed sites.
export const cheapRefresh = true;

export const idFromUrl = u => (/[?&]lid=(\d+)/i.exec(u || '') || [])[1] || null;
const aidFromUrl = u => (/[?&]aid=(\d+)/i.exec(u || '') || [])[1] || null;
const lotUrl = (aid, lid) => `${ORIGIN}/LotDetails.aspx?smode=0&aid=${aid}&lid=${lid}`;

// Lloyds puts "how does bidding work" practice lots and ads at the top of every auction.
const HOUSE_LOT = /how does the auction process work|practice (?:lot|bid)|simple .{0,12}free.{0,6} to list|list with lloyds/i;
const squash = s => String(s || '').replace(/\s+/g, ' ').trim();

/** Countdown on a lot row: the "1d 5h 06m" that follows the price (titles can contain "10m ladder"). */
export function rowCountdown(text) {
  const t = squash(text);
  const i = t.lastIndexOf('$');
  const tail = i >= 0 ? t.slice(i) : t;
  const m = /(?:\b\d+\s*d\s+)?(?:\b\d+\s*h\s+)?\b\d+\s*m\b(?:\s+\d+\s*s\b)?|\b(?:\d+\s*d\s+)?\d{1,2}:\d{2}:\d{2}\b/i.exec(tail);
  return m ? parseCountdown(m[0]) : null;
}

/** "52 Happy Campers, Albert Park... $1 01:32:42" -> "Happy Campers, Albert Park" (no lot number, price or countdown) */
export function cleanRowTitle(title, lotNo = null) {
  let t = squash(title);
  if (lotNo) t = t.replace(new RegExp(`^${lotNo}\\s+`), '');
  t = t.replace(/\s+\$\s?[\d,]+(?:\.\d+)?(?:\s+(?:\d+\s*[dhms]\b\s*|\d{1,2}:\d{2}(?::\d{2})?\b\s*)*)?(?:\.\.\.|…)?\s*$/, '');
  t = t.replace(/\s*(\.\.\.|…)$/, '').trim();
  return t || null;
}

/** One lot row from an AuctionLots page: "1200 2004 Volvo FH12 500 6x4 Prime Mover... $1,350 1d 5h 06m". */
export function rowToLot(card, auction, now = Date.now()) {
  const lid = idFromUrl(card.href);
  const aid = aidFromUrl(card.href) || auction?.aid;
  if (!lid || !aid) return null;
  const text = squash(card.text);
  const base = cardToLot(card, { idFromUrl, now }) || {};
  const row = /^(\d{1,6}[A-Z]?)\s+(.+?)\s+\$\s?([\d,]+(?:\.\d+)?)\b/.exec(text);
  let title = row ? row[2] : base.title;
  if (card.heading && goodTitle(card.heading)) title = card.heading;
  title = cleanRowTitle(title, row?.[1]);
  const ms = rowCountdown(text);
  return {
    ext_id: lid, url: lotUrl(aid, lid), title,
    lot_no: row ? row[1] : null,
    bid: row ? parseMoney(row[3]) : base.bid ?? null,
    end_at: ms != null ? now + ms : auction?.at ?? null,
    location: base.location ?? null, state: base.state ?? auction?.state ?? null,
    odometer: base.odometer ?? null, wovr: base.wovr ?? null,
    sale_name: auction?.name ?? null, buy_method: 'Lloyds Online', site, image: card.image || null,
  };
}

/**
 * Each link with the text of its own row only: climb from the link while the container still holds
 * just this one id (generic card grabbing would merge a whole table into one card).
 */
const ownRows = (page, re, param, stopRe) => page.evaluate(([src, param, stopSrc]) => {
  const re = new RegExp(src, 'i');
  const stop = stopSrc ? new RegExp(stopSrc, 'i') : null;
  const idOf = h => (new RegExp(`[?&]${param}=(\\d+)`, 'i').exec(h) || [])[1];
  const out = new Map();
  for (const a of document.querySelectorAll('a[href]')) {
    if (!re.test(a.href)) continue;
    const id = idOf(a.href);
    let box = a;
    for (let i = 0; i < 7 && box.parentElement; i++) {
      const p = box.parentElement;
      const ids = new Set([...p.querySelectorAll('a[href]')].map(x => idOf(x.href)).filter(Boolean));
      if (ids.size > 1) break;
      box = p;
      if (stop && stop.test(box.innerText || '')) break;
    }
    const label = (a.innerText || '').trim() || (a.querySelector('img')?.getAttribute('alt') || '').trim();
    const im = (a.querySelector('img') || box.querySelector('img'));
    const src = im ? (im.getAttribute('data-src') || im.getAttribute('src') || '') : '';
    const image = src && !/^data:|logo|icon|\.svg|\/images\/(?:state|seller|type)/i.test(src) ? new URL(src, location.href).href : '';
    const prev = out.get(id);
    const text = (box.innerText || '').trim();
    if (!prev) out.set(id, { href: a.href.split('#')[0], heading: label, named: '', text, image });
    else { if (label.length > prev.heading.length) prev.heading = label; if (text.length > prev.text.length) prev.text = text; if (!prev.image && image) prev.image = image; }
  }
  return [...out.values()];
}, [re.source, param, stopRe?.source || null]);
const auctionLinks = page => ownRows(page, AUCTION_RE, 'aid', /\d{1,2}-[A-Za-z]{3}-\d{4}/);

/** "Tue 20-Oct-2026 10:00 Ski & Snow Equipment Liquidation (ON12369)" -> auction info. */
function auctionFromCard(c) {
  const aid = aidFromUrl(c.href);
  if (!aid) return null;
  const text = squash(c.text);
  const when = /(\d{1,2}-[A-Za-z]{3}-\d{4}\s+\d{1,2}:\d{2})/.exec(text);
  // Lloyds is in Queensland (AEST, no daylight saving)
  const at = when ? parseAuDate(when[1].replace(/-/g, ' ') + ' aest') : null;
  const name = squash(c.heading || c.named || text.replace(when?.[0] || '', '')).slice(0, 120);
  return { aid, at, name, text };
}

async function listAuctions() {
  const cfg = config.sites.lloyds;
  const r = await withPage(site, `${ORIGIN}/AuctionList.aspx`, auctionLinks);
  if (looksBlocked(r)) throw new Error(`blocked by Lloyds (HTTP ${r.status}) - set PROXY_URL to an Australian proxy`);
  const skip = new RegExp(cfg.skipFilter, 'i');
  const now = Date.now(), until = now + cfg.withinHours * 3600000;
  const seen = new Set();
  const auctions = (r.result || []).map(auctionFromCard).filter(a => a && !seen.has(a.aid) && seen.add(a.aid))
    .filter(a => !skip.test(a.text))
    // Lots close after the auction's listed time, and some auctions run for days, so keep anything that has started.
    .filter(a => a.at == null || a.at < until)
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  log.info(site, `${auctions.length} auctions to scan (of ${seen.size} listed)`);
  return auctions.slice(0, cfg.maxAuctions);
}

export async function discover() {
  const cfg = config.sites.lloyds;
  const all = new Map();
  for (const a of await listAuctions()) {
    let got = 0;
    for (let p = 1; p <= cfg.maxPages; p++) {
      const url = `${ORIGIN}/AuctionLots.aspx?smode=0&aid=${a.aid}&pgn=${p}&pgs=${cfg.pageSize}`;
      try {
        const r = await withPage(site, url, page => ownRows(page, DETAIL_RE, 'lid'));
        if (looksBlocked(r)) throw new Error(`blocked by Lloyds (HTTP ${r.status})`);
        let fresh = 0;
        if (process.env.KAMRADS_DEBUG) log.info(site, `${url}: status ${r.status}, ${(r.result || []).length} cards, ${(r.html || '').length} bytes`);
        const rows = (r.result || []).map(c => rowToLot({ ...c, href: absUrl(c.href, ORIGIN) }, a))
          .filter(l => l && !HOUSE_LOT.test(l.title || ''));
        for (const l of rows) if (!all.has(l.ext_id)) { all.set(l.ext_id, l); fresh++; }
        got += fresh;
        // pgs= may be ignored (default page size 15), so only stop on a short page of either size
        if (!fresh || (r.result || []).length < Math.min(cfg.pageSize, 15)) break;
      } catch (e) {
        if (/blocked/.test(e.message)) throw e;
        log.warn(site, `${a.name}: ${e.message}`);
        break;
      }
    }
    log.info(site, `${a.name}: ${got} lots`);
  }
  return [...all.values()];
}

/** Facts on a lot page: "Current Bid: $1,650", "Estimated time until auction: 14:09:27", "Kms: 889724". */
export function factsFromLotPage(html, now = Date.now()) {
  const text = squash(String(html || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#36;/g, '$'));
  const out = factsFromText(text, now);
  const bid = /current\s*bid\s*:?\s*\$\s?([\d,]+(?:\.\d+)?)/i.exec(text);
  if (bid) out.bid = parseMoney(bid[1]);
  const cd = /time\s*(?:until|till|to)\s*(?:auction|close|closing)\s*:?\s*((?:\d+\s*d(?:ays?)?\s*)?\d{1,2}:\d{2}:\d{2}|(?:\d+\s*[dhms]\s*){1,4})/i.exec(text);
  if (cd) out.end_at = now + parseCountdown(cd[1]);
  else {
    const dt = /auction\s*date\s*:?\s*(\d{1,2}-[A-Za-z]{3}-\d{4}\s+\d{1,2}:\d{2})/i.exec(text);
    if (dt && !out.end_at) out.end_at = parseAuDate(dt[1].replace(/-/g, ' ') + ' aest');
  }
  if (/auction\s+(?:has\s+)?(?:closed|ended)|lot\s+(?:is\s+)?closed|bidding\s+(?:has\s+)?closed/i.test(text)) out.closed = true;
  const km = /\bkms?\s*:\s*([\d,]+)/i.exec(text);
  if (km) out.odometer = parseInt(km[1].replace(/,/g, ''), 10) || out.odometer;
  const yr = /manufacture\s*year\s*:\s*(\d{4})/i.exec(text) || /build\s*(?:date|year)\s*:\s*(?:\d{1,2}\/)?(\d{4})/i.exec(text);
  if (yr) out.year = +yr[1];
  const loc = /location\s*of\s*item\s*:\s*([^:]{3,120}?)(?:,\s*Australia|\s{2}|$)/i.exec(text);
  if (loc && !out.location) out.location = loc[1].trim();
  // No "Location of item": the sale's own address ("Auction Address: 148 Main Street Beverley SA 5009")
  if (!out.location) {
    const aa = /auction\s*address\s*:\s*(.{3,140}?\b(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b)/i.exec(text);
    const pl = aa && placeFromAddress(aa[1]);
    if (pl) { out.location = pl.location; out.state = out.state || pl.state; }
  }
  if (out.location && /shipping\s+only/i.test(text)) out.location += ' · ships only';
  return out;
}

/** Re-read one lot. The page is plain HTML, so a same-origin fetch (~0.3 s) is enough. */
export async function refresh(lot) {
  let html, fast = true;
  try {
    const r = await browserFetch(site, lot.url, 'text/html');
    if (r.status === 403 || r.status === 429) throw new Error(`blocked by Lloyds (HTTP ${r.status})`);
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
    html = r.text;
  } catch (e) {
    if (/blocked/.test(e.message)) throw e;
    const r = await withPage(site, lot.url, null, { waitMs: 500, high: true });
    if (looksBlocked(r)) throw new Error(`blocked by Lloyds (HTTP ${r.status})`);
    html = r.html; fast = false;
  }
  const facts = factsFromLotPage(html);
  const merged = { ...facts, ext_id: lot.ext_id, url: lot.url, site, fast };
  delete merged.closed;
  if (!lot.title) {
    const t = titleFromPage(html, lot.url);
    if (t && !/ - lot \d+$/i.test(t)) merged.title = t;
  }
  return merged;
}
