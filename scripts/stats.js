// Health report: npm run stats   (inside the container: docker compose exec kamrads npm run stats)
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../src/config.js';

const db = new DatabaseSync(path.join(config.dataDir, 'auctions.db'), { readOnly: true });
const awst = ms => (ms ? new Date(ms).toLocaleString('en-AU', { timeZone: 'Australia/Perth', hour12: false }) : '-');
const now = Date.now(), day = now - 86400000;

console.log(`\nKAMRADS health report — ${awst(now)} AWST\n`);
console.log('Lots by site');
console.table(db.prepare(`SELECT site,
  sum(status='open') AS open, sum(status='open' AND bid IS NOT NULL) AS open_with_bid,
  coalesce(sum(status='open' AND end_at BETWEEN ? AND ?),0) AS closing_next_hour,
  sum(status='closed' AND closed_at > ?) AS closed_24h, sum(status='closed' AND closed_at > ? AND final_bid IS NOT NULL) AS priced_24h,
  coalesce(sum(last_checked > ?),0) AS rechecked_10min
  FROM lots GROUP BY site`).all(now, now + 3600000, day, day, now - 600000));

console.log('Scan status');
console.table(db.prepare('SELECT site, last_count, last_ok, last_error, last_error_at FROM site_status').all()
  .map(r => ({ site: r.site, lots: r.last_count, last_ok: awst(r.last_ok), last_error: r.last_error ? `${awst(r.last_error_at)} ${r.last_error.slice(0, 70)}` : '' })));

let feeds = {};
try { feeds = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'fast-feeds.json'), 'utf8')); } catch { /* none */ }
console.log('Fast price feeds:', Object.keys(feeds).length ? '' : 'none learned yet');
for (const [s, f] of Object.entries(feeds)) console.log(`  ${s}: ${f.kind} ${f.template}`);

console.log('\nNext 8 closing (open lots)');
console.table(db.prepare(`SELECT site, substr(title,1,40) AS title, bid, last_checked, end_at FROM lots WHERE status='open' AND end_at > ? ORDER BY end_at LIMIT 8`).all(now)
  .map(r => ({ site: r.site, title: r.title, bid: r.bid, closes: awst(r.end_at), checked: awst(r.last_checked) })));

console.log('Last 10 closed');
console.table(db.prepare(`SELECT site, substr(title,1,40) AS title, final_bid, end_at, final_seen_at FROM lots WHERE status='closed' ORDER BY end_at DESC LIMIT 10`).all()
  .map(r => ({ site: r.site, title: r.title, final: r.final_bid, closed: awst(r.end_at), last_read: awst(r.final_seen_at) })));
