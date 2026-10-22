import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { identify, tidyTitle } from './vehicle.js';

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
for (const col of ['final_seen_at INTEGER', 'est_avg REAL', 'est_comps TEXT', 'est_method TEXT', 'buyer_premium REAL', 'gst_extra INTEGER', 'check_verdict TEXT', 'check_note TEXT', 'check_at INTEGER', 'opens_at INTEGER', 'reserve TEXT', 'ended_early INTEGER', 'market TEXT', 'premium_tiers TEXT']) { try { db.exec(`ALTER TABLE lots ADD COLUMN ${col}`); } catch { /* exists */ } }
db.exec(`UPDATE lots SET title = NULL WHERE title IS NOT NULL AND (trim(title) = '' OR title LIKE '%{{%')`);
db.exec(`UPDATE lots SET bid_count = NULL WHERE bid_count > 500`); // bad counts read from site-wide text
// v1.1 cleanup: drop duplicate Pickles records created from internal ids
db.exec(`DELETE FROM lots WHERE site = 'pickles' AND url LIKE '%/used/details/items/%'`);

// Per-user: what each person is watching, and the most they've bid (their max / proxy bid).
db.exec(`
CREATE TABLE IF NOT EXISTS watches (user TEXT NOT NULL, key TEXT NOT NULL, my_bid REAL, added_at INTEGER, PRIMARY KEY(user, key));
CREATE INDEX IF NOT EXISTS watches_key ON watches(key);
CREATE TABLE IF NOT EXISTS searches (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, terms TEXT NOT NULL,
  max_price REAL, site TEXT, created_at INTEGER, last_match_at INTEGER);
CREATE TABLE IF NOT EXISTS search_hits (search_id INTEGER NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, notified INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(search_id, key));
CREATE TABLE IF NOT EXISTS user_alerts (user TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(user, key, kind));
CREATE INDEX IF NOT EXISTS lots_closed ON lots(status, closed_at);
`);
// v1.2: stars from before logins existed belong to the main login
db.prepare(`INSERT OR IGNORE INTO watches (user, key, added_at) SELECT ?, key, ? FROM lots WHERE starred = 1`).run((config.dashUser || 'admin').toLowerCase(), Date.now());

// v1.3: Grays close times were sometimes taken from "similar items" on the lot page - clear them
// once so every Grays lot is re-read with the fixed reader.
const ver = db.prepare('PRAGMA user_version').get().user_version;
if (ver < 13) {
  db.exec(`UPDATE lots SET end_at = NULL, last_checked = NULL, status = 'open', closed_at = NULL, final_bid = NULL, final_seen_at = NULL WHERE site = 'grays'`);
  db.exec('PRAGMA user_version = 13');
}

// v1.4: fill make / model / year for everything stored so far
if (db.prepare('PRAGMA user_version').get().user_version < 14) {
  const set = db.prepare('UPDATE lots SET make = COALESCE(make, ?), model = COALESCE(model, ?), year = COALESCE(year, ?) WHERE key = ?');
  db.exec('BEGIN');
  for (const r of db.prepare('SELECT key, title, year FROM lots WHERE title IS NOT NULL AND (make IS NULL OR year IS NULL)').all()) {
    const id = identify(r);
    if (id) set.run(id.make, id.model, id.year, r.key);
  }
  db.exec('COMMIT');
  db.exec('PRAGMA user_version = 14');
}

// v1.5: tidy Pickles "CP: 01/2014, Hino, ..." titles already stored
if (db.prepare('PRAGMA user_version').get().user_version < 15) {
  const set = db.prepare('UPDATE lots SET title = ? WHERE key = ?');
  for (const r of db.prepare("SELECT key, title FROM lots WHERE title LIKE 'CP:%' OR title LIKE 'CP :%'").all()) set.run(tidyTitle(r.title), r.key);
  db.exec('PRAGMA user_version = 15');
}

