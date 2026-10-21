// When a site says "too many requests" (HTTP 429) or blocks us, leave it alone for a while instead of
// retrying straight away: 2 min, then 4, 8, 16, up to 30 min; back to normal after a good read.
import { log } from './log.js';

const state = new Map(); // site -> { until, step }
const MIN = 60000;

export const isPaused = (site, now = Date.now()) => (state.get(site)?.until || 0) > now;
export const pausedUntil = site => state.get(site)?.until || null;
export const isRateLimit = msg => /\b429\b|too many requests|blocked by/i.test(String(msg || ''));

export function pause(site, why = '', now = Date.now()) {
  const s = state.get(site) || { until: 0, step: 0 };
  if (s.until > now) return s.until;          // already paused: don't stack
  s.step = Math.min(s.step + 1, 5);
  s.until = now + Math.min(2 * MIN * 2 ** (s.step - 1), 30 * MIN);
  state.set(site, s);
  log.warn(site, `pausing reads for ${Math.round((s.until - now) / MIN)} min${why ? ` (${why})` : ''}`);
  return s.until;
}
export function ok(site) { const s = state.get(site); if (s && s.until <= Date.now()) state.delete(site); }
export const _reset = () => state.clear();
