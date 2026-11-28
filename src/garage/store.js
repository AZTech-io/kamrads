// Garage: our own vehicles, jet skis, beacons and toys (personal or company). Rego, insurance, VIN / HIN,
// battery and service history, hours or km, with phone reminders before anything runs out.
// Each login sees only their own; admins (the main login, plus anyone it makes admin) see everyone's.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import * as settings from '../settings.js';

db.exec(`
CREATE TABLE IF NOT EXISTS garage_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
  make TEXT, model TEXT, year INTEGER, colour TEXT, rego TEXT, rego_state TEXT, ident TEXT, engine_no TEXT,
  belongs_to TEXT, entity TEXT, kept_at TEXT, meter TEXT, meter_value REAL, meter_date TEXT, tracker_id TEXT,
  notes TEXT, photo_id INTEGER, archived INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER, updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS garage_assets_owner ON garage_assets(owner);
CREATE TABLE IF NOT EXISTS garage_dues (
  id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL,
  due_date TEXT, due_meter REAL, every_months INTEGER, every_meter REAL,
  provider TEXT, ref TEXT, phone TEXT, cost REAL, notes TEXT, last_date TEXT, last_meter REAL, created_at INTEGER, updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS garage_dues_a ON garage_dues(asset_id);
CREATE TABLE IF NOT EXISTS garage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL, title TEXT,
  meter REAL, cost REAL, done_by TEXT, notes TEXT, due_id INTEGER, added_by TEXT, created_at INTEGER
);
CREATE INDEX IF NOT EXISTS garage_logs_a ON garage_logs(asset_id, date);
CREATE TABLE IF NOT EXISTS garage_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER NOT NULL, log_id INTEGER, name TEXT, mime TEXT, size INTEGER,
  stored TEXT NOT NULL, added_by TEXT, created_at INTEGER
);
CREATE INDEX IF NOT EXISTS garage_files_a ON garage_files(asset_id);
CREATE TABLE IF NOT EXISTS garage_alerts (due_id INTEGER NOT NULL, stage TEXT NOT NULL, ref TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(due_id, stage, ref));
`);

export const FILE_DIR = path.join(config.dataDir, 'garage');

// What each kind of thing usually needs tracking. "ask" is what the add form asks for: when it expires
// (rego, insurance) or when it was last done (service, battery). "from" is where the next one counts from:
// a renewal runs on from the old expiry (paying early doesn't move it), a service from the day it's done.
const EXPIRES = { ask: 'expires', from: 'due' }, LAST = { ask: 'last', from: 'done' };
const D = (kind, label, extra = {}) => ({ kind, label, ...(['rego', 'insurance', 'registration'].includes(kind) ? EXPIRES : LAST), ...extra });
export const KINDS = {
  jetski: { label: 'Jet ski', icon: '🌊', meter: 'hours', ident: 'HIN (hull ID)', dues: [D('rego', 'Rego', { every_months: 12 }), D('insurance', 'Insurance', { every_months: 12 }), D('service', 'Service', { every_months: 12, every_meter: 100 }), D('battery', 'Battery', { every_months: 36 })] },
  car: { label: 'Car, ute or van', icon: '🚗', meter: 'km', ident: 'VIN', dues: [D('rego', 'Rego', { every_months: 12 }), D('insurance', 'Insurance', { every_months: 12 }), D('service', 'Service', { every_months: 12, every_meter: 10000 }), D('battery', 'Battery', { every_months: 48 })] },
  motorbike: { label: 'Motorbike', icon: '🏍️', meter: 'km', ident: 'VIN', dues: [D('rego', 'Rego', { every_months: 12 }), D('insurance', 'Insurance', { every_months: 12 }), D('service', 'Service', { every_months: 12, every_meter: 6000 }), D('battery', 'Battery', { every_months: 36 })] },
  truck: { label: 'Truck', icon: '🚚', meter: 'km', ident: 'VIN', dues: [D('rego', 'Rego', { every_months: 12 }), D('insurance', 'Insurance', { every_months: 12 }), D('service', 'Service', { every_months: 12, every_meter: 15000 }), D('battery', 'Battery', { every_months: 48 })] },
  boat: { label: 'Boat', icon: '🚤', meter: 'hours', ident: 'HIN (hull ID)', dues: [D('rego', 'Rego', { every_months: 12 }), D('insurance', 'Insurance', { every_months: 12 }), D('service', 'Service', { every_months: 12, every_meter: 100 }), D('battery', 'Battery', { every_months: 36 })] },
  trailer: { label: 'Trailer', icon: '🛞', meter: null, ident: 'VIN', dues: [D('rego', 'Rego', { every_months: 12 }), D('service', 'Bearings & brakes', { every_months: 12 })] },
  beacon: { label: 'EPIRB / PLB', icon: '🛟', meter: null, ident: 'Beacon ID (HEX) / serial', dues: [D('battery', 'Battery expiry', { ask: 'expires', from: 'due' }), D('registration', 'AMSA registration', { every_months: 24 })] },
  other: { label: 'Other', icon: '📦', meter: null, ident: 'Serial number', dues: [] },
};
export const DUE_KINDS = { rego: 'Rego', insurance: 'Insurance', service: 'Service', battery: 'Battery', registration: 'Registration', tyres: 'Tyres', safety: 'Safety gear', other: 'Other' };
export const LOG_KINDS = { service: 'Service', battery: 'Battery', repair: 'Repair', tyres: 'Tyres', parts: 'Parts', rego: 'Rego paid', insurance: 'Insurance paid', registration: 'Registration', reading: 'Hours / km reading', note: 'Note', other: 'Other' };
export const STATES = ['WA', 'ACT', 'NSW', 'VIC', 'QLD', 'SA', 'TAS', 'NT'];

