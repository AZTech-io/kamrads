// Freight jobs (Airtasker, Truckit...) in the same database as the auction lots.
import { db } from '../db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  key TEXT PRIMARY KEY, site TEXT NOT NULL, ext_id TEXT NOT NULL, url TEXT, title TEXT, category TEXT,
  price REAL, price_kind TEXT, from_text TEXT, to_text TEXT, km REAL, posted_at INTEGER, due_text TEXT,
  status TEXT NOT NULL DEFAULT 'open', offers INTEGER, first_seen INTEGER, last_seen INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_seen ON jobs(status, last_seen);
CREATE TABLE IF NOT EXISTS freight_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, kind TEXT NOT NULL,
  name TEXT, a_text TEXT, a_lat REAL, a_lon REAL, b_text TEXT, b_lat REAL, b_lon REAL, radius_km REAL, both_ways INTEGER,
  min_price REAL, created_at INTEGER);
CREATE TABLE IF NOT EXISTS freight_hits (alert_id INTEGER NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, notified INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(alert_id, key));
CREATE TABLE IF NOT EXISTS freight_status (site TEXT PRIMARY KEY, last_ok INTEGER, last_count INTEGER, last_error TEXT, last_error_at INTEGER);
-- Who rang / texted whom about a job, and how it went (shared, so nobody calls the same shipper twice)
CREATE TABLE IF NOT EXISTS job_contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, job_key TEXT NOT NULL, user TEXT NOT NULL, at INTEGER NOT NULL,
  method TEXT, outcome TEXT, quote REAL, note TEXT);
