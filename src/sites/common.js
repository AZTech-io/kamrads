import { lotsFromJson, jsonBlobsFromHtml, factsFromText, parseMoney } from '../extract.js';

/** Grab candidate lot cards from the DOM: every link matching `hrefRe`, keeping the richest text per URL. */
export async function domCards(page, hrefRe) {
  return page.evaluate(src => {
    const re = new RegExp(src, 'i');
    const byHref = new Map();
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href.split('#')[0];
      if (!re.test(href)) continue;
      // climb to the card container so we see the price / km / close time next to the link
      let card = a;
      for (let i = 0; i < 5 && card.parentElement; i++) {
        const p = card.parentElement;
        if (p.querySelectorAll('a[href]').length > 12) break;
        card = p;
        if ((card.innerText || '').length > 160) break;
      }
      const heading = (a.querySelector('h1,h2,h3,h4,h5,h6,[class*="title" i]') || card.querySelector('h1,h2,h3,h4,h5,h6,[class*="title" i]'))?.innerText?.trim() || '';
      const img = a.querySelector('img') || card.querySelector('img');
      const named = (a.getAttribute('title') || img?.getAttribute('title') || img?.getAttribute('alt') || '').trim();
      // photos are blocked from loading, but their address is still on the tag
      const imgSrc = img ? (img.getAttribute('data-src') || img.getAttribute('data-lazy') || img.getAttribute('srcset')?.split(/[\s,]+/)[0] || img.getAttribute('src') || '') : '';
      const image = imgSrc && !/^data:|logo|icon|placeholder|\.svg/i.test(imgSrc) ? new URL(imgSrc, location.href).href : '';
      const text = (card.innerText || a.innerText || '').trim();
      const prev = byHref.get(href);
      if (!prev || text.length > prev.text.length) byHref.set(href, { href, heading: heading || prev?.heading || '', named: named || prev?.named || '', text, image: image || prev?.image || '' });
      else if (image && !prev.image) prev.image = image;
    }
    return [...byHref.values()];
  }, hrefRe.source);
}

const clean = t => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 160);
/** Reject things that aren't a lot name: prices, countdowns, buttons, unrendered {{templates}}. */
export const goodTitle = t => !!t && t.length >= 4 && /[a-z]{3}/i.test(t) && !/\{\{|\}\}/.test(t)
  && !/^(\$|au\$|current|start|no bids|today|tomorrow|closing|closes|ends|watch|bid now|view|under offer|auction|lot \d)/i.test(t)
  && !/^[\d\s:dhms$,.]+$/i.test(t);
/** ".../seiko-5-sports-supercars-2023-limited-edition-number-1678197" -> "Seiko 5 Sports Supercars 2023 Limited Edition Number" */
export function slugTitle(href) {
  const last = String(href || '').split(/[?#]/)[0].replace(/\/$/, '').split('/').pop() || '';
  const words = last.replace(/-?\d{5,}$/, '').split('-').filter(Boolean);
  if (words.length < 2) return '';
  return words.map(w => (/^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1))).join(' ');
}

/** Best lot name on a detail page: <h1>, then og:title / <title> without the site suffix, then the URL. */
export function titleFromPage(html, url) {
  const strip = t => clean(String(t || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"'));
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html || '');
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i.exec(html || '');
  const tt = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
  const tidy = t => strip(t).replace(/\s*[|\-–]\s*(pickles|allbids|carbids|manheim)\b.*$/i, '').replace(/,\s*\d{6,9}$/, '').trim();
  return [h1 && strip(h1[1]), og && tidy(og[1]), tt && tidy(tt[1])].find(goodTitle) || slugTitle(url) || null;
}

const JUNK_LINE = /^(salvage|interested\??|view \d+ more photos?|share|add a note|finance enquiry|watch|photos?|\d+\/\d+|fullscreen)$/i;

export function cardToLot(card, { idFromUrl, now = Date.now() }) {
  const ext_id = idFromUrl(card.href);
  if (!ext_id) return null;
  const lines = card.text.split('\n').map(s => s.trim()).filter(s => s && !JUNK_LINE.test(s));
  const title = [card.heading, card.named, ...lines.slice(0, 3)].map(clean).find(goodTitle) || slugTitle(card.href) || null;
  const facts = factsFromText(card.text, now);
  // On listing cards a bare "$2,200" is normally the current bid / price.
  if (facts.bid == null) {
    const m = /\$\s?([\d,]{1,9})(?!\s*(?:k|K)?\s*(?:fee|premium))/.exec(card.text);
    if (m) facts.bid = parseMoney(m[1]);
  }
  return { ext_id, url: card.href, title, ...(card.image ? { image: card.image } : {}), ...facts };
}

/** Lots from captured JSON responses and JSON embedded in the HTML. */
export function lotsFromCapture(r, now = Date.now()) {
  const all = [];
  for (const { body } of r.json) all.push(...lotsFromJson(body, now));
  for (const blob of jsonBlobsFromHtml(r.html || '')) all.push(...lotsFromJson(blob, now));
  return all;
}

/** Merge lots by ext_id; earlier sources win, later ones only fill gaps. */
export function mergeLots(...groups) {
  const out = new Map();
  for (const group of groups) for (const lot of group) {
    if (!lot?.ext_id) continue;
    const prev = out.get(lot.ext_id);
    if (!prev) out.set(lot.ext_id, { ...lot });
    else for (const [k, v] of Object.entries(lot)) if (prev[k] == null && v != null) prev[k] = v;
  }
  return [...out.values()];
}

export const absUrl = (u, origin) => (!u ? null : u.startsWith('http') ? u : u.startsWith('//') ? 'https:' + u : origin + (u.startsWith('/') ? '' : '/') + u);

const normTitle = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Line JSON lots up with the cards on the page. A JSON lot whose id is on the page keeps it;
 * otherwise it adopts the id + url of the one card with the same title. Anything left over is an
 * internal record (not a lot on this page) and is dropped.
 */
export function alignToCards(jsonLots, cardLots) {
  if (!cardLots.length) return jsonLots;
  const byId = new Set(cardLots.map(c => c.ext_id));
  const byTitle = new Map();
  for (const c of cardLots) { const k = normTitle(c.title); byTitle.set(k, byTitle.has(k) ? null : c); }
  const out = [];
  for (const l of jsonLots) {
    if (byId.has(l.ext_id)) { out.push(l); continue; }
    const c = byTitle.get(normTitle(l.title));
    if (c) out.push({ ...l, ext_id: c.ext_id, url: c.url });
  }
  return out;
}