const gq = {
  assets: db.prepare('SELECT * FROM garage_assets ORDER BY archived, name COLLATE NOCASE'),
  asset: db.prepare('SELECT * FROM garage_assets WHERE id = ?'),
  addAsset: db.prepare(`INSERT INTO garage_assets (owner, kind, name, make, model, year, colour, rego, rego_state, ident, engine_no, belongs_to, entity, kept_at,
    meter, meter_value, meter_date, tracker_id, notes, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`),
  delAsset: db.prepare('DELETE FROM garage_assets WHERE id = ?'),
  dues: db.prepare('SELECT * FROM garage_dues WHERE asset_id = ? ORDER BY id'),
  allDues: db.prepare('SELECT * FROM garage_dues'),
  due: db.prepare('SELECT * FROM garage_dues WHERE id = ?'),
  addDue: db.prepare(`INSERT INTO garage_dues (asset_id, kind, label, due_date, due_meter, every_months, every_meter, provider, ref, phone, cost, notes, last_date, last_meter, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`),
  delDue: db.prepare('DELETE FROM garage_dues WHERE id = ?'),
  delDues: db.prepare('DELETE FROM garage_dues WHERE asset_id = ?'),
  logs: db.prepare('SELECT * FROM garage_logs WHERE asset_id = ? ORDER BY date DESC, id DESC'),
  log: db.prepare('SELECT * FROM garage_logs WHERE id = ?'),
  addLog: db.prepare(`INSERT INTO garage_logs (asset_id, date, kind, title, meter, cost, done_by, notes, due_id, added_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`),
  delLog: db.prepare('DELETE FROM garage_logs WHERE id = ?'),
  delLogs: db.prepare('DELETE FROM garage_logs WHERE asset_id = ?'),
  logTotals: db.prepare('SELECT asset_id, count(*) AS n, sum(CASE WHEN date >= ? THEN cost END) AS spent FROM garage_logs GROUP BY asset_id'),
  lastReading: db.prepare('SELECT date, meter FROM garage_logs WHERE asset_id = ? AND meter IS NOT NULL ORDER BY date DESC, id DESC LIMIT 1'),
  files: db.prepare('SELECT * FROM garage_files WHERE asset_id = ? ORDER BY id DESC'),
  file: db.prepare('SELECT * FROM garage_files WHERE id = ?'),
  addFile: db.prepare('INSERT INTO garage_files (asset_id, log_id, name, mime, size, stored, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'),
  delFile: db.prepare('DELETE FROM garage_files WHERE id = ?'),
  unlinkLogFiles: db.prepare('UPDATE garage_files SET log_id = NULL WHERE log_id = ?'),
  setPhoto: db.prepare('UPDATE garage_assets SET photo_id = ?, updated_at = ? WHERE id = ?'),
  setMeter: db.prepare('UPDATE garage_assets SET meter_value = ?, meter_date = ?, updated_at = ? WHERE id = ?'),
  alertSent: db.prepare('SELECT 1 FROM garage_alerts WHERE due_id = ? AND stage = ? AND ref = ?'),
  addAlert: db.prepare('INSERT OR IGNORE INTO garage_alerts (due_id, stage, ref, at) VALUES (?, ?, ?, ?)'),
  delAlerts: db.prepare('DELETE FROM garage_alerts WHERE due_id = ?'),
};

