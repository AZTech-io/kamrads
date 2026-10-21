// Loads we've quoted: amount, who quoted, won / lost, and once won, the job it became in
// Katara Freight's job register (katarafreight.com.au/tools/jobs), which picks them up through /api/v1.
import { db } from '../db.js';
import { config } from '../config.js';
import { fq } from './store.js';
import { ends } from './match.js';

db.exec(`
CREATE TABLE IF NOT EXISTS freight_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'quoted',
  amount REAL, fee_pct REAL, quoted_by TEXT, quoted_at INTEGER NOT NULL, pickup_date TEXT, notes TEXT,
  won_at INTEGER, closed_at INTEGER, converted_at INTEGER, ext_job_id TEXT, ext_job_no TEXT, ext_url TEXT, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS freight_quotes_job ON freight_quotes(job_key);
CREATE INDEX IF NOT EXISTS freight_quotes_upd ON freight_quotes(updated_at);
`);

export const QUOTE_STATUSES = ['quoted', 'won', 'lost', 'withdrawn', 'converted'];
const OPEN = ['quoted', 'won'];
const SITE_LABEL = { airtasker: 'Airtasker', truckit: 'Truckit', loadshift: 'Loadshift' };

// Called with a quote id after every change (push.js queues it for Katara Freight)
let changed = () => {};
export const onQuoteChange = fn => { changed = fn; };

const qq = {
  one: db.prepare('SELECT * FROM freight_quotes WHERE id = ?'),
  openFor: db.prepare(`SELECT * FROM freight_quotes WHERE job_key = ? AND status IN ('quoted', 'won') ORDER BY id DESC LIMIT 1`),
  forJob: db.prepare('SELECT * FROM freight_quotes WHERE job_key = ? ORDER BY id DESC'),
  all: db.prepare('SELECT * FROM freight_quotes ORDER BY updated_at DESC LIMIT 2000'),
  since: db.prepare('SELECT * FROM freight_quotes WHERE updated_at >= ? ORDER BY updated_at LIMIT 2000'),
  add: db.prepare(`INSERT INTO freight_quotes (job_key, status, amount, fee_pct, quoted_by, quoted_at, notes, won_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`),
};

/** Platform fee on a quote (inc GST, % of the price), as Katara Freight's job register uses them. */
export const feePctFor = site => config.freight.quoteFees[site] ?? 0;
const money = v => (v === '' || v == null ? null : Number(String(v).replace(/[$,\s]/g, '')));
const r2 = n => Math.round(n * 100) / 100;

/** A quote logged from the contact panel ("quoted $450") or a booking ("booked"). */
export function fromContact(jobKey, user, outcome, amount, note) {
  if (!['quoted', 'booked'].includes(outcome)) return null;
  const job = fq.job.get(jobKey);
  if (!job) return null;
  const now = Date.now();
  const amt = money(amount);
  const open = qq.openFor.get(jobKey);
  if (open) {
    const patch = { notes: note ? [open.notes, note].filter(Boolean).join(' · ').slice(0, 500) : undefined };
    if (amt != null) patch.amount = amt;
    if (outcome === 'booked') patch.status = 'won';
    update(open.id, patch);
    return open.id;
  }
  if (outcome === 'quoted' && amt == null) return null;   // nothing to track yet
  const id = qq.add.get(jobKey, outcome === 'booked' ? 'won' : 'quoted', amt, feePctFor(job.site), user, now, note || null,
    outcome === 'booked' ? now : null, now).id;
  changed(id);
  return id;
}

export function addQuote(jobKey, user, { amount, notes } = {}) {
  const job = fq.job.get(jobKey);
  if (!job) throw new Error('Job not found');
  const amt = money(amount);
  if (amt == null || !(amt > 0)) throw new Error('Enter the quote in dollars (inc GST).');
  const open = qq.openFor.get(jobKey);
  if (open) { update(open.id, { amount: amt, notes }); return open.id; }
  const now = Date.now();
  const id = qq.add.get(jobKey, 'quoted', amt, feePctFor(job.site), user, now, notes || null, null, now).id;
  changed(id);
  return id;
}

