import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, 'auctions.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS lots (
  key TEXT PRIMARY KEY, site TEXT NOT NULL, ext_id TEXT NOT NULL, url TEXT, title TEXT,
  category TEXT, year INTEGER, make TEXT, model TEXT, odometer INTEGER, wovr TEXT,
  location TEXT, state TEXT, image TEXT, buy_method TEXT, sale_name TEXT, lot_no TEXT,
  bid REAL, bid_count INTEGER, buy_now REAL, start_price REAL, end_at INTEGER,
  status TEXT NOT NULL DEFAULT 'open', first_seen INTEGER, last_seen INTEGER, last_checked INTEGER,
  starred INTEGER NOT NULL DEFAULT 0, manual_estimate REAL, est_low REAL, est_high REAL,
  est_note TEXT, est_at INTEGER, final_bid REAL, closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS lots_end ON lots(status, end_at);
CREATE TABLE IF NOT EXISTS bids (key TEXT NOT NULL, at INTEGER NOT NULL, bid REAL NOT NULL);
CREATE INDEX IF NOT EXISTS bids_key ON bids(key, at);
CREATE TABLE IF NOT EXISTS alerts (key TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, message TEXT, PRIMARY KEY(key, kind));
CREATE TABLE IF NOT EXISTS site_status (site TEXT PRIMARY KEY, last_ok INTEGER, last_count INTEGER, last_error TEXT, last_error_at INTEGER, logged_in INTEGER);
`);
for (const col of ['final_seen_at INTEGER']) { try { db.exec(`ALTER TABLE lots ADD COLUMN ${col}`); } catch { /* exists */ } }
// v1.1 cleanup: drop duplicate Pickles records created from internal ids
db.exec(`DELETE FROM lots WHERE site = 'pickles' AND url LIKE '%/used/details/items/%'`);

const FIELDS = ['url', 'title', 'category', 'year', 'make', 'model', 'odometer', 'wovr', 'location', 'state', 'image',
  'buy_method', 'sale_name', 'lot_no', 'bid', 'bid_count', 'buy_now', 'start_price', 'end_at'];

const upsertStmt = db.prepare(`
INSERT INTO lots (key, site, ext_id, ${FIELDS.join(', ')}, first_seen, last_seen, last_checked)
VALUES (:key, :site, :ext_id, ${FIELDS.map(f => ':' + f).join(', ')}, :now, :now, :checked)
ON CONFLICT(key) DO UPDATE SET
  ${FIELDS.map(f => `${f} = COALESCE(excluded.${f}, lots.${f})`).join(',\n  ')},
  last_seen = excluded.last_seen,
  last_checked = COALESCE(excluded.last_checked, lots.last_checked),
  status = CASE WHEN lots.status = 'closed' AND excluded.end_at > :now THEN 'open' ELSE lots.status END
`);
const getBidStmt = db.prepare('SELECT bid FROM lots WHERE key = ?');
const addBidStmt = db.prepare('INSERT INTO bids (key, at, bid) VALUES (?, ?, ?)');

/** Insert or merge a normalised lot. Never overwrites known values with nulls. */
export function upsertLot(lot, { checked = false } = {}) {
  const now = Date.now();
  const key = `${lot.site}:${lot.ext_id}`;
  const prev = getBidStmt.get(key);
  const row = { key, site: lot.site, ext_id: String(lot.ext_id), now, checked: checked ? now : null };
  for (const f of FIELDS) row[f] = lot[f] ?? null;
  upsertStmt.run(row);
  if (lot.bid != null && (!prev || prev.bid !== lot.bid)) addBidStmt.run(key, now, lot.bid);
  return key;
}

export const q = {
  lot: db.prepare('SELECT * FROM lots WHERE key = ?'),
  openWindow: db.prepare(`SELECT * FROM lots WHERE status = 'open' AND end_at IS NOT NULL AND end_at BETWEEN ? AND ? ORDER BY end_at`),
  dashboard: db.prepare(`SELECT * FROM lots WHERE status = 'open' AND (end_at IS NULL OR end_at > ?) AND (end_at IS NULL OR end_at < ?) ORDER BY end_at IS NULL, end_at LIMIT ?`),
  recentClosed: db.prepare(`SELECT * FROM lots WHERE status = 'closed' AND closed_at > ? AND final_bid IS NOT NULL ORDER BY end_at DESC LIMIT 1000`),
  closeDue: db.prepare(`UPDATE lots SET status = 'closed', final_bid = bid, final_seen_at = last_checked, closed_at = ? WHERE status = 'open' AND end_at < ? RETURNING key`),
  star: db.prepare('UPDATE lots SET starred = ? WHERE key = ?'),
  watchedOpen: db.prepare(`SELECT * FROM lots WHERE starred = 1 AND status = 'open' ORDER BY end_at IS NULL, end_at`),
  watchlist: db.prepare(`SELECT * FROM lots WHERE starred = 1 AND (status = 'open' OR closed_at > ?) ORDER BY status = 'closed', end_at IS NULL, end_at`),
  addWatch: db.prepare(`INSERT INTO lots (key, site, ext_id, url, starred, first_seen, last_seen) VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(key) DO UPDATE SET starred = 1, status = CASE WHEN lots.end_at IS NULL OR lots.end_at > ? THEN 'open' ELSE lots.status END`),
  manualEstimate: db.prepare('UPDATE lots SET manual_estimate = ? WHERE key = ?'),
  setEstimate: db.prepare('UPDATE lots SET est_low = ?, est_high = ?, est_note = ?, est_at = ? WHERE key = ?'),
  needsEstimate: db.prepare(`SELECT * FROM lots WHERE status = 'open' AND est_at IS NULL AND manual_estimate IS NULL AND end_at BETWEEN ? AND ? ORDER BY end_at LIMIT ?`),
  alertSent: db.prepare('SELECT 1 FROM alerts WHERE key = ? AND kind = ?'),
  addAlert: db.prepare('INSERT OR IGNORE INTO alerts (key, kind, at, message) VALUES (?, ?, ?, ?)'),
  recentAlerts: db.prepare('SELECT * FROM alerts ORDER BY at DESC LIMIT 50'),
  alertKinds: db.prepare('SELECT key, kind FROM alerts WHERE at > ?'),
  bidHistory: db.prepare('SELECT at, bid FROM bids WHERE key = ? ORDER BY at'),
  statusOk: db.prepare(`INSERT INTO site_status (site, last_ok, last_count) VALUES (?, ?, ?)
    ON CONFLICT(site) DO UPDATE SET last_ok = excluded.last_ok, last_count = excluded.last_count`),
  statusErr: db.prepare(`INSERT INTO site_status (site, last_error, last_error_at) VALUES (?, ?, ?)
    ON CONFLICT(site) DO UPDATE SET last_error = excluded.last_error, last_error_at = excluded.last_error_at`),
  statusLogin: db.prepare(`INSERT INTO site_status (site, logged_in) VALUES (?, ?)
    ON CONFLICT(site) DO UPDATE SET logged_in = excluded.logged_in`),
  statusAll: db.prepare('SELECT * FROM site_status'),
};
