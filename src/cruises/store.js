// Cruises: every cruise read off OzCruising's departure-port pages, with its fare history.
import { db } from '../db.js';
import { keyOf, MIN_NIGHT } from './parse.js';

db.exec(`
CREATE TABLE IF NOT EXISTS cruises (
  key TEXT PRIMARY KEY, code TEXT, url TEXT, title TEXT, ship TEXT, line TEXT, port TEXT, nights INTEGER, depart TEXT,
  twin REAL, triple REAL, quad REAL, solo REAL, fares TEXT, badge TEXT,
  first_twin REAL, low_twin REAL, prev_twin REAL, price_at INTEGER, src TEXT,
  status TEXT NOT NULL DEFAULT 'open', first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cruises_open ON cruises(status, depart);
CREATE TABLE IF NOT EXISTS cruise_prices (key TEXT NOT NULL, at INTEGER NOT NULL, twin REAL, share REAL);
CREATE INDEX IF NOT EXISTS cruise_prices_key ON cruise_prices(key, at);
CREATE TABLE IF NOT EXISTS cruise_alerts (user TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, per_night REAL, PRIMARY KEY (user, key));
CREATE TABLE IF NOT EXISTS cruise_status (port TEXT PRIMARY KEY, last_ok INTEGER, last_count INTEGER, last_error TEXT, last_error_at INTEGER);
`);

// Fares read wrongly by an earlier version (a "$99 deposit" taken as the fare): cleared, so they're read again
// on the next scan and never count as first seen / lowest / a price drop.
db.exec(`UPDATE cruises SET twin = NULL WHERE nights > 0 AND twin IS NOT NULL AND twin / nights < ${MIN_NIGHT}`);
db.exec(`UPDATE cruises SET triple = NULL WHERE nights > 0 AND triple IS NOT NULL AND triple / nights < ${MIN_NIGHT}`);
db.exec(`UPDATE cruises SET quad = NULL WHERE nights > 0 AND quad IS NOT NULL AND quad / nights < ${MIN_NIGHT}`);
db.exec(`UPDATE cruises SET first_twin = NULL, low_twin = NULL, prev_twin = NULL WHERE nights > 0 AND (first_twin / nights < ${MIN_NIGHT} OR low_twin / nights < ${MIN_NIGHT} OR prev_twin / nights < ${MIN_NIGHT})`);
db.exec(`DELETE FROM cruise_alerts WHERE per_night < ${MIN_NIGHT}`);
db.exec(`DELETE FROM cruise_prices WHERE key IN (SELECT key FROM cruises WHERE nights > 0) AND (twin / (SELECT nights FROM cruises c WHERE c.key = cruise_prices.key) < ${MIN_NIGHT})`);

const shareOf = r => { const a = [r.triple, r.quad].filter(v => v != null); return a.length ? Math.min(...a) : null; };
const get = db.prepare('SELECT * FROM cruises WHERE key = ?');
const ins = db.prepare(`INSERT INTO cruises (key, code, url, title, ship, line, port, nights, depart, twin, triple, quad, solo, fares, badge,
  first_twin, low_twin, prev_twin, price_at, src, status, first_seen, last_seen)
  VALUES (:key, :code, :url, :title, :ship, :line, :port, :nights, :depart, :twin, :triple, :quad, :solo, :fares, :badge,
  :twin, :twin, NULL, NULL, :src, 'open', :now, :now)`);
const upd = db.prepare(`UPDATE cruises SET code = COALESCE(:code, code), url = COALESCE(:url, url), title = COALESCE(:title, title),
  ship = COALESCE(:ship, ship), line = COALESCE(:line, line), port = COALESCE(:port, port), nights = COALESCE(:nights, nights),
  depart = COALESCE(:depart, depart), twin = :twin, triple = :triple, quad = :quad, solo = :solo, fares = COALESCE(:fares, fares), badge = :badge,
  first_twin = COALESCE(first_twin, :twin), low_twin = CASE WHEN :twin IS NOT NULL AND (low_twin IS NULL OR :twin < low_twin) THEN :twin ELSE low_twin END,
  prev_twin = :prev, price_at = :price_at, src = COALESCE(src, :src), status = 'open', last_seen = :now WHERE key = :key`);
const hist = db.prepare('INSERT INTO cruise_prices (key, at, twin, share) VALUES (?, ?, ?, ?)');

/** Save one cruise as read now. Returns { key, isNew, dropped } (dropped: $ off the twin fare since the last read). */
export function upsertCruise(r, now = Date.now(), src = 'scan') {
  const key = keyOf(r);
  const row = { key, code: r.code ?? null, url: r.url ?? null, title: r.title ?? null, ship: r.ship ?? null, line: r.line ?? null, port: r.port ?? null,
    nights: r.nights ?? null, depart: r.depart ?? null, twin: r.twin ?? null, triple: r.triple ?? null, quad: r.quad ?? null, solo: r.solo ?? null,
    fares: r.fares?.length ? JSON.stringify(r.fares) : null, badge: r.badge ?? null, src, now };
  const old = get.get(key);
  if (!old) {
    ins.run(row);
    hist.run(key, now, row.twin, shareOf(row));
    return { key, isNew: true, dropped: 0 };
  }
  const changed = old.twin !== row.twin || shareOf(old) !== shareOf(row);
  upd.run({ ...row, prev: changed ? old.twin : old.prev_twin, price_at: changed ? now : old.price_at });
  if (changed) hist.run(key, now, row.twin, shareOf(row));
  return { key, isNew: false, dropped: changed && old.twin != null && row.twin != null ? Math.max(0, old.twin - row.twin) : 0 };
}

export const cz = {
  get,
  open: db.prepare(`SELECT * FROM cruises WHERE status = 'open' AND (depart IS NULL OR depart >= ?) ORDER BY depart`),
  expire: db.prepare(`UPDATE cruises SET status = 'gone' WHERE status = 'open' AND (last_seen < ? OR (depart IS NOT NULL AND depart < ?))`),
  history: db.prepare('SELECT at, twin, share FROM cruise_prices WHERE key = ? ORDER BY at'),
  alerted: db.prepare('SELECT key FROM cruise_alerts WHERE user = ?'),
  addAlert: db.prepare('INSERT OR IGNORE INTO cruise_alerts (user, key, at, per_night) VALUES (?, ?, ?, ?)'),
  statusOk: db.prepare(`INSERT INTO cruise_status (port, last_ok, last_count) VALUES (?, ?, ?) ON CONFLICT(port) DO UPDATE SET last_ok = excluded.last_ok, last_count = excluded.last_count`),
  statusErr: db.prepare(`INSERT INTO cruise_status (port, last_error, last_error_at) VALUES (?, ?, ?) ON CONFLICT(port) DO UPDATE SET last_error = excluded.last_error, last_error_at = excluded.last_error_at`),
  statusAll: db.prepare('SELECT * FROM cruise_status'),
  count: db.prepare(`SELECT COUNT(*) n FROM cruises WHERE status = 'open'`),
};
