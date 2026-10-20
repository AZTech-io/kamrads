// "Check listing": Claude reads the lot's description and photos for deal-breakers before you bid
// (won't start, no keys, flood/fire damage, missing parts, hail...). One call, a few cents.
import { config } from './config.js';
import { q } from './db.js';
import { log } from './log.js';
import { withPage } from './browser.js';
import * as settings from './settings.js';

const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Description text + photo links from the lot page. */
async function readListing(lot) {
  const r = await withPage(lot.site, lot.url, page => page.evaluate(() => {
    const imgs = [];
    for (const img of document.querySelectorAll('img')) {
      const src = img.currentSrc || img.getAttribute('data-src') || img.getAttribute('data-lazy') || img.src || '';
      const w = Number(img.getAttribute('width')) || img.naturalWidth || 0;
      if (!/^https?:/.test(src) || /logo|icon|sprite|avatar|badge|placeholder|\.svg/i.test(src) || (w && w < 120)) continue;
      if (!imgs.includes(src)) imgs.push(src);
    }
    for (const m of document.querySelectorAll('meta[property="og:image"]')) if (m.content && !imgs.includes(m.content)) imgs.unshift(m.content);
    return imgs.slice(0, 8);
  }), { waitMs: 1500, high: true });
  return { text: (r.text || '').replace(/\n{3,}/g, '\n\n').slice(0, 9000), images: r.result || [] };
}

const PROMPT = lot => `You are checking an Australian auction listing for a buyer who resells. Lot: ${lot.title} (${lot.site}${lot.wovr ? ', ' + lot.wovr : ''}${lot.odometer ? ', ' + lot.odometer + ' km' : ''}).

Read the listing text${'{IMG}'} and look for anything that makes it a worse buy than the price suggests:
starts/drives or not, keys, engine/gearbox problems, flood, fire, hail, major panel/structural damage, airbags deployed,
missing parts, no compliance/rego papers, write-off status, "sold as is / not tested", heavy rust, tampered odometer, damaged screen/parts for goods.

Reply with ONLY this JSON:
{"verdict": "good"|"caution"|"avoid", "summary": "max 20 words", "flags": ["short phrase", ...],
 "starts": "yes"|"no"|"unknown", "keys": "yes"|"no"|"unknown"}

Listing text:
`;

async function ask(key, content) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal: AbortSignal.timeout(90000),
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: config.anthropicModel, max_tokens: 600, messages: [{ role: 'user', content }] }),
  });
  const text = await res.text();
  if (!res.ok) { const e = new Error(`Claude API HTTP ${res.status}: ${text.slice(0, 200)}`); e.status = res.status; e.body = text; throw e; }
  return JSON.parse(text);
}

export async function checkListing(lot, { read = readListing } = {}) {
  const key = settings.get('anthropicKey');
  if (!key) throw new Error('No Claude API key saved - add one in Settings.');
  const { text, images } = await read(lot);
  const build = withImages => [
    ...(withImages ? images.slice(0, 6).map(url => ({ type: 'image', source: { type: 'url', url } })) : []),
    { type: 'text', text: PROMPT(lot).replace('{IMG}', withImages && images.length ? ' and the photos' : '') + text },
  ];
  let data;
  try { data = await ask(key, build(true)); } catch (e) {
    // Some sites don't let outsiders load their photos: fall back to the text alone.
    if (images.length && e.status === 400 && /image|url|fetch|download/i.test(e.body || '')) data = await ask(key, build(false));
    else throw e;
  }
  const out = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no verdict in reply');
  const j = JSON.parse(m[0]);
  const verdict = ['good', 'caution', 'avoid'].includes(j.verdict) ? j.verdict : 'caution';
  const note = { summary: String(j.summary || '').slice(0, 160), flags: (Array.isArray(j.flags) ? j.flags : []).map(f => String(f).slice(0, 60)).slice(0, 8),
    starts: j.starts || 'unknown', keys: j.keys || 'unknown', photos: images.length };
  q.setCheck.run(verdict, JSON.stringify(note), Date.now(), lot.key);
  log.info('check', `${lot.key} ${lot.title?.slice(0, 40)} -> ${verdict}: ${note.summary}`);
  return { verdict, ...note };
}

/** Background: check lots someone has bid on, once each, within the daily research limit. */
export async function checkPending() {
  if (!settings.get('anthropicKey') || !settings.get('researchEnabled')) return;
  const cap = Number(settings.get('researchPerDay')) || 0;
  if (q.checksToday.get(startOfDay()).n >= Math.ceil(cap / 3)) return;
  for (const lot of q.checkQueue.all(Date.now())) {
    try { await checkListing(lot); } catch (e) { q.setCheck.run('error', JSON.stringify({ summary: e.message.slice(0, 150) }), Date.now(), lot.key); log.warn('check', `${lot.key}: ${e.message}`); }
  }
}
