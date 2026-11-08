// Each person's cruise filters (ports, line, length, price, when) and red-hot level. The page shows them and the
// hourly alert uses the same ones, so what's flagged at the top of the page is what buzzes the phone.
import * as settings from '../settings.js';
import { config } from '../config.js';
import { PORT_KEYS, nightly, dayMs } from './parse.js';

export const LENGTHS = { '': [1, 999], short: [1, 4], week: [5, 8], long: [9, 15], extended: [16, 999] };
export const SORTS = ['night', 'price', 'soon', 'new', 'drop'];

export const defaultView = () => ({ ports: [], line: '', len: '', maxPrice: null, maxNight: null, within: 0, sort: 'night', share: false,
  hot: config.cruises.hotPerNight, alerts: true });

const n = v => (v === '' || v == null || !Number.isFinite(Number(v)) || Number(v) <= 0 ? null : Number(v));
/** Clean a view sent from the page. */
export function cleanView(b = {}, prev = defaultView()) {
  const v = { ...prev };
  if ('ports' in b) v.ports = (Array.isArray(b.ports) ? b.ports : String(b.ports || '').split(',')).filter(k => PORT_KEYS[k]);
  if ('line' in b) v.line = String(b.line || '').slice(0, 40);
  if ('len' in b) v.len = b.len in LENGTHS ? b.len : '';
  if ('maxPrice' in b) v.maxPrice = n(b.maxPrice);
  if ('maxNight' in b) v.maxNight = n(b.maxNight);
  if ('within' in b) v.within = [0, 1, 3, 6, 12].includes(Number(b.within)) ? Number(b.within) : 0;
  if ('sort' in b) v.sort = SORTS.includes(b.sort) ? b.sort : 'night';
  if ('share' in b) v.share = !!b.share;
  if ('hot' in b) v.hot = Math.max(5, Math.min(1000, n(b.hot) ?? config.cruises.hotPerNight));
  if ('alerts' in b) v.alerts = !!b.alerts;
  return v;
}

export const viewOf = user => ({ ...defaultView(), ...(settings.getUser(user, 'cruiseView') || {}) });
export const hasView = user => !!settings.getUser(user, 'cruiseView');
export const saveView = (user, v) => settings.setUser(user, { cruiseView: v });

/** The price a night is judged on for this person: twin share, or with share on the lower of twin and a 3rd/4th-guest fare. */
export function nightOf(c, share = false) {
  const nn = nightly(c);
  const list = [nn.twin, share ? nn.share : null].filter(x => x != null);
  if (list.length) return { night: Math.min(...list), basis: share && nn.share != null && (nn.twin == null || nn.share < nn.twin) ? 'share' : 'twin' };
  return nn.share != null ? { night: nn.share, basis: 'share-only' } : { night: null, basis: null };
}
export const leadOf = (c, share = false) => {
  const list = [c.twin, share ? c.triple : null, share ? c.quad : null].filter(x => x != null);
  return list.length ? Math.min(...list) : [c.triple, c.quad].filter(x => x != null).sort((a, b) => a - b)[0] ?? null;
};

/** Does a cruise fit the person's filters? */
export function fits(c, v, now = Date.now()) {
  if (v.ports?.length && !v.ports.includes(c.port)) return false;
  if (v.line && c.line !== v.line) return false;
  const [lo, hi] = LENGTHS[v.len] || LENGTHS[''];
  if (c.nights == null || c.nights < lo || c.nights > hi) return false;
  const lead = leadOf(c, v.share);
  if (v.maxPrice != null && (lead == null || lead > v.maxPrice)) return false;
  const { night } = nightOf(c, v.share);
  if (v.maxNight != null && (night == null || night > v.maxNight)) return false;
  if (v.within) { const d = dayMs(c.depart); if (d == null || d > now + v.within * 30.5 * 864e5) return false; }
  return true;
}

/** Red hot: at or under the person's $/night - on twin share (a share-only fare counts only when share is on). */
export function isRedHot(c, v) {
  const { night, basis } = nightOf(c, v.share);
  return night != null && night <= v.hot && (basis !== 'share-only' || v.share);
}
