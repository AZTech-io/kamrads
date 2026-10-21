// Live-lane sales (Pickles Live, Manheim simulcast...) are sold by an auctioneer at some point on the
// sale day; the listed "close" is just a placeholder like 11:59:59 pm. There's no countdown to watch.
const endOfDay = t => {
  if (!t) return false;
  for (const tz of ['Australia/Sydney', 'Australia/Perth', 'Australia/Brisbane', 'Australia/Adelaide']) {
    const hms = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(t));
    if (hms === '23:59:59' || hms === '23:59:00') return true;
  }
  return false;
};
export const isLiveSale = lot => /\blive\b|simulcast|in[- ]?lane|on[- ]?site auction/i.test(lot.buy_method || lot.buyMethod || '') || endOfDay(lot.end_at ?? lot.endAt);