/** Status, amount, pickup date, notes. Converting (linking to a job) goes through convert(). */
export function update(id, patch) {
  const q = qq.one.get(id);
  if (!q) throw new Error('Quote not found');
  const now = Date.now();
  const sets = [], vals = [];
  const set = (k, v) => { sets.push(`${k} = ?`); vals.push(v); };
  if (patch.amount !== undefined) { const a = money(patch.amount); if (a != null && !(a >= 0)) throw new Error('Quote amount looks wrong'); set('amount', a); }
  if (patch.fee_pct !== undefined) { const f = money(patch.fee_pct); set('fee_pct', f == null ? null : Math.min(Math.max(f, 0), 100)); }
  if (patch.notes !== undefined) set('notes', patch.notes ? String(patch.notes).slice(0, 500) : null);
  if (patch.pickup_date !== undefined) {
    if (patch.pickup_date && !/^\d{4}-\d{2}-\d{2}$/.test(patch.pickup_date)) throw new Error('Pickup date should be YYYY-MM-DD');
    set('pickup_date', patch.pickup_date || null);
  }
  if (patch.status !== undefined && patch.status !== q.status) {
    const s = patch.status;
    if (!QUOTE_STATUSES.includes(s) || s === 'converted') throw new Error('Unknown status');
    set('status', s);
    if (s === 'won') { set('won_at', q.won_at || now); set('closed_at', null); }
    if (s === 'quoted') { set('won_at', null); set('closed_at', null); }
    if (s === 'lost' || s === 'withdrawn') set('closed_at', now);
    // reopening a converted quote unlinks it (e.g. the job was deleted in the register)
    if (q.status === 'converted') { set('converted_at', null); set('ext_job_id', null); set('ext_job_no', null); set('ext_url', null); }
  }
  if (!sets.length) return q;
  db.prepare(`UPDATE freight_quotes SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, now, id);
  changed(id);
  return qq.one.get(id);
}

/** The shipper's name or number changed: resend that job's open quotes. */
export function jobChanged(jobKey) { for (const q of qq.forJob.all(jobKey)) if (q.status !== 'lost' && q.status !== 'withdrawn') { db.prepare('UPDATE freight_quotes SET updated_at = ? WHERE id = ?').run(Date.now(), q.id); changed(q.id); } }

/** Katara Freight made a job from this quote. Safe to repeat; a different job id is refused. */
export function convert(id, { jobId, jobNo, url } = {}) {
  const q = qq.one.get(id);
  if (!q) return { status: 404, error: 'Quote not found' };
  if (jobId == null || jobId === '') return { status: 400, error: 'jobId is required' };
  if (q.status === 'converted') {
    if (String(q.ext_job_id) === String(jobId)) return { status: 200, quote: q, already: true };
    return { status: 409, error: `Already converted to job ${q.ext_job_no || q.ext_job_id}`, quote: q };
  }
  if (['lost', 'withdrawn'].includes(q.status)) return { status: 409, error: `Quote is ${q.status}` };
  const now = Date.now();
  db.prepare(`UPDATE freight_quotes SET status = 'converted', won_at = COALESCE(won_at, ?), converted_at = ?, ext_job_id = ?, ext_job_no = ?, ext_url = ?, updated_at = ? WHERE id = ?`)
    .run(now, now, String(jobId).slice(0, 40), jobNo ? String(jobNo).slice(0, 40) : null, url && /^https:\/\//.test(url) ? String(url).slice(0, 300) : null, now, id);
  changed(id);
  return { status: 200, quote: qq.one.get(id) };
}

export const getQuote = id => qq.one.get(id);
export const quotesForJob = key => qq.forJob.all(key);
export const openQuoteFor = key => qq.openFor.get(key);

export function listQuotes({ statuses = null, since = null } = {}) {
  const rows = since != null ? qq.since.all(since) : qq.all.all();
  return statuses?.length ? rows.filter(q => statuses.includes(q.status)) : rows;
}

// ---- the shape Katara Freight reads ----
const PLACE = /^(.*?)\s+(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b(?:\s+(\d{4}))?/;
function placeOut(text, pt) {
  const m = PLACE.exec(text || '');
  return { text: text || null, suburb: m ? m[1] : text || null, state: m?.[2] || pt?.state || null, postcode: m?.[3] || null,
    lat: pt?.lat ?? null, lon: pt?.lon ?? null };
}
const iso = t => (t ? new Date(t).toISOString() : null);

export function quoteOut(q, { base = '' } = {}) {
  const j = fq.job.get(q.job_key) || { key: q.job_key, site: q.job_key.split(':')[0] };
  const e = j.from_text ? ends(j) : {};
  const amount = q.amount;
  const feePct = q.fee_pct ?? 0;
  const fee = amount != null ? r2(amount * feePct / 100) : null;
  const weight = (/([\d,.]+\s*(?:kg|t|tonnes?))\b/i.exec(j.due_text || '') || [])[1] || null;
  const qty = Number((/qty\s+(\d+)/i.exec(j.due_text || '') || [])[1]) || null;
  return {
    id: q.id, status: q.status,
    amount, gstIncluded: true, feePct, fee, net: amount != null ? r2(amount - fee) : null,
    quotedBy: q.quoted_by, quotedAt: iso(q.quoted_at), wonAt: iso(q.won_at), closedAt: iso(q.closed_at),
    pickupDate: q.pickup_date, notes: q.notes,
    job: q.status === 'converted' ? { id: q.ext_job_id, no: q.ext_job_no, url: q.ext_url, at: iso(q.converted_at) } : null,
    source: { site: j.site, label: SITE_LABEL[j.site] || j.site, ref: j.site === 'loadshift' || j.site === 'airtasker' ? j.ext_id ?? null : null,
      url: j.url ?? null, listed: j.status === 'open', firstSeen: iso(j.first_seen) },
    load: { title: j.title ?? null, category: j.category ?? null, weight, qty, km: j.km ?? null, due: j.due_text ?? null,
      readyFrom: iso(j.date_from), dueBy: iso(j.date_by) },
    pickup: placeOut(j.from_text, e.from), dropoff: placeOut(j.to_text, e.to),
    customer: { name: j.contact_name ?? null, phone: j.contact_phone ?? null },
    updatedAt: iso(q.updated_at),
    links: base ? { self: `${base}/api/v1/quotes/${q.id}`, convert: `${base}/api/v1/quotes/${q.id}/convert`, board: `${base}/freight#quotes` } : undefined,
  };
}
export { OPEN as OPEN_QUOTES };
