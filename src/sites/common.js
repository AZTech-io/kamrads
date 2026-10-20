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
      const text = (card.innerText || a.innerText || '').trim();
      const prev = byHref.get(href);
      if (!prev || text.length > prev.text.length) byHref.set(href, { href, heading, text });
    }
    return [...byHref.values()];
  }, hrefRe.source);
}

const JUNK_LINE = /^(salvage|interested\??|view \d+ more photos?|share|add a note|finance enquiry|watch|photos?|\d+\/\d+|fullscreen)$/i;

export function cardToLot(card, { idFromUrl, now = Date.now() }) {
  const ext_id = idFromUrl(card.href);
  if (!ext_id) return null;
  const lines = card.text.split('\n').map(s => s.trim()).filter(s => s && !JUNK_LINE.test(s));
  const title = (card.heading || lines[0] || '').replace(/\s+/g, ' ').slice(0, 160);
  const facts = factsFromText(card.text, now);
  // On listing cards a bare "$2,200" is normally the current bid / price.
  if (facts.bid == null) {
    const m = /\$\s?([\d,]{1,9})(?!\s*(?:k|K)?\s*(?:fee|premium))/.exec(card.text);
    if (m) facts.bid = parseMoney(m[1]);
  }
  return { ext_id, url: card.href, title, ...facts };
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
