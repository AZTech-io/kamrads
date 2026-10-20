// Where a lot is, and how far from home. Suburbs are looked up once on OpenStreetMap (Nominatim,
// 1 request a second, as its rules ask) and cached in data/geo.json; until then, or if a lookup
// fails, the state's main city stands in (marked approximate).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './log.js';

const file = path.join(config.dataDir, 'geo.json');
let cache = {};
try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
const save = () => { try { fs.writeFileSync(file, JSON.stringify(cache)); } catch { /* ignore */ } };

export const STATE_CITY = {
  NSW: [-33.8688, 151.2093], VIC: [-37.8136, 144.9631], QLD: [-27.4698, 153.0251], WA: [-31.9523, 115.8613],
  SA: [-34.9285, 138.6007], TAS: [-42.8821, 147.3272], ACT: [-35.2809, 149.13], NT: [-12.4634, 130.8456],
};
const STATE_RE = /\b(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b/;

/** "Yard 3/263 Connors Road, Paget, QLD, Australia" -> { key: "paget, QLD", suburb: "Paget", state: "QLD" } */
export function placeOf(lot) {
  const text = `${lot.location || ''}${lot.state && !STATE_RE.test(lot.location || '') ? ', ' + lot.state : ''}`;
  const st = (STATE_RE.exec(text) || [])[1] || (STATE_RE.exec(lot.state || '') || [])[1];
  if (!st) return null;
  const before = text.slice(0, text.search(STATE_RE)).split(',').map(s => s.trim()).filter(Boolean);
  let suburb = (before[before.length - 1] || '').replace(/\b\d{4}\b/, '').replace(/^(yard|unit|lot|shop)\s*\S+\s*/i, '').trim();
  if (/\d/.test(suburb) || suburb.length < 3) suburb = '';
  return { key: `${suburb.toLowerCase()}, ${st}`, suburb, state: st };
}

/** [lat, lon, approximate?] for a lot, from the cache (never waits on the network). */
export function coordsOf(lot) {
  const p = placeOf(lot);
  if (!p) return null;
  const hit = p.suburb ? cache[p.key] : null;
  if (hit && hit.lat != null) return [hit.lat, hit.lon, false];
  return STATE_CITY[p.state] ? [...STATE_CITY[p.state], true] : null;
}

const rad = d => (d * Math.PI) / 180;
export function haversineKm(a, b) {
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** Home bases from HOME_BASES ("Karnup WA:-32.369,115.857|Canberra ACT:-35.281,149.129"). */
export const bases = () => config.homeBases;
export const baseByName = name => bases().find(b => b.name === name) || bases()[0];

/** Rough road distance (straight line x 1.25) from a base, or null if we don't know where the lot is. */
export function distanceKm(lot, base) {
  const c = coordsOf(lot);
  if (!c || !base) return null;
  return { km: Math.round(haversineKm([base.lat, base.lon], c) * 1.25), approx: c[2] };
}

let busy = false;
/** Look up suburbs we haven't seen yet (called every few minutes). */
export async function geocodePending(lots, max = 40) {
  if (busy || !config.geocode) return 0;
  busy = true;
  let n = 0;
  try {
    const todo = new Map();
    for (const l of lots) { const p = placeOf(l); if (p?.suburb && !(p.key in cache)) todo.set(p.key, p); }
    for (const p of [...todo.values()].slice(0, max)) {
      try {
        const u = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=au&q=${encodeURIComponent(`${p.suburb}, ${p.state}, Australia`)}`;
        const res = await fetch(u, { headers: { 'user-agent': `KAMRADS auction monitor (${config.dashboardPublicUrl || 'private use'})`, 'accept-language': 'en-AU' }, signal: AbortSignal.timeout(10000) });
        if (res.status === 429 || res.status === 403) { log.warn('geo', `lookups paused (HTTP ${res.status})`); break; }
        const j = await res.json();
        cache[p.key] = j[0] ? { lat: Number(j[0].lat), lon: Number(j[0].lon) } : { lat: null };
        n++;
      } catch (e) { log.warn('geo', `${p.key}: ${e.message}`); }
      await new Promise(r => setTimeout(r, 1100));
    }
    if (n) { save(); log.info('geo', `located ${n} more suburbs (${Object.keys(cache).length} known)`); }
  } finally { busy = false; }
  return n;
}

/** For tests. */
export function _setCache(c) { cache = c; }