// ---- who can see what ----
export const mainUser = () => (config.dashUser || 'admin').toLowerCase();
export const loginNames = () => [...new Set([mainUser(), ...Object.keys(config.users)])];
export const isAdmin = user => user === mainUser() || settings.getUser(user, 'garageAdmin') === true;
export const canSee = (user, a) => !!a && (a.owner === user || isAdmin(user));
export function setAdmin(by, user, on) {
  if (by !== mainUser()) throw new Error(`Only the main login (${mainUser()}) can choose admins.`);
  if (!loginNames().includes(user)) throw new Error('No such login');
  if (user === mainUser()) throw new Error('The main login is always an admin.');
  settings.setUser(user, { garageAdmin: !!on });
}
export const admins = () => loginNames().map(u => ({ user: u, admin: isAdmin(u), main: u === mainUser() }));

class NotFound extends Error { constructor() { super('Not found'); this.status = 404; } }
/** The asset, if this person may see it (404 otherwise, so nobody learns what others have). */
export function assetFor(user, id) {
  const a = gq.asset.get(Number(id));
  if (!canSee(user, a)) throw new NotFound();
  return a;
}
const dueFor = (user, id) => { const d = gq.due.get(Number(id)); if (!d) throw new NotFound(); assetFor(user, d.asset_id); return d; };
const logFor = (user, id) => { const l = gq.log.get(Number(id)); if (!l) throw new NotFound(); return { log: l, asset: assetFor(user, l.asset_id) }; };
export const fileFor = (user, id) => { const f = gq.file.get(Number(id)); if (!f) throw new NotFound(); assetFor(user, f.asset_id); return f; };

// ---- dates (date-only strings, YYYY-MM-DD, in the person's own time zone) ----
const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const tzOf = user => settings.getUser(user, 'digestTz') || config.digestTz || 'Australia/Perth';
export const todayIn = (tz, now = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const utc = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
export const daysBetween = (from, to) => Math.round((utc(to) - utc(from)) / 86400000);
export function addMonths(s, n) {
  const y = +s.slice(0, 4), m = +s.slice(5, 7) - 1 + n, d = +s.slice(8, 10);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // 31 Jan + 1 month = 28/29 Feb
  return new Date(Date.UTC(y, m, Math.min(d, last))).toISOString().slice(0, 10);
}

// ---- tidying what comes in from the forms ----
const str = (v, max = 200) => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null; };
const num = v => { if (v === '' || v == null) return null; const n = Number(String(v).replace(/[$,\s]/g, '').replace(/(km|hrs?|hours?|h)$/i, '')); if (!Number.isFinite(n)) throw new Error(`"${v}" should be a number`); return n; };
const date = (v, what = 'Date') => { const s = str(v, 10); if (s == null) return null; if (!ISO.test(s) || Number.isNaN(utc(s))) throw new Error(`${what} should be a date`); return s; };
const int = v => { const n = num(v); return n == null ? null : Math.round(n); };

const ASSET_FIELDS = {
  name: v => str(v, 120), make: v => str(v, 60), model: v => str(v, 80), year: v => { const n = int(v); if (n != null && (n < 1900 || n > 2100)) throw new Error('Year looks wrong'); return n; },
  colour: v => str(v, 40), rego: v => str(v, 20)?.toUpperCase() ?? null, rego_state: v => { const s = str(v, 3)?.toUpperCase() ?? null; return s && STATES.includes(s) ? s : null; },
  ident: v => str(v, 60)?.toUpperCase() ?? null, engine_no: v => str(v, 60)?.toUpperCase() ?? null, belongs_to: v => str(v, 60), entity: v => str(v, 80), kept_at: v => str(v, 120),
  meter: v => (['km', 'hours'].includes(v) ? v : null), tracker_id: v => str(v, 40), notes: v => str(v, 4000), archived: v => (v ? 1 : 0),
};

