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

// ---- free-text places (freight jobs: "Fyshwick ACT 2609", "TOOWOOMBA CITY", "Canberra") ----
// Big towns answer instantly; anything else is looked up once and cached.
export const TOWNS = {
  canberra: [-35.2809, 149.13, 'ACT'], queanbeyan: [-35.3533, 149.2342, 'NSW'], sydney: [-33.8688, 151.2093, 'NSW'], melbourne: [-37.8136, 144.9631, 'VIC'],
  brisbane: [-27.4698, 153.0251, 'QLD'], perth: [-31.9523, 115.8613, 'WA'], adelaide: [-34.9285, 138.6007, 'SA'], hobart: [-42.8821, 147.3272, 'TAS'],
  darwin: [-12.4634, 130.8456, 'NT'], wollongong: [-34.4278, 150.8931, 'NSW'], newcastle: [-32.9283, 151.7817, 'NSW'], goulburn: [-34.7546, 149.7186, 'NSW'],
  yass: [-34.8406, 148.9093, 'NSW'], cooma: [-36.2357, 149.1251, 'NSW'], 'batemans bay': [-35.7082, 150.1744, 'NSW'], bowral: [-34.4778, 150.4184, 'NSW'],
  albury: [-36.0737, 146.9135, 'NSW'], 'wagga wagga': [-35.1082, 147.3598, 'NSW'], bathurst: [-33.4193, 149.5775, 'NSW'], orange: [-33.2835, 149.1013, 'NSW'],
  dubbo: [-32.2569, 148.6011, 'NSW'], 'gold coast': [-28.0167, 153.4, 'QLD'], 'sunshine coast': [-26.65, 153.0667, 'QLD'], geelong: [-38.1499, 144.3617, 'VIC'],
  ballarat: [-37.5622, 143.8503, 'VIC'], bendigo: [-36.757, 144.2794, 'VIC'], karnup: [-32.369, 115.857, 'WA'], mandurah: [-32.5269, 115.7217, 'WA'],
  rockingham: [-32.2768, 115.7292, 'WA'], fremantle: [-32.0569, 115.7439, 'WA'], bunbury: [-33.3271, 115.6414, 'WA'], parramatta: [-33.8151, 151.0011, 'NSW'],
  'central coast': [-33.4245, 151.3418, 'NSW'], 'port macquarie': [-31.4333, 152.9, 'NSW'], toowoomba: [-27.5598, 151.9507, 'QLD'], townsville: [-19.259, 146.8169, 'QLD'],
  cairns: [-16.9186, 145.7781, 'QLD'], launceston: [-41.4332, 147.1441, 'TAS'], 'alice springs': [-23.698, 133.8807, 'NT'], 'nowra': [-34.8808, 150.6, 'NSW'],
};
const tidyPlace = t => String(t || '').replace(/\s+/g, ' ').replace(/,?\s*australia$/i, '').trim();
const qkey = t => 'q:' + tidyPlace(t).toLowerCase();

/** Instant answer for a free-text place: a known town, a cached lookup, or the state's main city (approximate). */
export function locate(text) {
  const t = tidyPlace(text);
  if (!t) return null;
  const low = t.toLowerCase();
  const town = TOWNS[low] || TOWNS[low.replace(/\s+(city|cbd|central)$/, '')];
  if (town) return { lat: town[0], lon: town[1], state: town[2], approx: false, name: t };
  const hit = cache[qkey(t)];
  if (hit && hit.lat != null) return { lat: hit.lat, lon: hit.lon, state: hit.state, approx: false, name: t };
  const st = (STATE_RE.exec(t) || [])[1];
  const sub = placeOf({ location: t });
  if (sub?.suburb && cache[sub.key]?.lat != null) return { lat: cache[sub.key].lat, lon: cache[sub.key].lon, state: sub.state, approx: false, name: t };
  if (st && STATE_CITY[st]) return { lat: STATE_CITY[st][0], lon: STATE_CITY[st][1], state: st, approx: true, name: t };
  return null;
}

async function nominatim(q) {
  const u = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=au&addressdetails=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(u, { headers: { 'user-agent': `KAMRADS (${config.dashboardPublicUrl || 'private use'})`, 'accept-language': 'en-AU' }, signal: AbortSignal.timeout(10000) });
  if (res.status === 429 || res.status === 403) { const e = new Error(`lookups paused (HTTP ${res.status})`); e.stop = true; throw e; }
  const j = await res.json();
  if (!j[0]) return { lat: null };
  const iso = j[0].address?.['ISO3166-2-lvl4'] || '';
  return { lat: Number(j[0].lat), lon: Number(j[0].lon), state: (/AU-([A-Z]+)/.exec(iso) || [])[1] || null };
}

/** Look one place up now (e.g. a place typed into a route alert). */
export async function geocodeNow(text) {
  const have = locate(text);
  if (have && !have.approx) return have;
  if (!config.geocode) return have;
  try {
    cache[qkey(text)] = await nominatim(`${tidyPlace(text)}, Australia`);
    save();
  } catch (e) { log.warn('geo', `${text}: ${e.message}`); }
  return locate(text);
}

let qbusy = false;
/** Look up free-text places we haven't seen yet, 1 a second. */
export async function geocodeTexts(texts, max = 40) {
  if (qbusy || !config.geocode) return 0;
  qbusy = true;
  let n = 0;
  try {
    const todo = [...new Set(texts.map(tidyPlace).filter(Boolean))].filter(t => { const l = locate(t); return (!l || l.approx) && !(qkey(t) in cache); });
    for (const t of todo.slice(0, max)) {
      try { cache[qkey(t)] = await nominatim(`${t}, Australia`); n++; } catch (e) { log.warn('geo', `${t}: ${e.message}`); if (e.stop) break; }
      await new Promise(r => setTimeout(r, 1100));
    }
    if (n) { save(); log.info('geo', `located ${n} more places`); }
  } finally { qbusy = false; }
  return n;
}

/** For tests. */
export function _setCache(c) { cache = c; }
