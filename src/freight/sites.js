// Where freight work is listed. Airtasker: public category pages (removals, delivery...), nationally and
// for the cities you work in - we read only these lists, never individual task pages.
// Truckit: the transporter job board (loaded by script, so the browser renders it).
import { withPage, looksBlocked, browserFetch } from '../browser.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { jobFromCard, truckitJob } from './parse.js';

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
  // The job board page loads its jobs from /api/frontend/search/jobs (public, no login needed).
  async discover() {
    const all = new Map();
    const add = body => { let n = 0; for (const rec of body?.data || []) { const j = truckitJob(rec); if (j && !all.has(j.ext_id)) { all.set(j.ext_id, j); n++; } } return n; };
    const board = config.freight.truckit.pages[0];
    const r = await withPage('truckit', board, null, { scrolls: 1, waitMs: 2500 });
    if (looksBlocked(r)) throw new Error(`blocked by Truckit (HTTP ${r.status})`);
    const feed = r.json.find(j => /\/api\/frontend\/search\/jobs/.test(j.url));
    if (!feed) { log.warn('truckit', `job feed not seen on ${board} (${r.json.length} data responses) - the site may have changed`); return []; }
    add(feed.body);
    // More pages, as long as each brings new jobs
    const pages = Math.min(Number(feed.body.page_count) || 1, config.freight.truckit.maxPages);
    for (let p = 2; p <= pages; p++) {
      try {
        const u = new URL(feed.url); u.searchParams.delete('initial'); u.searchParams.set('page', String(p)); u.searchParams.set('_', String(Date.now()));
        const res = await browserFetch('truckit', u.toString());
        if (res.status !== 200) break;
        if (!add(JSON.parse(res.text))) break;
      } catch (e) { log.warn('truckit', `page ${p}: ${e.message}`); break; }
    }
    log.info('truckit', `job board: ${all.size} jobs (${feed.body.record_count ?? '?'} listed, ${pages} page${pages === 1 ? '' : 's'} read)`);
    return [...all.values()];
  },
};

export const freightSites = { airtasker, truckit };
