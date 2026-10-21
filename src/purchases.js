// What we've bought: every cost logged against the item (hammer price, fees, transport, parts,
// repairs, rego...), so we always know what it owes us - and what we made when it sells.
// Shared between logins (company records); each entry notes who added it.
import { db, q } from './db.js';
import { allIn } from './costs.js';
import { estimateOf } from './alerts.js';
import { soldLike } from './history.js';

db.exec(`
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, lot_key TEXT, title TEXT NOT NULL, site TEXT, url TEXT, lot_no TEXT,
  entity TEXT, bought_by TEXT, bought_at INTEGER, status TEXT NOT NULL DEFAULT 'bought',
  location TEXT, odometer INTEGER, wovr TEXT, notes TEXT,
  asking_price REAL, sold_price REAL, sold_at INTEGER, sold_to TEXT,
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS purchase_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_id INTEGER NOT NULL, at INTEGER, category TEXT NOT NULL,
  description TEXT, amount REAL NOT NULL, added_by TEXT, created_at INTEGER
);
CREATE INDEX IF NOT EXISTS purchase_costs_p ON purchase_costs(purchase_id);
`);

export const COST_CATEGORIES = ['Purchase price', "Buyer's fees", 'GST', 'Transport', 'Repairs & parts', 'Rego & inspection',
  'Fuel & tolls', 'Storage', 'Cleaning & detailing', 'Selling costs', 'Other'];
export const STATUSES = ['bought', 'in transit', 'repairing', 'for sale', 'sold', 'keeping'];

const pq = {
  all: db.prepare('SELECT * FROM purchases ORDER BY status = \'sold\', COALESCE(bought_at, created_at) DESC'),
  one: db.prepare('SELECT * FROM purchases WHERE id = ?'),
  byLot: db.prepare('SELECT * FROM purchases WHERE lot_key = ?'),
  add: db.prepare(`INSERT INTO purchases (lot_key, title, site, url, lot_no, entity, bought_by, bought_at, status, location, odometer, wovr, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`),
  del: db.prepare('DELETE FROM purchases WHERE id = ?'),
  costs: db.prepare('SELECT * FROM purchase_costs WHERE purchase_id = ? ORDER BY COALESCE(at, created_at), id'),
  allCosts: db.prepare('SELECT purchase_id, category, sum(amount) AS total FROM purchase_costs GROUP BY purchase_id, category'),
  addCost: db.prepare('INSERT INTO purchase_costs (purchase_id, at, category, description, amount, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'),
  delCost: db.prepare('DELETE FROM purchase_costs WHERE id = ? AND purchase_id = ?'),
  delCosts: db.prepare('DELETE FROM purchase_costs WHERE purchase_id = ?'),
  entities: db.prepare("SELECT DISTINCT entity FROM purchases WHERE entity IS NOT NULL AND entity != '' ORDER BY entity"),
};

const EDITABLE = ['title', 'entity', 'bought_at', 'status', 'location', 'odometer', 'wovr', 'notes', 'asking_price', 'sold_price', 'sold_at', 'sold_to', 'url'];
const num = v => (v === '' || v == null ? null : Number(String(v).replace(/[$,\s]/g, '')));

/** Turn a won lot into a purchase, with the hammer price and the auction house's fees filled in. */
export function addFromLot(key, user, { price, entity } = {}) {
  const lot = q.lot.get(key);
  if (!lot) throw new Error('Lot not found');
  const existing = pq.byLot.get(key);
  if (existing) return existing.id;
  const hammer = num(price) ?? lot.final_bid ?? lot.bid;
  const now = Date.now();
  const { id } = pq.add.get(key, lot.title || 'Lot', lot.site, lot.url, lot.lot_no, entity || null, user, lot.end_at && lot.end_at < now ? lot.end_at : now,
    'bought', [lot.location, lot.state].filter(Boolean).join(' ') || null, lot.odometer, lot.wovr, null, now, now);
  if (hammer != null) {
    pq.addCost.get(id, now, 'Purchase price', `Hammer price${lot.lot_no ? `, lot ${lot.lot_no}` : ''}`, hammer, user, now);
    const c = allIn(lot, null, hammer);
    if (c?.premium || c?.fee || c?.processing) pq.addCost.get(id, now, "Buyer's fees", "Auction house fees (estimated - replace with the invoice)", (c.premium || 0) + (c.fee || 0) + (c.processing || 0), user, now);
    if (c?.gst) pq.addCost.get(id, now, 'GST', 'GST on hammer (estimated)', c.gst, user, now);
  }
  return id;
}

export function addManual(user, b) {
  const title = String(b.title || '').trim();
  if (!title) throw new Error('Give it a name, e.g. "2016 Toyota HiAce".');
  const now = Date.now();
  const { id } = pq.add.get(null, title.slice(0, 160), b.site || null, b.url || null, null, b.entity || null, user,
    num(b.bought_at) || now, 'bought', b.location || null, num(b.odometer), b.wovr || null, b.notes || null, now, now);
  if (num(b.price) != null) pq.addCost.get(id, now, 'Purchase price', 'Purchase price', num(b.price), user, now);
  return id;
}

