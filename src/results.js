// Live-lane results from Pickles' Velocicast screen (pickles-au.velocicast.io), saved or copied by hand.
// Live sales have no online close we can watch, so their hammer prices only come this way: each "SOLD $33,750"
// becomes a sold result (it sharpens the values), each "PASSED IN" closes the lot as not sold.
// We never log in to Velocicast ourselves: the person saves the page from their own session.
import { db, upsertLot } from './db.js';
import { tidyTitle, identify } from './vehicle.js';
import { rebuild } from './history.js';
import { log } from './log.js';

const OFFSET = { AEDT: 11, AEST: 10, ACDT: 10.5, ACST: 9.5, AWST: 8, AWDT: 9 };
const ST = /\b(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b/;

/** A saved Velocicast page (HTML) or its copied text -> visible lines. */
function linesOf(input) {
  let s = String(input || '');
  if (/<\/?[a-z][\s\S]*>/i.test(s)) {
    s = s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>|<!--[\s\S]*?-->/gi, '')
      .replace(/<[^>]+>/g, '\n')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  return s.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** "National Corporate ... Auction at 23/10/2026 10:00 AM AEDT" -> { name, at } */
function saleOf(lines) {
  for (const l of lines) {
    const m = /^(.*?\bat)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s*(A[CEW][SD]T)\b/i.exec(l);
    if (!m) continue;
    let h = +m[5] % 12; if (/pm/i.test(m[7])) h += 12;
    const at = Date.UTC(+m[4], +m[3] - 1, +m[2], h, +m[6]) - (OFFSET[m[8].toUpperCase()] ?? 10) * 36e5;
    return { name: m[1].replace(/\s+at$/i, '').trim(), at, date: `${m[4]}-${m[3].padStart(2, '0')}-${m[2].padStart(2, '0')}` };
  }
  return null;
}

/**
 * Parse the run list: "#12", "- CP: 10/2021,Toyota,Hilux,GUN126R SR,...", "Location:", "Gateshead, NSW", colour,
 * "278,640", "Kms. Showing on Odometer", "SOLD", "$21,750"  (or "PASSED IN" / "--", or "Max Bid" for one still to run).
 */
export function parseVelocicast(input) {
  const lines = linesOf(input);
  const sale = saleOf(lines);
  const lots = new Map();
  for (let i = 0; i < lines.length; i++) {
    const run = /^#(\d{1,4})(?:\s*-\s*(.*))?$/.exec(lines[i]);
    if (!run) continue;
    // the description can share the line or follow it ("#59", "-", "CP: 08/2018,Ford,...")
    let j = i + 1, desc = run[2] || '';
    while (!/CP\s*:/i.test(desc) && j < lines.length && j < i + 3 && !/^#\d/.test(lines[j])) desc = lines[j++].replace(/^-\s*/, '') || desc;
    desc = desc.replace(/^-\s*/, '');
    if (!/CP\s*:/i.test(desc)) continue;
    const block = [];
    for (; j < lines.length && block.length < 14 && !/^#\d/.test(lines[j]); j++) block.push(lines[j]);
    const li = block.indexOf('Location:');
    const location = li >= 0 ? block[li + 1] || null : null;
    const odoAt = block.findIndex(l => /^Kms\.? Showing on Odometer/i.test(l));
    const odometer = odoAt > 0 && /^[\d,]+$/.test(block[odoAt - 1]) ? Number(block[odoAt - 1].replace(/,/g, '')) : null;
    const colour = li >= 0 && block[li + 2] && !/^[\d,]+$/.test(block[li + 2]) ? block[li + 2] : null;
    const sIdx = block.findIndex(l => /^(SOLD|PASSED IN|Max Bid|WITHDRAWN|NO SALE|REFERRED|SUBJECT TO CONFIRMATION)$/i.test(l));
    const word = sIdx >= 0 ? block[sIdx].toUpperCase() : null;
    const price = sIdx >= 0 && /^\$[\d,]+$/.test(block[sIdx + 1] || '') ? Number(block[sIdx + 1].replace(/[$,]/g, '')) : null;
    const result = word === 'SOLD' && price ? 'sold' : word === 'PASSED IN' || word === 'NO SALE' ? 'passed' : word === 'WITHDRAWN' ? 'withdrawn'
      : word === 'REFERRED' || word === 'SUBJECT TO CONFIRMATION' ? 'referred' : 'upcoming';
    const title = tidyTitle('CP: ' + desc.replace(/^CP\s*:\s*/i, ''));
    const n = Number(run[1]);
    // the run list comes first; the "current lot" panel repeats one without its result: keep the first
    if (!lots.has(n)) lots.set(n, { run: n, title, location, state: (ST.exec(location || '') || [])[1] || null, colour, odometer, result, price });
  }
  return { sale, lots: [...lots.values()] };
}

const findLot = db.prepare(`SELECT key, title, year, status, end_at, url FROM lots WHERE site = 'pickles' AND odometer = ?
  AND (end_at IS NULL OR end_at BETWEEN ? AND ?) ORDER BY status = 'open' DESC, last_seen DESC`);
const closeSold = db.prepare(`UPDATE lots SET status = 'closed', final_bid = ?, bid = ?, reserve = NULL, end_at = ?, final_seen_at = ?, closed_at = ?,
  last_checked = MAX(COALESCE(last_checked, 0), ?), result_src = 'velocicast', buy_method = COALESCE(buy_method, 'Live'), sale_name = COALESCE(sale_name, ?), lot_no = COALESCE(lot_no, ?) WHERE key = ?`);
const closeUnsold = db.prepare(`UPDATE lots SET status = 'closed', final_bid = NULL, reserve = ?, end_at = ?, final_seen_at = ?, closed_at = ?,
  last_checked = MAX(COALESCE(last_checked, 0), ?), result_src = 'velocicast', buy_method = COALESCE(buy_method, 'Live'), sale_name = COALESCE(sale_name, ?), lot_no = COALESCE(lot_no, ?) WHERE key = ?`);

/** Same vehicle: same odometer reading (from the query), and the same make and year when both are known. */
function sameVehicle(row, lot) {
  const a = identify({ title: row.title, year: row.year }), b = identify({ title: lot.title });
  if (a && b && a.make !== b.make) return false;
  if (a?.year && b?.year && Math.abs(a.year - b.year) > 1) return false;
  return true;
}

/**
 * Record a parsed Velocicast page. Results for lots we know update those lots; sold ones we never saw are added
 * (as Pickles results, so they count in the values). Re-importing the same page changes nothing.
 */
export function importVelocicast(parsed, now = Date.now()) {
  const { sale, lots } = parsed;
  if (!sale) throw new Error("That doesn't look like a Velocicast sale page (no sale name and time found). Save the page while the sale is open, or copy all of its text.");
  if (!lots.length) throw new Error('No lots found on that page.');
  const out = { sale: sale.name, at: sale.at, sold: 0, passed: 0, upcoming: 0, matched: 0, added: 0, items: [] };
  db.exec('BEGIN');
  try {
    for (const l of lots) {
      if (l.result === 'upcoming' || l.result === 'referred') { out.upcoming++; continue; }
      if (l.result === 'withdrawn') continue;
      const when = sale.at + (l.run - 1) * 60000;   // roughly a minute a lot
      let row = l.odometer ? findLot.all(l.odometer, sale.at - 4 * 864e5, sale.at + 4 * 864e5).find(r => sameVehicle(r, l)) : null;
      if (!row && l.result === 'sold') {
        const key = upsertLot({ site: 'pickles', ext_id: `vc-${sale.date}-${l.run}`, title: l.title, odometer: l.odometer, location: l.location, state: l.state,
          category: 'cars', buy_method: 'Live', sale_name: sale.name, lot_no: String(l.run), end_at: when, url: 'https://www.pickles.com.au/cars', market: 'retail' });
        row = { key, added: true };
      }
      if (!row) { out.passed++; continue; }
      if (l.result === 'sold') { closeSold.run(l.price, l.price, when, when, when, when, sale.name, String(l.run), row.key); out.sold++; }
      else { closeUnsold.run('not met', when, when, when, when, sale.name, String(l.run), row.key); out.passed++; }
      if (row.added) out.added++; else out.matched++;
      out.items.push({ run: l.run, title: l.title, result: l.result, price: l.price, key: row.key, matched: !row.added });
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  rebuild();
  log.info('results', `Velocicast ${sale.name}: ${out.sold} sold, ${out.passed} passed in (${out.matched} matched our lots, ${out.added} added), ${out.upcoming} still to run`);
  return out;
}
