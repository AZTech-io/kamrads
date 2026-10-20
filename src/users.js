// Per-user watchlist and "my bid". Auction sites use proxy (max) bidding, so if you put in $5,000
// and the shown price is still at or under $5,000, nobody has beaten your max: you're winning.
// Once the shown price passes $5,000, someone else's max is higher: you've been outbid.
import { q } from './db.js';
import { push } from './notify.js';
import { config } from './config.js';

const money = n => (n == null ? '?' : '$' + Math.round(n).toLocaleString('en-AU'));

export function watch(user, key) { q.watch.run(user, key, Date.now()); q.syncStar.run(key); }
export function unwatch(user, key) { q.unwatch.run(user, key); q.syncStar.run(key); }

/** Record (or clear, with null) the most this user has bid on a lot. Also puts it on their watchlist. */
export function setMyBid(user, key, value) {
  q.myBid.run(user, key, value, Date.now());
  q.syncStar.run(key);
  for (const k of ['outbid', 'atmax']) q.clearUserAlert.run(user, key, k); // a new bid re-arms the outbid alert
}

/**
 * winning | atmax | outbid | won | lost | nobids | null (no bid recorded)
 * atmax: price equals your max - you're winning only if your bid was placed first.
 */
export function bidStatus(lot, myBid) {
  if (myBid == null) return null;
  const closed = lot.status === 'closed';
  const price = closed ? (lot.final_bid ?? lot.bid) : lot.bid;
  if (price == null) return closed ? null : 'nobids';
  if (closed) return price <= myBid ? 'won' : 'lost';
  if (price > myBid) return 'outbid';
  if (price === myBid) return 'atmax';
  return 'winning';
}

/** After a fresh price: tell each person who has bid on this lot if they've just been outbid. */
export async function checkBidders(lot, now = Date.now()) {
  for (const w of q.watchersOf.all(lot.key)) {
    const st = bidStatus(lot, w.my_bid);
    if (st !== 'outbid' || q.userAlertSent.get(w.user, lot.key, 'outbid')) continue;
    q.addUserAlert.run(w.user, lot.key, 'outbid', now);
    const mins = lot.end_at ? Math.round((lot.end_at - now) / 60000) : null;
    await push({
      to: w.user, priority: mins != null && mins <= 15 ? 'urgent' : 'high', tags: 'warning', url: lot.url,
      title: `OUTBID: now ${money(lot.bid)} (your max ${money(w.my_bid)})`,
      message: [lot.title, mins != null ? (mins > 0 ? `${mins} min left` : 'closing now') : null, `${lot.site}`].filter(Boolean).join('\n'),
    });
  }
}

/** When a lot someone bid on closes: won or lost. */
export async function announceResult(lot, now = Date.now()) {
  for (const w of q.watchersOf.all(lot.key)) {
    const st = bidStatus(lot, w.my_bid);
    if (!st || !['won', 'lost'].includes(st) || q.userAlertSent.get(w.user, lot.key, 'result')) continue;
    q.addUserAlert.run(w.user, lot.key, 'result', now);
    const price = lot.final_bid ?? lot.bid;
    await push({
      to: w.user, priority: st === 'won' ? 'high' : 'default', tags: st === 'won' ? 'tada' : 'x', url: lot.url,
      title: st === 'won' ? `Looks like you WON at ${money(price)}` : `Lost: went past your max (${money(price)} vs ${money(w.my_bid)})`,
      message: `${lot.title}\nCheck your ${lot.site} account to confirm.`,
    });
  }
}

/** Final-minutes reminder for each person watching (replaces the old shared "WATCHED" alert). */
export async function finalMinutes(lot, now = Date.now()) {
  const mins = Math.max(1, Math.round((lot.end_at - now) / 60000));
  for (const w of q.watchersOf.all(lot.key)) {
    if (q.userAlertSent.get(w.user, lot.key, 'final')) continue;
    q.addUserAlert.run(w.user, lot.key, 'final', now);
    const st = bidStatus(lot, w.my_bid);
    const line = st === 'winning' ? `You're winning (max ${money(w.my_bid)})` : st === 'outbid' ? `You're OUTBID (max ${money(w.my_bid)})`
      : st === 'atmax' ? `At your max ${money(w.my_bid)}` : 'On your watchlist';
    await push({ to: w.user, priority: 'high', tags: 'hourglass', url: lot.url,
      title: `${mins} min left · ${money(lot.bid ?? lot.start_price)}`, message: `${lot.title}\n${line}` });
  }
}

export const userNames = () => Object.keys(config.users);