export function createAsset(user, b = {}) {
  const kind = KINDS[b.kind] ? b.kind : 'other';
  const k = KINDS[kind];
  const name = ASSET_FIELDS.name(b.name);
  if (!name) throw new Error('Give it a name, e.g. "Sea-Doo GTX" or "Shay\'s Corolla".');
  const owner = isAdmin(user) && b.owner && loginNames().includes(String(b.owner).toLowerCase()) ? String(b.owner).toLowerCase() : user;
  const f = {};
  for (const [key, fn] of Object.entries(ASSET_FIELDS)) f[key] = fn(b[key]);
  const meter = 'meter' in b ? f.meter : k.meter;
  const meterValue = num(b.meter_value);
  const now = Date.now(), today = todayIn(tzOf(user), now);
  db.exec('BEGIN');
  try {
    const { id } = gq.addAsset.get(owner, kind, name, f.make, f.model, f.year, f.colour, f.rego, f.rego_state, f.ident, f.engine_no, f.belongs_to, f.entity, f.kept_at,
      meter, meterValue, meterValue != null ? today : null, f.tracker_id, f.notes, user, now, now);
    // The usual things to track for this kind, with any dates given on the add form
    const given = b.dues || {};
    if (b.presets !== false) for (const p of k.dues) {
      const g = date(given[p.kind], p.label);
      const last = p.ask === 'last' ? g : null;
      const due = p.ask === 'expires' ? g : last && p.every_months ? addMonths(last, p.every_months) : null;
      gq.addDue.get(id, p.kind, p.label, due, null, p.every_months ?? null, meter ? p.every_meter ?? null : null, null, null, null, null, null, last, null, now, now);
    }
    db.exec('COMMIT');
    return id;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function updateAsset(user, id, patch = {}) {
  const a = assetFor(user, id);
  const sets = [], vals = [];
  for (const [key, fn] of Object.entries(ASSET_FIELDS)) if (key in patch) {
    const v = fn(patch[key]);
    if (key === 'name' && !v) throw new Error('It needs a name');
    sets.push(`${key} = ?`); vals.push(v);
  }
  if ('kind' in patch && KINDS[patch.kind]) { sets.push('kind = ?'); vals.push(patch.kind); }
  if ('owner' in patch && isAdmin(user)) {
    const o = String(patch.owner || '').toLowerCase();
    if (!loginNames().includes(o)) throw new Error('No such login');
    sets.push('owner = ?'); vals.push(o);
  }
  if ('meter_value' in patch) { // typed in by hand: counts as today's reading
    const v = num(patch.meter_value);
    sets.push('meter_value = ?', 'meter_date = ?'); vals.push(v, v == null ? null : todayIn(tzOf(user)));
  }
  if (!sets.length) return;
  sets.push('updated_at = ?'); vals.push(Date.now());
  db.prepare(`UPDATE garage_assets SET ${sets.join(', ')} WHERE id = ?`).run(...vals, a.id);
}

export function deleteAsset(user, id) {
  const a = assetFor(user, id);
  for (const f of gq.files.all(a.id)) removeStored(f);
  for (const d of gq.dues.all(a.id)) gq.delAlerts.run(d.id);
  db.prepare('DELETE FROM garage_files WHERE asset_id = ?').run(a.id);
  gq.delLogs.run(a.id); gq.delDues.run(a.id); gq.delAsset.run(a.id);
}

// ---- things that come due ----
const DUE_FIELDS = {
  label: v => str(v, 60), due_date: v => date(v, 'Due date'), due_meter: num, every_months: v => { const n = int(v); if (n != null && (n < 1 || n > 240)) throw new Error('Repeat every 1-240 months'); return n; },
  every_meter: v => { const n = num(v); if (n != null && n <= 0) throw new Error('Repeat every should be more than 0'); return n; },
  provider: v => str(v, 80), ref: v => str(v, 60), phone: v => str(v, 30), cost: num, notes: v => str(v, 1000),
};
export function addDue(user, assetId, b = {}) {
  const a = assetFor(user, assetId);
  const kind = DUE_KINDS[b.kind] ? b.kind : 'other';
  const f = {};
  for (const [key, fn] of Object.entries(DUE_FIELDS)) f[key] = fn(b[key]);
  const now = Date.now();
  return gq.addDue.get(a.id, kind, f.label || DUE_KINDS[kind], f.due_date, f.due_meter, f.every_months, f.every_meter, f.provider, f.ref, f.phone, f.cost, f.notes, null, null, now, now).id;
}
export function updateDue(user, id, patch = {}) {
  const d = dueFor(user, id);
  const sets = [], vals = [];
  for (const [key, fn] of Object.entries(DUE_FIELDS)) if (key in patch) { sets.push(`${key} = ?`); vals.push(fn(patch[key])); }
  if ('kind' in patch && DUE_KINDS[patch.kind]) { sets.push('kind = ?'); vals.push(patch.kind); }
  if (!sets.length) return;
  sets.push('updated_at = ?'); vals.push(Date.now());
  db.prepare(`UPDATE garage_dues SET ${sets.join(', ')} WHERE id = ?`).run(...vals, d.id);
}
export function deleteDue(user, id) { const d = dueFor(user, id); gq.delAlerts.run(d.id); gq.delDue.run(d.id); }

/** When it's next due after being done on `on` (at `meter`). Renewals run on from the old expiry. */
export function nextAfter(d, on, meter) {
  const fromDue = ['rego', 'insurance', 'registration'].includes(d.kind);
  const base = fromDue && d.due_date ? d.due_date : on;
  return {
    due_date: d.every_months ? addMonths(base, d.every_months) : null,
    due_meter: d.every_meter && meter != null ? meter + d.every_meter : null,
  };
}

/** How it stands today: overdue | soon | ok | unset, with days and hours/km to go. */
export function dueState(d, a, today) {
  const days = d.due_date ? daysBetween(today, d.due_date) : null;
  const left = d.due_meter != null && a.meter_value != null ? Math.round((d.due_meter - a.meter_value) * 10) / 10 : null;
  if (days == null && d.due_meter == null) return { state: 'unset', days, left };
  const near = d.every_meter ? d.every_meter * 0.1 : a.meter === 'hours' ? 10 : 1000;
  const state = (days != null && days < 0) || (left != null && left <= 0) ? 'overdue'
    : (days != null && days <= 30) || (left != null && left <= near) ? 'soon' : 'ok';
  return { state, days, left };
}
const RANK = { overdue: 0, soon: 1, ok: 2, unset: 3 };
const urgency = d => [RANK[d.state], d.days ?? (d.left != null ? d.left : 99999)];
const byUrgency = (x, y) => { const [a1, a2] = urgency(x), [b1, b2] = urgency(y); return a1 - b1 || a2 - b2; };

// ---- history ----
const LOG_DUE = { service: 'service', battery: 'battery', rego: 'rego', insurance: 'insurance', registration: 'registration', tyres: 'tyres' };
/**
 * Log something done (a service, a new battery, rego paid, an hours reading...). If it's the thing a due item
 * tracks (chosen, or the only one of that kind), that item rolls on to its next date / hours.
 */
export function addLog(user, assetId, b = {}) {
  const a = assetFor(user, assetId);
  const kind = LOG_KINDS[b.kind] ? b.kind : 'other';
  const on = date(b.date) || todayIn(tzOf(user));
  const meter = num(b.meter);
  if (meter != null && meter < 0) throw new Error('Hours / km can\'t be negative');
  const cost = num(b.cost);
  let due = null;
  if (b.due_id === 'none' || b.due_id === 0) due = null;
  else if (b.due_id) { due = gq.due.get(Number(b.due_id)); if (!due || due.asset_id !== a.id) throw new Error('That due item is not on this one'); }
  else if (LOG_DUE[kind]) { const same = gq.dues.all(a.id).filter(d => d.kind === LOG_DUE[kind]); if (same.length === 1) due = same[0]; }
  const title = str(b.title, 160) || (due ? due.label : LOG_KINDS[kind]);
  const now = Date.now();
  db.exec('BEGIN');
  try {
    const { id } = gq.addLog.get(a.id, on, kind, title, meter, cost, str(b.done_by, 80), str(b.notes, 4000), due?.id ?? null, user, now);
    if (meter != null && (!a.meter_date || on >= a.meter_date)) gq.setMeter.run(meter, on, now, a.id);
    let next = null;
    if (due) {
      next = nextAfter(due, on, meter);
      if (b.next_date !== undefined && b.next_date !== '') next.due_date = date(b.next_date, 'Next due');
      if (b.next_meter !== undefined && b.next_meter !== '') next.due_meter = num(b.next_meter);
      // Done: the old due date / hours are spent. With no repeat and no new date given (a beacon battery
      // with no new expiry typed in), it shows as "not set" until one is.
      db.prepare(`UPDATE garage_dues SET last_date = ?, last_meter = ?, due_date = ?, due_meter = ?, cost = COALESCE(?, cost), updated_at = ? WHERE id = ?`)
        .run(on, meter, next.due_date, next.due_meter, ['rego', 'insurance', 'registration'].includes(due.kind) ? cost : null, now, due.id);
    }
    db.exec('COMMIT');
    return { id, dueId: due?.id ?? null, next };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function deleteLog(user, id) {
  const { log, asset } = logFor(user, id);
  gq.unlinkLogFiles.run(log.id);
  gq.delLog.run(log.id);
  // the reading may have come from this entry: take the latest one left
  if (log.meter != null && asset.meter_date === log.date && asset.meter_value === log.meter) {
    const r = gq.lastReading.get(asset.id);
    gq.setMeter.run(r?.meter ?? null, r?.date ?? null, Date.now(), asset.id);
  }
}

// ---- photos and documents (kept on the server, only ever sent to people who can see the item) ----
export const FILE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heic', 'application/pdf': 'pdf' };
export const MAX_FILE = 15 * 1048576;
function sniff(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(buf.subarray(8, 12).toString('latin1'))) return 'image/heic';
  return null;
}
export function addFile(user, assetId, buf, { name, logId } = {}) {
  const a = assetFor(user, assetId);
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('No file came through');
  if (buf.length > MAX_FILE) throw new Error('That file is over 15 MB');
  const mime = sniff(buf);
  if (!mime) throw new Error('Photos (JPG, PNG, HEIC) and PDFs only');
  let log = null;
  if (logId) { log = gq.log.get(Number(logId)); if (!log || log.asset_id !== a.id) throw new Error('That history entry is not on this one'); }
  fs.mkdirSync(FILE_DIR, { recursive: true });
  const stored = `${crypto.randomBytes(16).toString('hex')}.${FILE_TYPES[mime]}`;
  fs.writeFileSync(path.join(FILE_DIR, stored), buf, { mode: 0o600 });
  const clean = (str(name, 120) || `file.${FILE_TYPES[mime]}`).replace(/[^\w .()-]+/g, '_');
  const { id } = gq.addFile.get(a.id, log?.id ?? null, clean, mime, buf.length, stored, user, Date.now());
  if (!a.photo_id && mime.startsWith('image/') && mime !== 'image/heic') gq.setPhoto.run(id, Date.now(), a.id);
  return id;
}
export const filePath = f => path.join(FILE_DIR, path.basename(f.stored));
function removeStored(f) { try { fs.rmSync(filePath(f)); } catch { /* already gone */ } }
export function deleteFile(user, id) {
  const f = fileFor(user, id);
  removeStored(f);
  gq.delFile.run(f.id);
  const a = gq.asset.get(f.asset_id);
  if (a?.photo_id === f.id) {
    const next = gq.files.all(a.id).find(x => x.mime.startsWith('image/') && x.mime !== 'image/heic');
    gq.setPhoto.run(next?.id ?? null, Date.now(), a.id);
  }
}
export function setCover(user, assetId, fileId) {
  const a = assetFor(user, assetId);
  const f = gq.file.get(Number(fileId));
  if (!f || f.asset_id !== a.id || !f.mime.startsWith('image/')) throw new Error('Pick a photo of this one');
  gq.setPhoto.run(f.id, Date.now(), a.id);
}

// ---- what the page gets ----
const shapeDue = (d, a, today) => ({
  id: d.id, kind: d.kind, label: d.label, dueDate: d.due_date, dueMeter: d.due_meter, everyMonths: d.every_months, everyMeter: d.every_meter,
  provider: d.provider, ref: d.ref, phone: d.phone, cost: d.cost, notes: d.notes, lastDate: d.last_date, lastMeter: d.last_meter,
  ...dueState(d, a, today),
});
const shapeAsset = (a, dues, totals, today) => {
  const k = KINDS[a.kind] || KINDS.other;
  const ds = dues.map(d => shapeDue(d, a, today)).sort(byUrgency);
  return {
    id: a.id, owner: a.owner, kind: a.kind, kindLabel: k.label, icon: k.icon, identLabel: k.ident, name: a.name, make: a.make, model: a.model, year: a.year, colour: a.colour,
    rego: a.rego, regoState: a.rego_state, ident: a.ident, engineNo: a.engine_no, belongsTo: a.belongs_to, entity: a.entity, keptAt: a.kept_at,
    meter: a.meter, meterValue: a.meter_value, meterDate: a.meter_date, trackerId: a.tracker_id, notes: a.notes,
    photo: a.photo_id ? `/api/garage/files/${a.photo_id}` : null, archived: !!a.archived,
    dues: ds, next: ds.find(d => d.state !== 'unset') || null, logCount: totals?.n || 0, spent12: totals?.spent || 0,
    createdAt: a.created_at, updatedAt: a.updated_at,
  };
};

export function listFor(user, now = Date.now()) {
  const today = todayIn(tzOf(user), now);
  const totals = new Map(gq.logTotals.all(addMonths(today, -12)).map(t => [t.asset_id, t]));
  const dues = new Map();
  for (const d of gq.allDues.all()) dues.set(d.asset_id, [...(dues.get(d.asset_id) || []), d]);
  const assets = gq.assets.all().filter(a => canSee(user, a)).map(a => shapeAsset(a, dues.get(a.id) || [], totals.get(a.id), today));
  const live = assets.filter(a => !a.archived);
  const coming = live.flatMap(a => a.dues.filter(d => d.state === 'overdue' || d.state === 'soon').map(d => ({ ...d, assetId: a.id, assetName: a.name, icon: a.icon, owner: a.owner, meter: a.meter })))
    .sort(byUrgency);
  return {
    today, assets, coming,
    summary: { items: live.length, overdue: coming.filter(d => d.state === 'overdue').length, soon: coming.filter(d => d.state === 'soon').length,
      spent12: live.reduce((s, a) => s + a.spent12, 0) },
  };
}

export function assetView(user, id, now = Date.now()) {
  const a = assetFor(user, id);
  const today = todayIn(tzOf(user), now);
  const totals = gq.logTotals.all(addMonths(today, -12)).find(t => t.asset_id === a.id);
  const files = gq.files.all(a.id).map(f => ({ id: f.id, logId: f.log_id, name: f.name, mime: f.mime, size: f.size, url: `/api/garage/files/${f.id}`, by: f.added_by, at: f.created_at }));
  return {
    today, ...shapeAsset(a, gq.dues.all(a.id), totals, today),
    logs: gq.logs.all(a.id).map(l => ({ id: l.id, date: l.date, kind: l.kind, kindLabel: LOG_KINDS[l.kind] || l.kind, title: l.title, meter: l.meter, cost: l.cost,
      doneBy: l.done_by, notes: l.notes, dueId: l.due_id, by: l.added_by, files: files.filter(f => f.logId === l.id) })),
    files,
  };
}

export const meta = user => ({
  me: user, admin: isAdmin(user), main: user === mainUser(), users: isAdmin(user) ? loginNames() : [user],
  kinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, { label: v.label, icon: v.icon, meter: v.meter, ident: v.ident, dues: v.dues.map(d => ({ kind: d.kind, label: d.label, ask: d.ask, everyMonths: d.every_months ?? null, everyMeter: d.every_meter ?? null })) }])),
  dueKinds: DUE_KINDS, logKinds: LOG_KINDS, states: STATES, today: todayIn(tzOf(user)),
});

