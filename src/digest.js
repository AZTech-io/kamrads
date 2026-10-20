// Morning digest: one push per person at their chosen hour - what's closing today that matches
// their alerts, the best deals on now, their watchlist, and yesterday's best missed deals.
import { config } from './config.js';
import { q } from './db.js';
import { push } from './notify.js';
import * as settings from './settings.js';
import { estimateOf } from './alerts.js';
import { compile, matches } from './searches.js';
import { log } from './log.js';

const money = n => (n == null ? '?' : '$' + Math.round(n).toLocaleString('en-AU'));
const localParts = (tz, t = Date.now()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
};
const time = (t, tz) => new Date(t).toLocaleTimeString('en-AU', { timeZone: tz, hour: 'numeric', minute: '2-digit' });

export function buildDigest(user, now = Date.now()) {
  const tz = settings.getUser(user, 'digestTz') || config.digestTz;
  const open = q.closingToday.all(now, now + 24 * 3600000).filter(l => l.wovr !== 'Statutory Write-Off' || config.includeStatutory);
  const lines = [];
  // 1. your alerts
  const hits = [];
  for (const s of q.searchesOf.all(user)) {
    const test = compile(s.terms);
    for (const l of open) if (matches(s, l, test) && (s.max_price == null || (l.bid ?? l.start_price ?? 0) <= s.max_price)) hits.push({ l, s });
  }
  if (hits.length) {
    lines.push(`🔔 ${hits.length} of your alert matches close in the next 24 h:`);
    for (const { l } of hits.slice(0, 4)) lines.push(`• ${l.title} — ${money(l.bid ?? l.start_price)} · ${time(l.end_at, tz)}`);
  }
  // 2. best deals
  const deals = open.map(l => ({ l, est: estimateOf(l), p: l.bid ?? l.start_price })).filter(x => x.est && x.p != null && x.p <= x.est * 0.5)
    .sort((a, b) => a.p / a.est - b.p / b.est).slice(0, 3);
  if (deals.length) {
    lines.push('🔥 Best deals right now:');
    for (const { l, est, p } of deals) lines.push(`• ${l.title} — ${money(p)} (est ${money(est)}) · ${time(l.end_at, tz)}`);
  }
  // 3. watchlist
  const mine = q.userWatchlist.all(user, now).filter(l => l.status === 'open' && l.end_at && l.end_at < now + 24 * 3600000);
  if (mine.length) lines.push(`★ ${mine.length} on your watchlist close in the next 24 h${mine.some(l => l.my_bid != null && l.bid > l.my_bid) ? ' — you\'re outbid on some' : ''}.`);
  // 4. missed yesterday
  const missed = q.missed.all(now - 86400000).filter(l => l.final_seen_at && l.end_at - l.final_seen_at <= 900000 && l.wovr !== 'Statutory Write-Off')
    .map(l => ({ l, est: estimateOf(l) })).filter(x => x.est && x.l.final_bid <= x.est * 0.5).sort((a, b) => (b.est - b.l.final_bid) - (a.est - a.l.final_bid)).slice(0, 3);
  if (missed.length) {
    lines.push('😬 Missed yesterday:');
    for (const { l, est } of missed) lines.push(`• ${l.title} went for ${money(l.final_bid)} (est ${money(est)})`);
  }
  return lines.length ? lines.join('\n') : null;
}

/** Called every minute: send each person's digest once, at their hour. */
export async function digestTick(now = Date.now()) {
  for (const user of Object.keys(config.users)) {
    if (settings.getUser(user, 'digestOff')) continue;
    const tz = settings.getUser(user, 'digestTz') || config.digestTz;
    const hour = settings.getUser(user, 'digestHour') ?? config.digestHour;
    const { date, hour: h } = localParts(tz, now);
    if (h !== Number(hour) || settings.getUser(user, 'digestSent') === date) continue;
    settings.setUser(user, { digestSent: date });
    const body = buildDigest(user, now);
    if (!body) { log.info('digest', `${user}: nothing worth sending today`); continue; }
    await push({ to: user, priority: 'default', tags: 'sunrise', url: config.dashboardPublicUrl || undefined, title: 'KAMRADS morning digest', message: body });
  }
}
