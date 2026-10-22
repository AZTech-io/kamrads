// Finds: Swoopa-style saved searches over Facebook Marketplace, Gumtree and eBay (plus matching auction lots).
import { db } from '../db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS find_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, name TEXT, terms TEXT NOT NULL,
  place TEXT, lat REAL, lon REAL, state TEXT, radius_km REAL, min_price REAL, max_price REAL,
  sources TEXT NOT NULL DEFAULT 'facebook,gumtree,ebay', fb_area TEXT, alerts INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS find_items (
  key TEXT PRIMARY KEY, site TEXT NOT NULL, ext_id TEXT NOT NULL, url TEXT, title TEXT, price REAL,
  location TEXT, lat REAL, lon REAL, state TEXT, image TEXT, posted_at INTEGER,
  status TEXT NOT NULL DEFAULT 'open', first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS find_items_seen ON find_items(status, last_seen);
CREATE TABLE IF NOT EXISTS find_hits (search_id INTEGER NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, notified INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (search_id, key));
CREATE TABLE IF NOT EXISTS find_status (site TEXT PRIMARY KEY, last_ok INTEGER, last_count INTEGER, last_error TEXT, last_error_at INTEGER);
`);
// scanned_at: when the search's own queries first ran; primed: its first matches have been recorded quietly
{
  const have = new Set(db.prepare('PRAGMA table_info(find_searches)').all().map(c => c.name));
  for (const [c, t] of [['scanned_at', 'INTEGER'], ['primed', 'INTEGER NOT NULL DEFAULT 0']]) if (!have.has(c)) db.exec(`ALTER TABLE find_searches ADD COLUMN ${c} ${t}`);
}

const F = ['url', 'title', 'price', 'location', 'lat', 'lon', 'state', 'image', 'posted_at'];
const up = db.prepare(`INSERT INTO find_items (key, site, ext_id, ${F.join(', ')}, status, first_seen, last_seen)
  VALUES (:key, :site, :ext_id, ${F.map(f => ':' + f).join(', ')}, 'open', :now, :now)
  ON CONFLICT(key) DO UPDATE SET ${F.map(f => `${f} = COALESCE(excluded.${f}, find_items.${f})`).join(', ')}, status = 'open', last_seen = excluded.last_seen`);

export function upsertItem(it, now = Date.now()) {
  const row = { key: `${it.site}:${it.ext_id}`, site: it.site, ext_id: String(it.ext_id), now };
  for (const f of F) row[f] = typeof it[f] === 'string' && !it[f].trim() ? null : it[f] ?? null;
  up.run(row);
  return row.key;
}

export const fz = {
  item: db.prepare('SELECT * FROM find_items WHERE key = ?'),
  open: db.prepare(`SELECT * FROM find_items WHERE status = 'open' ORDER BY COALESCE(posted_at, first_seen) DESC LIMIT 5000`),
  expire: db.prepare(`UPDATE find_items SET status = 'gone' WHERE status = 'open' AND last_seen < ?`),
  setPlace: db.prepare('UPDATE find_items SET lat = ?, lon = ?, state = COALESCE(state, ?) WHERE key = ?'),
  unplaced: db.prepare(`SELECT key, location FROM find_items WHERE status = 'open' AND lat IS NULL AND location IS NOT NULL LIMIT 400`),
  searches: db.prepare('SELECT * FROM find_searches ORDER BY id'),
  searchesOf: db.prepare('SELECT * FROM find_searches WHERE user = ? ORDER BY id'),
  search: db.prepare('SELECT * FROM find_searches WHERE id = ?'),
  addSearch: db.prepare(`INSERT INTO find_searches (user, name, terms, place, lat, lon, state, radius_km, min_price, max_price, sources, fb_area, alerts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`),
  delSearch: db.prepare('DELETE FROM find_searches WHERE id = ? AND user = ?'),
  delHits: db.prepare('DELETE FROM find_hits WHERE search_id = ?'),
  addHit: db.prepare('INSERT OR IGNORE INTO find_hits (search_id, key, at, notified) VALUES (?, ?, ?, ?)'),
  hitsOf: db.prepare('SELECT key, at, notified FROM find_hits WHERE search_id = ?'),
  scanned: db.prepare('UPDATE find_searches SET scanned_at = COALESCE(scanned_at, ?) WHERE id = ?'),
  primed: db.prepare('UPDATE find_searches SET primed = 1 WHERE id = ?'),
  statusOk: db.prepare(`INSERT INTO find_status (site, last_ok, last_count) VALUES (?, ?, ?) ON CONFLICT(site) DO UPDATE SET last_ok = excluded.last_ok, last_count = excluded.last_count`),
  statusErr: db.prepare(`INSERT INTO find_status (site, last_error, last_error_at) VALUES (?, ?, ?) ON CONFLICT(site) DO UPDATE SET last_error = excluded.last_error, last_error_at = excluded.last_error_at`),
  statusAll: db.prepare('SELECT * FROM find_status'),
};
