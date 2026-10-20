// Where freight work is listed. Airtasker: public category pages (removals, delivery...), nationally and
// for the cities you work in - we read only these lists, never individual task pages.
// Truckit: the transporter job board (loaded by script, so the browser renders it).
import { withPage, looksBlocked } from '../browser.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { absUrl } from '../sites/common.js';
import { jobFromCard, jobsFromJson } from './parse.js';

/** Each link matching `re` with its own card text (climbing while the box holds only this one job). */
const jobCards = (page, re) => page.evaluate(src => {
  const rx = new RegExp(src, 'i');
  const out = new Map();
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href.split('#')[0];
    if (!rx.test(href)) continue;
    let box = a;
    for (let i = 0; i < 6 && box.parentElement; i++) {
      const p = box.parentElement;
      const others = new Set([...p.querySelectorAll('a[href]')].map(x => x.href.split('#')[0]).filter(h => rx.test(h)));
      if (others.size > 1) break;
      box = p;
    }
    const heading = (box.querySelector('h1,h2,h3,h4,h5,h6,[class*="title" i]')?.innerText || '').trim();
    const text = (box.innerText || a.innerText || '').trim();
    const prev = out.get(href);
    if (!prev || text.length > prev.text.length) out.set(href, { href, heading, text });
  }
  return [...out.values()];
}, re.source);

export const airtasker = {
  site: 'airtasker', label: 'Airtasker',
  // https://www.airtasker.com/tasks/collect-couch-from-fyshwick-and-deliver-to-lyneham-x01m59jffph0bcq12w1q92vv7z9
  re: /airtasker\.com\/tasks\/[a-z0-9-]+-x0[0-9a-z]{20,}/i,
  idFromUrl: u => (/-(x0[0-9a-z]{20,})(?:[/?#]|$)/i.exec(u || '') || [])[1] || null,
  pages() {
    const { categories, cities } = config.freight.airtasker;
    const out = [];
    for (const c of categories) { out.push({ url: `https://www.airtasker.com/au/jobs/${c}/`, category: c }); for (const city of cities) out.push({ url: `https://www.airtasker.com/au/jobs/${c}/${city}/`, category: c }); }
    return out;
  },
  async discover() {
    const all = new Map();
    for (const p of this.pages()) {
      try {
        const r = await withPage('airtasker', p.url, page => jobCards(page, this.re), { scrolls: 2, waitMs: 1200 });
        if (looksBlocked(r)) throw new Error(`blocked by Airtasker (HTTP ${r.status})`);
        if (r.status === 404) continue;
        let n = 0;
        for (const c of r.result || []) {
          const j = jobFromCard({ ...c, category: p.category }, { site: 'airtasker', idFromUrl: this.idFromUrl });
          if (j && !all.has(j.ext_id)) { all.set(j.ext_id, j); n++; }
        }
        log.info('airtasker', `${new URL(p.url).pathname}: ${n} new jobs`);
      } catch (e) { if (/blocked/.test(e.message)) throw e; log.warn('airtasker', `${p.url}: ${e.message}`); }
    }
    return [...all.values()];
  },
};

export const truckit = {
  site: 'truckit', label: 'Truckit',
  // Job links weren't visible without a browser; accept the usual shapes under the site.
  re: /truckit\.net\/(?:jobs?|job-details|search-for-jobs|freight-jobs?|listings?|quote|quotes)\/[^?#]*?\d{3,}/i,
  idFromUrl: u => { const m = String(u || '').split(/[?#]/)[0].match(/\d{3,}/g); return m ? m[m.length - 1] : null; },
  async discover() {
    const all = new Map();
    for (const url of config.freight.truckit.pages) {
      try {
        const r = await withPage('truckit', url, page => jobCards(page, this.re), { scrolls: 4, waitMs: 2000 });
        if (looksBlocked(r)) throw new Error(`blocked by Truckit (HTTP ${r.status})`);
        if (/log ?in to (?:view|see)|please log ?in|sign in to view/i.test(r.text?.slice(0, 3000) || '')) log.warn('truckit', 'the job board asks for a login - import your Truckit cookies (see README)');
        for (const c of r.result || []) {
          const j = jobFromCard(c, { site: 'truckit', idFromUrl: this.idFromUrl });
          if (j) all.set(j.ext_id, j);
        }
        for (const { body } of r.json) {
          for (const j of jobsFromJson(body, { site: 'truckit', urlFor: (o, id) => absUrl(o.url || o.link || o.slug || `/search-for-jobs/${id}`, 'https://www.truckit.net') })) if (!all.has(j.ext_id)) all.set(j.ext_id, j);
        }
        if (!all.size && r.json[0]) log.info('truckit', `no jobs recognised; sample JSON from ${r.json[0].url}: ${JSON.stringify(r.json[0].body).slice(0, 400)}`);
        log.info('truckit', `${new URL(url).pathname}: ${all.size} jobs (${(r.result || []).length} cards, ${r.json.length} data responses)`);
      } catch (e) { if (/blocked/.test(e.message)) throw e; log.warn('truckit', `${url}: ${e.message}`); }
    }
    return [...all.values()];
  },
};

export const freightSites = { airtasker, truckit };
