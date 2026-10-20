// Fast price reads.
// A full page load in Chromium takes 5-7 s, which caps us at ~8 lots a minute. After one normal
// read we note which JSON request carried that lot's bid, turn its URL into a template
// (".../product/62430579" -> ".../product/{id}") and from then on fetch only that JSON:
// ~0.3 s, no rendering, so every closing lot can get its final-price read.
// If the price lives in the page's own HTML (Next.js data) we fetch the raw HTML instead.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { browserFetch } from './browser.js';
import { lotsFromJson, jsonBlobsFromHtml } from './extract.js';
import { log } from './log.js';

const file = path.join(config.dataDir, 'fast-feeds.json');
let feeds = {};
try { feeds = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
const fails = {};
const save = () => { try { fs.writeFileSync(file, JSON.stringify(feeds, null, 1)); } catch { /* ignore */ } };

export const hasFeed = site => !!feeds[site];
export const feedOf = site => feeds[site] || null;

const hasLive = l => l && (l.bid != null || l.end_at != null || l.bid_count != null);
const findLot = (lots, id) => lots.find(l => String(l.ext_id) === String(id)) || (lots.length === 1 ? lots[0] : null);

/** After a full page read: remember how this site serves one lot's live price. */
export function learn(site, id, capture) {
  if (!id || feeds[site]) return;
  const sid = String(id);
  for (const { url, body } of capture.json || []) {
    if (!url.includes(sid)) continue;
    const lot = findLot(lotsFromJson(body), sid);
    if (hasLive(lot) && lot.bid != null) {
      feeds[site] = { kind: 'json', template: url.split(sid).join('{id}') };
      save();
      log.info(site, `learned fast price feed: ${feeds[site].template}`);
      return;
    }
  }
  // Price embedded in the page HTML itself (no separate request)?
  const page = capture.finalUrl || '';
  if (page.includes(sid)) {
    const lot = findLot(jsonBlobsFromHtml(capture.html || '').flatMap(b => lotsFromJson(b)), sid);
    if (lot && lot.bid != null) {
      feeds[site] = { kind: 'html', template: page.split(sid).join('{id}') };
      save();
      log.info(site, `learned fast price feed (page data): ${feeds[site].template}`);
    }
  }
}

/** Read one lot's live fields through the learned feed. Returns null if there's no feed or it failed. */
export async function fastRead(site, lot) {
  const f = feeds[site];
  if (!f) return null;
  // HTML feeds use the lot's own URL (it has the slug); JSON feeds use the template.
  const url = f.kind === 'html' ? lot.url : f.template.split('{id}').join(lot.ext_id);
  try {
    const res = await browserFetch(site, url, f.kind === 'json' ? 'application/json, text/plain, */*' : 'text/html');
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    const lots = f.kind === 'json'
      ? lotsFromJson(JSON.parse(res.text))
      : jsonBlobsFromHtml(res.text).flatMap(b => lotsFromJson(b));
    const hit = findLot(lots, lot.ext_id);
    if (!hasLive(hit)) throw new Error('lot not in feed');
    fails[site] = 0;
    // Only live fields: the feed's titles/ids may be internal.
    const { bid, bid_count, end_at, buy_now, start_price, buy_method } = hit;
    return { bid, bid_count, end_at, buy_now, start_price, buy_method };
  } catch (e) {
    fails[site] = (fails[site] || 0) + 1;
    if (fails[site] >= 5) {
      log.warn(site, `fast price feed stopped working (${e.message}) - back to full page reads until it's re-learned`);
      delete feeds[site];
      fails[site] = 0;
      save();
    }
    return null;
  }
}

export function forget(site) { delete feeds[site]; save(); }
