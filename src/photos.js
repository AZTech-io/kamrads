// Lot photos, fetched by the KAMRADS server and cached, so the auction sites never see the
// dashboard's address (and hotlink-protected photos still load). Only photos of lots we track
// can be fetched - this is not an open proxy.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';

const dir = path.join(config.dataDir, 'photos');
fs.mkdirSync(dir, { recursive: true });
const MAX_BYTES = 3 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const inflight = new Map();

export async function photo(lot) {
  if (!lot?.image || !/^https?:\/\//.test(lot.image)) return null;
  const id = crypto.createHash('sha1').update(lot.image).digest('hex');
  const file = path.join(dir, id);
  if (fs.existsSync(file)) {
    const meta = JSON.parse(fs.readFileSync(file + '.json', 'utf8'));
    return { file, type: meta.type };
  }
  if (!inflight.has(id)) inflight.set(id, (async () => {
    // Look like the site's own page asking for its photo (many CDNs check this).
    const origin = lot.url ? new URL(lot.url).origin + '/' : undefined;
    const res = await fetch(lot.image, { headers: { 'user-agent': UA, accept: 'image/avif,image/webp,image/*,*/*;q=0.8', ...(origin ? { referer: origin } : {}) }, signal: AbortSignal.timeout(15000) });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !/^image\//.test(type)) throw new Error(`photo HTTP ${res.status} ${type}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('photo too large');
    fs.writeFileSync(file, buf);
    fs.writeFileSync(file + '.json', JSON.stringify({ type, url: lot.image, at: Date.now() }));
    return { file, type };
  })().finally(() => inflight.delete(id)));
  return inflight.get(id);
}

/** Keep the photo cache under PHOTO_CACHE_MB (oldest go first). */
export function prunePhotos() {
  try {
    const files = fs.readdirSync(dir).filter(f => !f.endsWith('.json')).map(f => {
      const st = fs.statSync(path.join(dir, f)); return { f, size: st.size, at: st.mtimeMs };
    }).sort((a, b) => a.at - b.at);
    let total = files.reduce((a, x) => a + x.size, 0);
    const cap = config.photoCacheMb * 1048576;
    let n = 0;
    for (const x of files) {
      if (total <= cap) break;
      fs.rmSync(path.join(dir, x.f), { force: true }); fs.rmSync(path.join(dir, x.f + '.json'), { force: true });
      total -= x.size; n++;
    }
    if (n) log.info('photos', `pruned ${n} old photos`);
  } catch (e) { log.warn('photos', e.message); }
}