export function update(id, patch) {
  const p = pq.one.get(id);
  if (!p) throw new Error('Not found');
  const sets = [], vals = [];
  for (const k of EDITABLE) if (k in patch) {
    let v = patch[k];
    if (['asking_price', 'sold_price', 'odometer', 'bought_at', 'sold_at'].includes(k)) v = num(v);
    if (k === 'status' && !STATUSES.includes(v)) continue;
    sets.push(`${k} = ?`); vals.push(v === '' ? null : v);
  }
  // marking it sold stamps the date if none was given
  if (patch.status === 'sold' && !p.sold_at && !('sold_at' in patch)) { sets.push('sold_at = ?'); vals.push(Date.now()); }
  if (!sets.length) return;
  db.prepare(`UPDATE purchases SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, Date.now(), id);
}

export function addCost(id, user, b) {
  if (!pq.one.get(id)) throw new Error('Not found');
  const amount = num(b.amount);
  if (amount == null || !Number.isFinite(amount)) throw new Error('Enter the amount in dollars.');
  const category = COST_CATEGORIES.includes(b.category) ? b.category : 'Other';
  return pq.addCost.get(id, num(b.at) || Date.now(), category, String(b.description || '').slice(0, 200) || null, amount, user, Date.now()).id;
}
export const delCost = (id, costId) => pq.delCost.run(costId, id);
export function remove(id) { pq.delCosts.run(id); pq.del.run(id); }

/** One purchase with its costs, totals, value guide and result. */
export function detail(p, costs = pq.costs.all(p.id)) {
  const total = costs.reduce((a, c) => a + c.amount, 0);
  const byCat = {};
  for (const c of costs) byCat[c.category] = (byCat[c.category] || 0) + c.amount;
  const lot = p.lot_key ? q.lot.get(p.lot_key) : null;
  const est = lot ? estimateOf(lot) : null;
  const sh = lot ? soldLike(lot) : null;
  const sold = p.status === 'sold' && p.sold_price != null;
  const end = sold ? (p.sold_at || Date.now()) : Date.now();
  return {
    id: p.id, lotKey: p.lot_key, title: p.title, site: p.site, url: p.url, lotNo: p.lot_no, entity: p.entity, boughtBy: p.bought_by,
    boughtAt: p.bought_at, status: p.status, location: p.location, odometer: p.odometer, wovr: p.wovr, notes: p.notes,
    askingPrice: p.asking_price, soldPrice: p.sold_price, soldAt: p.sold_at, soldTo: p.sold_to,
    costs: costs.map(c => ({ id: c.id, at: c.at, category: c.category, description: c.description, amount: c.amount, by: c.added_by })),
    total, byCategory: byCat,
    profit: sold ? p.sold_price - total : null,
    margin: sold && total > 0 ? (p.sold_price - total) / total : null,
    // if it sold at the asking price
    projected: !sold && p.asking_price != null ? p.asking_price - total : null,
    days: p.bought_at ? Math.max(0, Math.round((end - p.bought_at) / 86400000)) : null,
    valueGuide: est ?? sh?.median ?? null, valueSource: est ? 'estimate' : sh ? `sold here (${sh.n})` : null,
  };
}

export function list() {
  const rows = pq.all.all().map(p => detail(p));
  const held = rows.filter(r => r.status !== 'sold');
  const sold = rows.filter(r => r.status === 'sold' && r.soldPrice != null);
  return {
    purchases: rows,
    entities: pq.entities.all().map(r => r.entity),
    categories: COST_CATEGORIES, statuses: STATUSES,
    summary: {
      held: held.length, tiedUp: held.reduce((a, r) => a + r.total, 0),
      sold: sold.length, profit: sold.reduce((a, r) => a + r.profit, 0),
      avgMargin: sold.length ? sold.reduce((a, r) => a + (r.margin || 0), 0) / sold.length : null,
      avgDays: sold.length ? Math.round(sold.reduce((a, r) => a + (r.days || 0), 0) / sold.length) : null,
    },
  };
}

export const purchaseForLot = key => pq.byLot.get(key);

export function exportRows() {
  return pq.all.all().flatMap(p => {
    const d = detail(p);
    return [{ id: d.id, title: d.title, entity: d.entity, status: d.status, bought_at: d.boughtAt, site: d.site, total_cost: d.total,
      asking_price: d.askingPrice, sold_price: d.soldPrice, sold_at: d.soldAt, profit: d.profit, days_held: d.days,
      ...Object.fromEntries(COST_CATEGORIES.map(c => [c.toLowerCase().replace(/[^a-z]+/g, '_'), d.byCategory[c] || 0])) }];
  });
}