// v1.6: which market a lot sells in ('salvage' when it came from a salvage search). Pickles lots stored
// before this were mostly from salvage searches: mark the ones that say so.
if (db.prepare('PRAGMA user_version').get().user_version < 16) {
  db.exec(`UPDATE lots SET market = 'salvage' WHERE market IS NULL AND site = 'pickles'
    AND (lower(COALESCE(sale_name, '')) LIKE '%salvage%' OR lower(COALESCE(url, '')) LIKE '%salvage%' OR lower(COALESCE(category, '')) LIKE '%salvage%'
      OR (wovr IS NOT NULL AND wovr NOT LIKE '%N/A%'))`);
  db.exec('PRAGMA user_version = 16');
}

const FIELDS = ['url', 'title', 'category', 'year', 'make', 'model', 'odometer', 'wovr', 'location', 'state', 'image',
  'buy_method', 'sale_name', 'lot_no', 'bid', 'bid_count', 'buy_now', 'start_price', 'end_at', 'buyer_premium', 'gst_extra', 'opens_at', 'reserve', 'market', 'premium_tiers'];

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
  if (lot.title && (/^\s*CP\s*:/i.test(lot.title) || /(?:image|photo|picture)\s*\d+\s*$/i.test(lot.title))) lot = { ...lot, title: tidyTitle(lot.title) };
  // Store what the vehicle is as clean columns (make / model / year), so our own results group properly.
  if (lot.title && (!lot.make || !lot.year)) {
    const id = identify(lot);
    if (id) lot = { ...lot, make: lot.make || id.make, model: lot.model || id.model, year: lot.year || id.year };
  }
  const row = { key, site: lot.site, ext_id: String(lot.ext_id), now, checked: checked ? now : null };
  // blank strings count as "don't know", so they never overwrite a real value
  for (const f of FIELDS) row[f] = typeof lot[f] === 'string' && !lot[f].trim() ? null : lot[f] ?? null;
  if (row.bid === 0) row.bid = null; // "$0" = no bid yet
  upsertStmt.run(row);
  if (lot.bid != null && (!prev || prev.bid !== lot.bid)) addBidStmt.run(key, now, lot.bid);
  return key;
}

