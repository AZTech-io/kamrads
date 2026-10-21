// Find where a site gets a lot's live bid and close time from, so KAMRADS can read it without a browser.
//   npm run probe-feed -- "<lot page URL>"
// Opens the lot page, watches it for 25 s, and prints:
//   - every data request (XHR/fetch), with whether its body holds this lot's bid / id / a close time
//   - live connections (websocket, event stream) and their first messages
//   - close times hidden in the page's plain HTML (data attributes, script variables)
//   - what a plain HTML fetch of the page (no browser) contains
// Writes the full bodies to data/probe/feed-<host>-<time>/ for a closer look. Read-only: it never bids or logs in.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { config } from '../src/config.js';
import { factsFromText, timeFromHtml } from '../src/extract.js';

const url = process.argv[2];
if (!url) { console.log('Usage: npm run probe-feed -- "<lot page URL>"'); process.exit(1); }
const WATCH_MS = Number(process.argv[3]) || 25000;
const host = new URL(url).host.replace(/^www\./, '');
const outDir = path.join(config.dataDir, 'probe', `feed-${host}-${Date.now()}`);
fs.mkdirSync(outDir, { recursive: true });

const launch = { headless: true, executablePath: config.chromePath || undefined, args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu'] };
if (config.proxy) { const u = new URL(config.proxy); launch.proxy = { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(u.username) || undefined, password: decodeURIComponent(u.password) || undefined }; }
const browser = await chromium.launch(launch);
const ctx = await browser.newContext({ locale: 'en-AU', timezoneId: 'Australia/Sydney', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' });
const page = await ctx.newPage();

const reqs = [];
const sockets = [];
page.on('response', async res => {
  const req = res.request();
  const type = req.resourceType();
  if (!['xhr', 'fetch', 'eventsource', 'document', 'other'].includes(type)) return;
  const ct = res.headers()['content-type'] || '';
  let body = '';
  try { if (/json|text|javascript|xml/.test(ct)) body = (await res.text()).slice(0, 400000); } catch { /* streamed */ }
  reqs.push({ t: Date.now(), type, method: req.method(), url: res.url(), status: res.status(), ct, body, post: req.postData()?.slice(0, 500) || null });
});
page.on('websocket', ws => {
  const s = { url: ws.url(), frames: [] };
  sockets.push(s);
  ws.on('framereceived', f => { if (s.frames.length < 12) s.frames.push(String(f.payload).slice(0, 400)); });
  ws.on('framesent', f => { if (s.frames.length < 12) s.frames.push('SENT ' + String(f.payload).slice(0, 300)); });
});

const t0 = Date.now();
console.log(`Opening ${url} ...`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('goto:', e.message));
await page.waitForTimeout(4000);
const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
const html = await page.content().catch(() => '');
console.log(`Watching for ${WATCH_MS / 1000}s (polling, live updates)...`);
await page.waitForTimeout(WATCH_MS);

// What the rendered page says
const seen = factsFromText(text);
const bid = seen.bid;
const ids = [...new Set((url.match(/\d{4,}/g) || []))];
console.log('\n=== The page as you see it ===');
console.log(`bid ${bid ?? '?'} · bids ${seen.bid_count ?? '?'} · close ${seen.end_at ? new Date(seen.end_at).toISOString() : '?'} · reserve ${seen.reserve ?? '?'} · location ${seen.location ?? '?'} · odometer ${seen.odometer ?? '?'}`);
const near = (t, re) => { const m = re.exec(t); return m ? t.slice(Math.max(0, m.index - 80), m.index + 160).replace(/\s+/g, ' ') : null; };
for (const re of [/time\s*left|closes?|closing|going,?\s*going|ends?\s+in/i, /current\s*bid|bids?\b/i, /location|pick ?up|address/i]) {
  const snip = near(text, re); if (snip) console.log(`  …${snip}…`);
}

// Data requests
const bidStrs = bid != null ? [String(bid), bid.toLocaleString('en-AU'), bid.toFixed(2)] : [];
const timeKeys = /"[A-Za-z_]*(?:end|clos|finish|expir)[A-Za-z_]*"\s*:\s*("[^"]{6,40}"|\d{10,13})/gi;
console.log(`\n=== Data requests (${reqs.length}) ===`);
reqs.forEach((r, i) => {
  const hasBid = bidStrs.some(b => r.body.includes(b));
  const hasId = ids.some(id => r.body.includes(id) || r.url.includes(id));
  const times = [...r.body.matchAll(timeKeys)].slice(0, 3).map(m => m[0].slice(0, 70));
  const mark = [hasBid ? 'HAS BID' : '', hasId ? 'has lot id' : '', times.length ? 'has close time' : ''].filter(Boolean).join(', ');
  if (r.type === 'document' && i > 0 && !mark) return;
  console.log(`\n[${i}] +${Math.round((r.t - t0) / 1000)}s ${r.method} ${r.status} ${r.type} ${r.ct.split(';')[0]} ${r.body.length}b ${mark ? '<<< ' + mark : ''}`);
  console.log(`    ${r.url.slice(0, 300)}`);
  if (r.post) console.log(`    POST ${r.post.slice(0, 300)}`);
  if (times.length) console.log(`    times: ${times.join(' | ')}`);
  if (hasBid && r.body) { const at = bidStrs.map(b => r.body.indexOf(b)).find(x => x >= 0); console.log(`    …${r.body.slice(Math.max(0, at - 200), at + 200).replace(/\s+/g, ' ')}…`); }
  fs.writeFileSync(path.join(outDir, `req-${String(i).padStart(3, '0')}.txt`), `${r.method} ${r.url}\n${r.post || ''}\n\n${r.body}`);
});
// Repeated (polling) requests
const counts = {};
for (const r of reqs) { const k = r.url.split('?')[0]; counts[k] = (counts[k] || 0) + 1; }
const polled = Object.entries(counts).filter(([, n]) => n > 1);
if (polled.length) { console.log('\n=== Asked again while watching (polling) ==='); for (const [u, n] of polled) console.log(`  ${n}× ${u.slice(0, 200)}`); }

console.log(`\n=== Live connections (${sockets.length}) ===`);
for (const s of sockets) { console.log(`  ${s.url.slice(0, 200)}`); for (const f of s.frames) console.log(`    ${f.replace(/\s+/g, ' ').slice(0, 300)}`); }

console.log('\n=== Close time hidden in the HTML ===');
const t = timeFromHtml(html);
console.log(t ? `  found: ${new Date(t).toISOString()}` : '  none found by the usual patterns');
for (const m of [...html.matchAll(/(?:data-[a-z-]*(?:end|clos|time|date)[a-z-]*|(?:end|clos)[A-Za-z_]*(?:Date|Time|At|Utc))["']?\s*[:=]\s*["']?[^"'\s,}<]{6,40}/gi)].slice(0, 12)) console.log(`  ${m[0].slice(0, 120)}`);

// Plain fetch of the page: what a no-browser read gets
console.log('\n=== Plain HTML fetch (no browser) ===');
try {
  const raw = await page.evaluate(async u => { const r = await fetch(u, { credentials: 'include' }); return { status: r.status, text: await r.text() }; }, url);
  const rawText = raw.text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, '\n').replace(/\n\s*\n+/g, '\n');
  const f = factsFromText(rawText);
  console.log(`  HTTP ${raw.status}, ${raw.text.length} bytes · bid ${f.bid ?? '-'} · bids ${f.bid_count ?? '-'} · reserve ${f.reserve ?? '-'} · close ${f.end_at ? new Date(f.end_at).toISOString() : '-'} · hidden close ${timeFromHtml(raw.text) ? new Date(timeFromHtml(raw.text)).toISOString() : '-'}`);
  fs.writeFileSync(path.join(outDir, 'plain.html'), raw.text);
} catch (e) { console.log('  failed:', e.message); }

fs.writeFileSync(path.join(outDir, 'page.txt'), text);
fs.writeFileSync(path.join(outDir, 'page.html'), html);
console.log(`\nFull bodies saved in ${outDir}`);
await browser.close();