CREATE INDEX IF NOT EXISTS job_contacts_job ON job_contacts(job_key, at);
`);
// Later columns: dates on the job, how its age is known, the shipper's contact details (typed in by us)
{
  const have = new Set(db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name));
  for (const [c, t] of [['date_from', 'INTEGER'], ['date_by', 'INTEGER'], ['flexible', 'INTEGER'], ['age_basis', 'TEXT'],
    ['contact_name', 'TEXT'], ['contact_phone', 'TEXT'], ['dead', 'INTEGER']]) if (!have.has(c)) db.exec(`ALTER TABLE jobs ADD COLUMN ${c} ${t}`);
  const hs = new Set(db.prepare('PRAGMA table_info(freight_status)').all().map(c => c.name));
  for (const [c, t] of [['last_sweep', 'INTEGER'], ['last_sweep_n', 'INTEGER'], ['last_sweep_complete', 'INTEGER'], ['last_sweep_listed', 'INTEGER']])
    if (!hs.has(c)) db.exec(`ALTER TABLE freight_status ADD COLUMN ${c} ${t}`);
}

const F = ['url', 'title', 'category', 'price', 'price_kind', 'from_text', 'to_text', 'km', 'posted_at', 'due_text', 'offers', 'date_from', 'date_by', 'flexible', 'age_basis'];
const up = db.prepare(`INSERT INTO jobs (key, site, ext_id, ${F.join(', ')}, status, first_seen, last_seen)
  VALUES (:key, :site, :ext_id, ${F.map(f => ':' + f).join(', ')}, :status, :now, :now)
  ON CONFLICT(key) DO UPDATE SET ${F.map(f => `${f} = COALESCE(excluded.${f}, jobs.${f})`).join(', ')},
  status = excluded.status, last_seen = excluded.last_seen`);

const exists = db.prepare('SELECT 1 FROM jobs WHERE key = ?');
/** Save a job. `fresh`: it just appeared at the top of a list we were already watching, so it was
 *  posted about now (how we date Loadshift loads, which show no post date). */
export function upsertJob(j, now = Date.now(), { fresh = false } = {}) {
  const row = { key: `${j.site}:${j.ext_id}`, site: j.site, ext_id: String(j.ext_id), now, status: j.status || 'open' };
  for (const f of F) row[f] = typeof j[f] === 'string' && !j[f].trim() ? null : j[f] ?? null;
  if (row.flexible != null) row.flexible = row.flexible ? 1 : 0;
  if (row.posted_at != null) row.age_basis = 'posted';
  else if (fresh && !exists.get(row.key)) { row.posted_at = now; row.age_basis = 'seen'; }
  up.run(row);
  return row.key;
}

export const fq = {
  job: db.prepare('SELECT * FROM jobs WHERE key = ?'),
  // Jobs still listed recently (lists only show open jobs; one that drops off has been taken or expired)
  live: db.prepare(`SELECT * FROM jobs WHERE status = 'open' AND last_seen > ? ORDER BY COALESCE(posted_at, first_seen) DESC LIMIT 3000`),
  // Everything still listed (boards we read in full keep old jobs for weeks)
  open: db.prepare(`SELECT * FROM jobs WHERE status = 'open' ORDER BY COALESCE(posted_at, first_seen) DESC LIMIT 12000`),
  expire: db.prepare(`UPDATE jobs SET status = 'gone' WHERE status = 'open' AND last_seen < ?`),
  expireSite: db.prepare(`UPDATE jobs SET status = 'gone' WHERE status = 'open' AND site = ? AND last_seen < ?`),
  sweepOk: db.prepare(`INSERT INTO freight_status (site, last_sweep, last_sweep_n, last_sweep_complete, last_sweep_listed) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(site) DO UPDATE SET last_sweep = excluded.last_sweep, last_sweep_n = excluded.last_sweep_n, last_sweep_complete = excluded.last_sweep_complete, last_sweep_listed = excluded.last_sweep_listed`),
  anchors: db.prepare(`SELECT ext_id, posted_at FROM jobs WHERE site = ? AND age_basis = 'seen' AND posted_at > ? ORDER BY posted_at DESC LIMIT 2000`),
  undated: db.prepare(`SELECT key, ext_id, first_seen FROM jobs WHERE site = ? AND (age_basis IS NULL OR age_basis = 'est')`),
  setEst: db.prepare(`UPDATE jobs SET posted_at = ?, age_basis = 'est' WHERE key = ?`),
  setContact: db.prepare('UPDATE jobs SET contact_name = ?, contact_phone = ? WHERE key = ?'),
  setDead: db.prepare('UPDATE jobs SET dead = ? WHERE key = ?'),
  contactsOf: db.prepare('SELECT * FROM job_contacts WHERE job_key = ? ORDER BY at DESC, id DESC'),
  addContact: db.prepare('INSERT INTO job_contacts (job_key, user, at, method, outcome, quote, note) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'),
  delContact: db.prepare('DELETE FROM job_contacts WHERE id = ? AND job_key = ?'),
  lastContacts: db.prepare(`SELECT c.* FROM job_contacts c JOIN (SELECT job_key, max(id) AS id FROM job_contacts GROUP BY job_key) m ON m.id = c.id`),
  contactCounts: db.prepare('SELECT job_key, count(*) AS n FROM job_contacts GROUP BY job_key'),
  statusOk: db.prepare(`INSERT INTO freight_status (site, last_ok, last_count) VALUES (?, ?, ?) ON CONFLICT(site) DO UPDATE SET last_ok = excluded.last_ok, last_count = excluded.last_count`),
  statusErr: db.prepare(`INSERT INTO freight_status (site, last_error, last_error_at) VALUES (?, ?, ?) ON CONFLICT(site) DO UPDATE SET last_error = excluded.last_error, last_error_at = excluded.last_error_at`),
  statusAll: db.prepare('SELECT * FROM freight_status'),
  addAlert: db.prepare(`INSERT INTO freight_alerts (user, kind, name, a_text, a_lat, a_lon, b_text, b_lat, b_lon, radius_km, both_ways, min_price, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`),
  delAlert: db.prepare('DELETE FROM freight_alerts WHERE id = ? AND user = ?'),
  delHits: db.prepare('DELETE FROM freight_hits WHERE alert_id = ?'),
  alertsOf: db.prepare('SELECT * FROM freight_alerts WHERE user = ? ORDER BY id'),
  allAlerts: db.prepare('SELECT * FROM freight_alerts'),
  addHit: db.prepare('INSERT OR IGNORE INTO freight_hits (alert_id, key, at, notified) VALUES (?, ?, ?, ?)'),
  counts: db.prepare(`SELECT h.alert_id, count(*) AS n FROM freight_hits h JOIN jobs j ON j.key = h.key WHERE j.status = 'open' AND j.last_seen > ? GROUP BY h.alert_id`),
  stats: db.prepare(`SELECT count(*) AS jobs, sum(status = 'open') AS open FROM jobs`),
};
