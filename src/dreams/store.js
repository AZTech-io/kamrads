// Dreams: the vehicles we want to own, every auction lot that could be one, and what the same thing
// costs to buy from a dealer or private seller (Trucksales / Carsales listings pasted in).
import { db } from '../db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS dreams (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL, user TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'hunting', settings TEXT, created_at INTEGER, updated_at INTEGER, found_key TEXT
);
CREATE TABLE IF NOT EXISTS dream_hits (
  dream_id INTEGER NOT NULL, key TEXT NOT NULL, match TEXT NOT NULL, at INTEGER NOT NULL, notified INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (dream_id, key)
);
CREATE INDEX IF NOT EXISTS dream_hits_key ON dream_hits(key);
CREATE TABLE IF NOT EXISTS dream_alerts (dream_id INTEGER NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (dream_id, key, kind));
CREATE TABLE IF NOT EXISTS dream_market (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL UNIQUE, source TEXT, title TEXT NOT NULL, year INTEGER,
  price REAL, prev_price REAL, price_note TEXT, km INTEGER, gvm INTEGER, hp INTEGER, trans TEXT, body TEXT,
  seller TEXT, condition TEXT, state TEXT, location TEXT, url TEXT, first_seen INTEGER, last_seen INTEGER, import_id INTEGER, hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS dream_imports (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, at INTEGER, source TEXT, found INTEGER, added INTEGER, updated INTEGER, lots INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS dream_lot_notes (key TEXT PRIMARY KEY, repair REAL, note TEXT, by TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS dream_meta (k TEXT PRIMARY KEY, v TEXT);
`);

export const dq = {
  all: db.prepare('SELECT * FROM dreams ORDER BY id'),
  one: db.prepare('SELECT * FROM dreams WHERE id = ?'),
  add: db.prepare('INSERT INTO dreams (name, kind, user, status, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'),
  update: db.prepare('UPDATE dreams SET name = ?, status = ?, settings = ?, found_key = ?, updated_at = ? WHERE id = ?'),
  del: db.prepare('DELETE FROM dreams WHERE id = ?'),
  delHits: db.prepare('DELETE FROM dream_hits WHERE dream_id = ?'),
  delAlerts: db.prepare('DELETE FROM dream_alerts WHERE dream_id = ?'),

  hit: db.prepare('INSERT INTO dream_hits (dream_id, key, match, at, notified) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET match = excluded.match'),
  hitExists: db.prepare('SELECT match FROM dream_hits WHERE dream_id = ? AND key = ?'),
  // "maybe" lots whose body we haven't tried to read off their page yet (one try each)
  maybeUnread: db.prepare(`SELECT DISTINCT l.* FROM dream_hits h JOIN lots l ON l.key = h.key JOIN dreams d ON d.id = h.dream_id
    WHERE h.match = 'maybe' AND d.status != 'paused' AND l.status = 'open' AND l.body IS NULL AND l.url IS NOT NULL AND (l.end_at IS NULL OR l.end_at > ?)
      AND NOT EXISTS (SELECT 1 FROM dream_alerts a WHERE a.dream_id = 0 AND a.key = l.key AND a.kind = 'bodyread') ORDER BY l.end_at IS NULL, l.end_at LIMIT ?`),
  hitsOf: db.prepare(`SELECT h.match, h.at AS hit_at, l.* FROM dream_hits h JOIN lots l ON l.key = h.key WHERE h.dream_id = ?`),
  hitsForKey: db.prepare('SELECT h.dream_id, h.match, d.* FROM dream_hits h JOIN dreams d ON d.id = h.dream_id WHERE h.key = ?'),
  dropHit: db.prepare('DELETE FROM dream_hits WHERE dream_id = ? AND key = ?'),
  openHitKeys: db.prepare(`SELECT DISTINCT h.key FROM dream_hits h JOIN lots l ON l.key = h.key JOIN dreams d ON d.id = h.dream_id WHERE l.status = 'open' AND d.status != 'paused'`),

  alertSent: db.prepare('SELECT 1 FROM dream_alerts WHERE dream_id = ? AND key = ? AND kind = ?'),
  addAlert: db.prepare('INSERT OR IGNORE INTO dream_alerts (dream_id, key, kind, at) VALUES (?, ?, ?, ?)'),

  marketByUid: db.prepare('SELECT * FROM dream_market WHERE uid = ?'),
  marketAdd: db.prepare(`INSERT INTO dream_market (uid, source, title, year, price, price_note, km, gvm, hp, trans, body, seller, condition, state, location, url, first_seen, last_seen, import_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  marketSeen: db.prepare(`UPDATE dream_market SET last_seen = ?, prev_price = CASE WHEN ? IS NOT NULL AND price IS NOT NULL AND ? != price THEN price ELSE prev_price END,
    price = COALESCE(?, price), km = COALESCE(?, km), url = COALESCE(?, url), import_id = ? WHERE id = ?`),
  marketAll: db.prepare('SELECT * FROM dream_market WHERE hidden = 0 AND last_seen > ? ORDER BY price'),
  marketHide: db.prepare('UPDATE dream_market SET hidden = ? WHERE id = ?'),
  marketCount: db.prepare('SELECT count(*) AS n FROM dream_market WHERE hidden = 0'),

  addImport: db.prepare('INSERT INTO dream_imports (user, at, source, found, added, updated, lots, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'),
  setImport: db.prepare('UPDATE dream_imports SET found = ?, added = ?, updated = ?, lots = ? WHERE id = ?'),
  imports: db.prepare('SELECT * FROM dream_imports ORDER BY at DESC LIMIT 20'),

  note: db.prepare('SELECT * FROM dream_lot_notes WHERE key = ?'),
  setNote: db.prepare(`INSERT INTO dream_lot_notes (key, repair, note, by, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET repair = excluded.repair, note = excluded.note, by = excluded.by, at = excluded.at`),
  notes: db.prepare('SELECT * FROM dream_lot_notes'),

  // Every open lot that might be one (Isuzu in the title or body) - and, for custom dreams, everything open.
  openIsuzu: db.prepare(`SELECT * FROM lots WHERE status = 'open' AND (end_at IS NULL OR end_at > ?) AND (lower(COALESCE(title, '')) LIKE '%isuzu%' OR lower(COALESCE(make, '')) = 'isuzu')`),
  openAll: db.prepare(`SELECT * FROM lots WHERE status = 'open' AND (end_at IS NULL OR end_at > ?) AND title IS NOT NULL`),
  // Sold results we trust (read within 15 minutes of the close; Grays only after it), Isuzu only for the built-in dreams
  soldIsuzu: db.prepare(`SELECT * FROM lots WHERE status = 'closed' AND final_bid > 0 AND end_at > ? AND final_seen_at IS NOT NULL AND end_at - final_seen_at <= 900000
    AND (site != 'grays' OR final_seen_at >= end_at) AND COALESCE(reserve, '') != 'not met' AND (lower(COALESCE(title, '')) LIKE '%isuzu%' OR lower(COALESCE(make, '')) = 'isuzu') ORDER BY end_at DESC LIMIT 3000`),
  soldAll: db.prepare(`SELECT * FROM lots WHERE status = 'closed' AND final_bid > 0 AND end_at > ? AND final_seen_at IS NOT NULL AND end_at - final_seen_at <= 900000
    AND (site != 'grays' OR final_seen_at >= end_at) AND COALESCE(reserve, '') != 'not met' ORDER BY end_at DESC LIMIT 20000`),
  // Passed in (closed under the reserve): the top bid wasn't enough for the seller - shown, never used as a price
  passedIsuzu: db.prepare(`SELECT * FROM lots WHERE status = 'closed' AND reserve = 'not met' AND final_bid > 0 AND end_at > ?
    AND (lower(COALESCE(title, '')) LIKE '%isuzu%' OR lower(COALESCE(make, '')) = 'isuzu') ORDER BY end_at DESC LIMIT 300`),
  passedAll: db.prepare(`SELECT * FROM lots WHERE status = 'closed' AND reserve = 'not met' AND final_bid > 0 AND end_at > ? ORDER BY end_at DESC LIMIT 1000`),
  // a result read off a pasted lot page ("Sold for $13,900" / "Referred"): closed, with a price we trust
  markResult: db.prepare(`UPDATE lots SET status = 'closed', final_bid = ?, final_seen_at = ?, closed_at = COALESCE(closed_at, ?), end_at = COALESCE(?, end_at) WHERE key = ?`),
  // Closed lots that were dream hits but never got a trusted price (shown greyed, so nothing silently disappears)
  closedHits: db.prepare(`SELECT l.* FROM dream_hits h JOIN lots l ON l.key = h.key WHERE h.dream_id = ? AND l.status = 'closed' AND l.closed_at > ? ORDER BY l.end_at DESC LIMIT 300`),

  meta: db.prepare('SELECT v FROM dream_meta WHERE k = ?'),
  setMeta: db.prepare('INSERT INTO dream_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
};
