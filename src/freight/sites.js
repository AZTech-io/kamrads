// Where freight work is listed. Airtasker: public category pages (removals, delivery...), nationally and
// for the cities you work in - we read only these lists, never individual task pages.
// Truckit: the transporter job board (loaded by script, so the browser renders it).
import { withPage, looksBlocked, browserFetch } from '../browser.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { jobFromCard, truckitJob, loadshiftJobsFromText, loadshiftRow, loadshiftRowsFromText } from './parse.js';

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

const sleep = ms => new Promise(r => setTimeout(r, ms));

export const truckit = {
  site: 'truckit', label: 'Truckit',
  // The job board page loads its jobs from /api/frontend/search/jobs (public, no login needed).
  // Regular scans read the newest few pages; the overnight sweep reads every page, slowly.
  async read({ maxPages = config.freight.truckit.maxPages, delayMs = 0 } = {}) {
    const all = new Map();
    const add = body => { let n = 0; for (const rec of body?.data || []) { const j = truckitJob(rec); if (j && !all.has(j.ext_id)) { all.set(j.ext_id, j); n++; } } return n; };
    const board = config.freight.truckit.pages[0];
    const r = await withPage('truckit', board, null, { scrolls: 1, waitMs: 2500 });
    if (looksBlocked(r)) throw new Error(`blocked by Truckit (HTTP ${r.status})`);
    const feed = r.json.find(j => /\/api\/frontend\/search\/jobs/.test(j.url));
    if (!feed) { log.warn('truckit', `job feed not seen on ${board} (${r.json.length} data responses) - the site may have changed`); return { jobs: [], complete: false, listed: null }; }
    add(feed.body);
    const pageCount = Number(feed.body.page_count) || 1;
    const listed = Number(feed.body.record_count) || null;
    const pages = Math.min(pageCount, maxPages);
    let p = 2, ok = true;
    for (; p <= pages; p++) {
      if (delayMs) await sleep(delayMs);
      try {
        const u = new URL(feed.url); u.searchParams.delete('initial'); u.searchParams.set('page', String(p)); u.searchParams.set('_', String(Date.now()));
        const res = await browserFetch('truckit', u.toString());
        if (res.status !== 200) { ok = false; break; }
        const body = JSON.parse(res.text);
        if (!(body?.data || []).length) break;     // ran out early: the list got shorter while we read it
        add(body);
      } catch (e) { log.warn('truckit', `page ${p}: ${e.message}`); ok = false; break; }
    }
    const readPages = Math.min(p - 1, pages);
    // a full read we can trust to say which jobs are gone
    const complete = ok && pages >= pageCount && (!listed || all.size >= listed * 0.9);
    log.info('truckit', `job board: ${all.size} jobs (${listed ?? '?'} listed, ${readPages} page${readPages === 1 ? '' : 's'} read${complete ? ', complete' : ''})`);
    return { jobs: [...all.values()], complete, listed };
  },
  async discover() { return (await this.read()).jobs; },
  sweep() { return this.read({ maxPages: config.freight.sweep.maxPages, delayMs: config.freight.sweep.delayMs }); },
};

export const loadshift = {
  site: 'loadshift', label: 'Loadshift',
  // Public load board: a table of the latest 100 loads (id, freight, qty, title, weight, pickup,
  // dropoff, distance, ready date), each row linking to /projects/<type>/<slug>. Sorted latest first.
  async page(p) {
    const url = new URL(config.freight.loadshift.pages[0]); if (p > 1) url.searchParams.set('page', String(p));
    const r = await withPage('loadshift', url.toString(), page => page.evaluate(() => {
      const rows = [];
      const seen = new Set();
      for (const a of document.querySelectorAll('a[href*="/projects/"]')) {
        let box = a;
        for (let i = 0; i < 8 && box.parentElement; i++) {
          box = box.parentElement;
          const t = box.innerText || '';
          if (/^\s*\d{7,9}\s*$/m.test(t) && /\d\s*km/i.test(t)) break;
        }
        const text = (box.innerText || '').trim();
        const id = (/^\s*(\d{7,9})\s*$/m.exec(text) || [])[1];
        if (!id || seen.has(id)) continue;
        // the box must hold just this one load
        if ((text.match(/^\s*\d{7,9}\s*$/gm) || []).length > 1) continue;
        seen.add(id);
        rows.push({ href: a.href.split('#')[0], text });
      }
      return rows;
    }), { scrolls: 2, waitMs: 2500 });
    if (looksBlocked(r)) throw new Error(`blocked by Loadshift (HTTP ${r.status})`);
    let jobs = (r.result || []).map(x => loadshiftRow(x.text.split('\n'), x.href)).filter(Boolean);
    if (!jobs.length) jobs = loadshiftRowsFromText(r.text);                 // rows not separable: read the page text
    if (!jobs.length) jobs = loadshiftJobsFromText(r.text);                 // older labelled layout
    // "Showing 1-100 of 1797"
    const m = /showing\s+[\d,]+\s*[-–]\s*[\d,]+\s+of\s+([\d,]+)/i.exec(r.text || '') || /\bloads\s+([\d,]{3,})/i.exec(r.text || '');
    return { url, jobs: jobs.map(j => ({ ...j, _page: p })), listed: m ? Number(m[1].replace(/,/g, '')) : null, rows: (r.result || []).length };
  },
  async read({ maxPages = config.freight.loadshift.maxPages, delayMs = 0 } = {}) {
    const all = new Map();
    let listed = null, ended = false, ok = true, perPage = 0, p = 1;
    for (; p <= maxPages; p++) {
      if (p > 1 && delayMs) await sleep(delayMs);
      let got;
      try { got = await this.page(p); } catch (e) { if (/blocked/.test(e.message)) throw e; log.warn('loadshift', `page ${p}: ${e.message}`); ok = false; break; }
      listed = got.listed ?? listed;
      perPage = Math.max(perPage, got.jobs.length);
      let fresh = 0;
      for (const j of got.jobs) if (!all.has(j.ext_id)) { all.set(j.ext_id, j); fresh++; }
      log.info('loadshift', `${got.url.pathname}${got.url.search}: ${fresh} new loads (${got.rows} linked rows)`);
      if (!fresh) break;                                         // paging repeats itself or ran dry
      if (got.jobs.length < perPage * 0.9) { ended = true; break; } // a short page: the last one
      if (listed && all.size >= listed) { ended = true; break; }
    }
    if (!all.size) log.warn('loadshift', 'no loads recognised - run: npm run probe-freight -- https://www.loadshift.com.au/search/loads');
    // only a read that reached the end (and holds about as many as the board says) can say what's gone
    const complete = ok && ended && (!listed || all.size >= listed * 0.9);
    return { jobs: [...all.values()], complete, listed };
  },
  async discover() { return (await this.read()).jobs; },
  sweep() { return this.read({ maxPages: config.freight.sweep.maxPages, delayMs: config.freight.sweep.delayMs }); },
};

export const freightSites = { airtasker, truckit, loadshift };