export const q = {
  lot: db.prepare('SELECT * FROM lots WHERE key = ?'),
  openWindow: db.prepare(`SELECT * FROM lots WHERE status = 'open' AND end_at IS NOT NULL AND end_at BETWEEN ? AND ? ORDER BY end_at`),
  // Lots with no known close time only show in the widest view (they'd crowd "next 3 hours" otherwise).
  dashboard: db.prepare(`SELECT * FROM lots WHERE status = 'open' AND ((end_at > ? AND end_at < ?) OR (end_at IS NULL AND ? = 1)) ORDER BY end_at IS NULL, end_at LIMIT ?`),
  recentClosed: db.prepare(`SELECT * FROM lots WHERE status = 'closed' AND closed_at > ? ORDER BY end_at DESC LIMIT 3000`),
  closedStats: db.prepare(`SELECT site, count(*) AS closed, sum(final_bid IS NOT NULL) AS priced, sum(final_seen_at IS NOT NULL AND end_at - final_seen_at <= 60000) AS hammer FROM lots WHERE status = 'closed' AND closed_at > ? GROUP BY site`),
  // Sold or withdrawn before its listed close: close it now with the last price we saw.
  closeEarly: db.prepare(`UPDATE lots SET status = 'closed', final_bid = bid, final_seen_at = ?, closed_at = ?, ended_early = 1,
    end_at = CASE WHEN end_at IS NULL OR end_at > ? THEN ? ELSE end_at END WHERE key = ? AND status = 'open' RETURNING key`),
  dayWindow: db.prepare(`SELECT * FROM lots WHERE status = 'open' AND starred = 0 AND end_at BETWEEN ? AND ? AND (last_checked IS NULL OR last_checked < ?) ORDER BY end_at LIMIT ?`),
  closeDue: db.prepare(`UPDATE lots SET status = 'closed', final_bid = bid, final_seen_at = last_checked, closed_at = ? WHERE status = 'open' AND end_at < ? RETURNING key`),
  // What the scheduler uses: closed once read after its close time (soft closes can run on), or when long
  // past it with no read possible.
  closeConfirmed: db.prepare(`UPDATE lots SET status = 'closed', final_bid = bid, final_seen_at = last_checked, closed_at = ?
    WHERE status = 'open' AND end_at < ? AND (last_checked >= end_at OR end_at < ?) RETURNING key`),
  // Lots marked sold at their listed time without a read after it (before that rule): open them again for one.
  reopenUnconfirmed: db.prepare(`UPDATE lots SET status = 'open', closed_at = NULL, final_bid = NULL, final_seen_at = NULL
    WHERE status = 'closed' AND COALESCE(ended_early, 0) = 0 AND end_at > ? AND (last_checked IS NULL OR last_checked < end_at) AND site IN (SELECT value FROM json_each(?)) RETURNING key`),
  star: db.prepare('UPDATE lots SET starred = ? WHERE key = ?'),
  watchedOpen: db.prepare(`SELECT * FROM lots WHERE starred = 1 AND status = 'open' ORDER BY end_at IS NULL, end_at`),
  watchlist: db.prepare(`SELECT * FROM lots WHERE starred = 1 AND (status = 'open' OR closed_at > ?) ORDER BY status = 'closed', end_at IS NULL, end_at`),
  addWatch: db.prepare(`INSERT INTO lots (key, site, ext_id, url, starred, first_seen, last_seen) VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(key) DO UPDATE SET starred = 1, status = CASE WHEN lots.end_at IS NULL OR lots.end_at > ? THEN 'open' ELSE lots.status END`),
  manualEstimate: db.prepare('UPDATE lots SET manual_estimate = ? WHERE key = ?'),
  setEstimate: db.prepare('UPDATE lots SET est_low = ?, est_high = ?, est_note = ?, est_at = ? WHERE key = ?'),
  setResearch: db.prepare('UPDATE lots SET est_low = ?, est_high = ?, est_avg = ?, est_comps = ?, est_note = ?, est_method = ?, est_at = ? WHERE key = ?'),
  researchToday: db.prepare(`SELECT count(*) AS n FROM lots WHERE est_method = 'web' AND est_at > ?`),
  researchQueue: db.prepare(`SELECT * FROM lots WHERE status = 'open' AND est_at IS NULL AND manual_estimate IS NULL
    AND (starred = 1 OR (end_at BETWEEN ? AND ?)) ORDER BY starred DESC, end_at LIMIT 200`),
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

  // --- per-user watchlist ---
  watch: db.prepare(`INSERT INTO watches (user, key, added_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`),
  unwatch: db.prepare('DELETE FROM watches WHERE user = ? AND key = ?'),
  myBid: db.prepare(`INSERT INTO watches (user, key, my_bid, added_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user, key) DO UPDATE SET my_bid = excluded.my_bid`),
  syncStar: db.prepare(`UPDATE lots SET starred = EXISTS (SELECT 1 FROM watches w WHERE w.key = lots.key) WHERE key = ?`),
  myWatchKeys: db.prepare('SELECT key, my_bid FROM watches WHERE user = ?'),
  userWatchlist: db.prepare(`SELECT l.*, w.my_bid FROM watches w JOIN lots l ON l.key = w.key
    WHERE w.user = ? AND (l.status = 'open' OR l.closed_at > ?) ORDER BY l.status = 'closed', l.end_at IS NULL, l.end_at`),
  watchersOf: db.prepare('SELECT user, my_bid FROM watches WHERE key = ?'),
  // --- saved searches ---
  addSearch: db.prepare('INSERT INTO searches (user, terms, max_price, site, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id'),
  delSearch: db.prepare('DELETE FROM searches WHERE id = ? AND user = ?'),
  delSearchHits: db.prepare('DELETE FROM search_hits WHERE search_id = ?'),
  searchesOf: db.prepare('SELECT * FROM searches WHERE user = ? ORDER BY id'),
  allSearches: db.prepare('SELECT * FROM searches'),
  addHit: db.prepare('INSERT OR IGNORE INTO search_hits (search_id, key, at, notified) VALUES (?, ?, ?, ?)'),
  hitsOf: db.prepare(`SELECT l.* FROM search_hits h JOIN lots l ON l.key = h.key WHERE h.search_id = ? AND l.status = 'open' ORDER BY l.end_at`),
  hitCount: db.prepare(`SELECT h.search_id, count(*) AS n FROM search_hits h JOIN lots l ON l.key = h.key WHERE l.status = 'open' GROUP BY h.search_id`),
  searchesForLot: db.prepare('SELECT s.* FROM search_hits h JOIN searches s ON s.id = h.search_id WHERE h.key = ?'),
  touchSearch: db.prepare('UPDATE searches SET last_match_at = ? WHERE id = ?'),
  openLots: db.prepare(`SELECT key, site, title, category, sale_name, bid, start_price, end_at, wovr, url, location, state, odometer, first_seen FROM lots WHERE status = 'open' AND (end_at IS NULL OR end_at > ?)`),
  userAlertSent: db.prepare('SELECT 1 FROM user_alerts WHERE user = ? AND key = ? AND kind = ?'),
  addUserAlert: db.prepare('INSERT OR IGNORE INTO user_alerts (user, key, kind, at) VALUES (?, ?, ?, ?)'),
  clearUserAlert: db.prepare('DELETE FROM user_alerts WHERE user = ? AND key = ? AND kind = ?'),
  // --- history ---
  missed: db.prepare(`SELECT * FROM lots WHERE status = 'closed' AND closed_at > ? AND final_bid IS NOT NULL ORDER BY end_at DESC LIMIT 5000`),
  exportClosed: db.prepare(`SELECT site, ext_id, title, category, year, make, model, odometer, wovr, location, state, sale_name, lot_no,
    final_bid, bid_count, start_price, buy_now, manual_estimate, est_low, est_high, est_avg, end_at, final_seen_at, first_seen, url
    FROM lots WHERE status = 'closed' AND closed_at > ? ORDER BY end_at`),
  dbStats: db.prepare(`SELECT count(*) AS lots, sum(status = 'closed') AS closed, sum(final_bid IS NOT NULL) AS priced, min(first_seen) AS since FROM lots`),
  bidRows: db.prepare('SELECT count(*) AS n FROM bids'),
  // only results read within 15 min of the close count as real prices
  historyRows: db.prepare(`SELECT key, site, title, year, odometer, wovr, category, url, sale_name, buy_method, market, final_bid, end_at FROM lots
    WHERE status = 'closed' AND final_bid IS NOT NULL AND final_bid > 0 AND end_at > ? AND final_seen_at IS NOT NULL AND end_at - final_seen_at <= 900000
      -- Grays runs on past its listed close (soft close): only a price read after the close is a result
      AND (site != 'grays' OR final_seen_at >= end_at)`),
  setCheck: db.prepare('UPDATE lots SET check_verdict = ?, check_note = ?, check_at = ? WHERE key = ?'),
  checkQueue: db.prepare(`SELECT l.* FROM lots l WHERE l.status = 'open' AND l.check_at IS NULL AND l.end_at > ?
    AND EXISTS (SELECT 1 FROM watches w WHERE w.key = l.key AND w.my_bid IS NOT NULL) ORDER BY l.end_at LIMIT 5`),
  checksToday: db.prepare(`SELECT count(*) AS n FROM lots WHERE check_at > ?`),
  rivals: db.prepare('SELECT user, my_bid FROM watches WHERE key = ? AND user != ? AND my_bid IS NOT NULL'),
  missingTimes: db.prepare(`SELECT * FROM lots WHERE site = ? AND status = 'open' AND end_at IS NULL AND last_checked IS NULL AND url IS NOT NULL ORDER BY first_seen DESC LIMIT ?`),
  // lots closing in the next few days we don't know the place of yet (read their page once every 12 h)
  missingPlace: db.prepare(`SELECT * FROM lots WHERE site = ? AND status = 'open' AND location IS NULL AND state IS NULL AND url IS NOT NULL
    AND end_at BETWEEN ? AND ? AND (last_checked IS NULL OR last_checked < ?) ORDER BY end_at LIMIT ?`),
  closingToday: db.prepare(`SELECT * FROM lots WHERE status = 'open' AND end_at BETWEEN ? AND ? ORDER BY end_at`),
  bidExport: db.prepare(`SELECT l.site, l.ext_id, l.title, b.at AS seen_at, b.bid FROM bids b JOIN lots l ON l.key = b.key WHERE b.at > ? ORDER BY b.key, b.at`),
};