// ---- phone reminders: 30 days, 7 days and on the day (or as the hours / km get close), then weekly while overdue ----
const fmtDay = s => new Date(utc(s)).toLocaleDateString('en-AU', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const unit = (a, n) => `${Math.round(n).toLocaleString('en-AU')} ${a.meter === 'hours' ? 'hrs' : 'km'}`;
/** Everything that should go out now (and marks it sent). Pass quiet=false to skip the 8am-8pm window (tests). */
export function remindersDue(now = Date.now(), { quiet = true } = {}) {
  const out = [];
  const dues = new Map();
  for (const d of gq.allDues.all()) dues.set(d.asset_id, [...(dues.get(d.asset_id) || []), d]);
  for (const a of gq.assets.all()) {
    if (a.archived) continue;
    const tz = tzOf(a.owner);
    if (quiet) {
      const hour = Number(new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now));
      if (hour < 8 || hour >= 20) continue; // nobody wants a rego reminder at 3am
    }
    const today = todayIn(tz, now);
    for (const d of dues.get(a.id) || []) {
      const st = dueState(d, a, today);
      if (st.state !== 'overdue' && st.state !== 'soon') continue;
      // date stages, most advanced first; sending one marks the earlier ones sent too
      if (st.days != null && st.days <= 30) {
        const weeks = st.days < 0 ? Math.min(8, Math.floor(-st.days / 7)) : 0;
        const stages = ['d30', 'd7', 'd0', ...Array.from({ length: weeks }, (_, i) => `o${i + 1}`)];
        const reached = stages.filter(s => s === 'd30' || (s === 'd7' && st.days <= 7) || (s === 'd0' && st.days <= 0) || s.startsWith('o'));
        const top = reached[reached.length - 1];
        if (!gq.alertSent.get(d.id, top, d.due_date)) {
          for (const s of reached) gq.addAlert.run(d.id, s, d.due_date, now);
          const when = st.days < 0 ? `OVERDUE by ${-st.days} day${st.days === -1 ? '' : 's'}` : st.days === 0 ? 'due TODAY' : `due in ${st.days} day${st.days === 1 ? '' : 's'}`;
          out.push({ to: a.owner, assetId: a.id, dueId: d.id, stage: top, priority: st.days <= 0 ? 'high' : st.days <= 7 ? 'default' : 'low',
            title: `${a.name}: ${d.label} ${when}`,
            message: [`${d.label} ${st.days < 0 ? 'was' : 'is'} due ${fmtDay(d.due_date)}`, a.rego ? `Rego ${a.rego}${a.rego_state ? ' ' + a.rego_state : ''}` : null,
              d.provider ? `${d.provider}${d.ref ? ' · ' + d.ref : ''}${d.phone ? ' · ' + d.phone : ''}` : null].filter(Boolean).join('\n') });
        }
      }
      // hours / km stages
      if (st.left != null) {
        const near = d.every_meter ? d.every_meter * 0.1 : a.meter === 'hours' ? 10 : 1000;
        const stage = st.left <= 0 ? 'mdue' : st.left <= near ? 'msoon' : null;
        const ref = String(d.due_meter);
        if (stage && !gq.alertSent.get(d.id, stage, ref)) {
          gq.addAlert.run(d.id, 'msoon', ref, now);
          if (stage === 'mdue') gq.addAlert.run(d.id, 'mdue', ref, now);
          out.push({ to: a.owner, assetId: a.id, dueId: d.id, stage, priority: stage === 'mdue' ? 'high' : 'default',
            title: `${a.name}: ${d.label} ${stage === 'mdue' ? `OVERDUE by ${unit(a, -st.left)}` : `due in ${unit(a, st.left)}`}`,
            message: `${d.label} due at ${unit(a, d.due_meter)}. Last reading ${unit(a, a.meter_value)}${a.meter_date ? ` on ${fmtDay(a.meter_date)}` : ''}.` });
        }
      }
    }
  }
  return out;
}
