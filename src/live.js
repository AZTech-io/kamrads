// Live-lane sales (Pickles Live, Manheim simulcast...) are sold by an auctioneer at some point on the
// sale day; the listed "close" is just a placeholder like 11:59:59 pm. There's no countdown to watch.
// (Formatters are built once: making one per lot was most of the time it took to load the board.)
const FMT = ['Australia/Sydney', 'Australia/Perth', 'Australia/Brisbane', 'Australia/Adelaide']
  .map(tz => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }));
const seen = new Map();
const endOfDay = t => {
  if (!t) return false;
  const d = new Date(t);
  // Australian offsets are whole minutes, so the seconds are the same everywhere: most times are ruled out here
  const sec = d.getUTCSeconds(), min = d.getUTCMinutes();
  if (!(sec === 59 || sec === 0) || !(min === 59 || min === 29)) return false;
  if (seen.has(t)) return seen.get(t);
  const hit = FMT.some(f => { const hms = f.format(d); return hms === '23:59:59' || hms === '23:59:00'; });
  if (seen.size > 5000) seen.clear();
  seen.set(t, hit);
  return hit;
};
export const isLiveSale = lot => /\blive\b|simulcast|in[- ]?lane|on[- ]?site auction/i.test(lot.buy_method || lot.buyMethod || '') || endOfDay(lot.end_at ?? lot.endAt);
