// Sites built from the generic adapter. If one stops finding lots, its link pattern here is the
// first thing to check (npm run probe -- <a lot url> shows what the page returns).
import { makeSite } from './generic.js';
import { config } from '../config.js';
import { placeFromAddress, parseDayMonthTime, premiumTiers } from '../extract.js';

const lastNum = u => { const m = String(u || '').split(/[?#]/)[0].match(/\d{3,}/g); return m ? m[m.length - 1] : null; };

export const grays = makeSite({
  site: 'grays', label: 'Grays', origin: 'https://www.grays.com',
  // https://www.grays.com/lot/0007-23502659/motor-vehicles-motor-cycles/2016-hyundai-accent-active-petrol
  detailRe: /grays\.com\/lot\/\d{2,6}-\d{5,}(?:[/?#]|$)/i,
  idFromUrl: u => (/\/lot\/(\d{2,6}-\d{5,})/i.exec(u || '') || [])[1] || null,
  listings: config.sites.grays.listings, pageParam: 'page', maxPages: config.sites.grays.maxPages, scrolls: 4,
  // Grays' category menu: /search/<category> links (top level only), each read like a listing
  auctionsFrom: config.sites.grays.categoriesFrom || null,
  auctionRe: /grays\.com\/search\/[a-z0-9-]+\/?(?:\?[^#]*)?$/i,
  maxAuctions: config.sites.grays.maxCategories,
  skipFilter: config.sites.grays.skipCategories,
  timesFromLotPage: true, // search cards show no close time
  quickHtml: true,        // the lot page's plain HTML carries the bid, bids and reserve: no browser needed
  // "Opens: 22 October 18:00 AEDT"  "Closes: (27 October 20:00 AEDT)" or a countdown "Closes: 6d 13h 52m"
  pageFacts: text => {
    const out = {};
    const t = String(text || '').replace(/\s+/g, ' ');
    const closes = /closes:?\s*\(?\s*(\d{1,2}\s+[A-Za-z]+\.?\s+(?:\d{4}\s+)?\d{1,2}[:.]\d{2}\s*(?:am|pm)?\s*(?:AEDT|AEST|ACDT|ACST|AWST)?)/i.exec(t);
    if (closes) out.end_at = parseDayMonthTime(closes[1]);
    const opens = /opens:?\s*\(?\s*(\d{1,2}\s+[A-Za-z]+\.?\s+(?:\d{4}\s+)?\d{1,2}[:.]\d{2}\s*(?:am|pm)?\s*(?:AEDT|AEST|ACDT|ACST|AWST)?)/i.exec(t);
    if (opens) out.opens_at = parseDayMonthTime(opens[1]);
    // "Location 140 National Drive Dandenong South VIC 3125" -> Dandenong South, VIC
    const loc = /\blocation:?\s+(.{2,120}?\s+(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b)/i.exec(t);
    const pl = loc && placeFromAddress(loc[1]);
    if (pl) Object.assign(out, pl);
    // Buyer's premium table: "ANY 20%", or bands ("$0 - $5,500 25%", "$5,501 - $27,500 16.5%", "$44,001+ 9%")
    const tiers = premiumTiers(t);
    if (tiers && /^\*:(\d+(?:\.\d+)?)%$/.test(tiers)) out.buyer_premium = parseFloat(tiers.slice(2));
    else if (tiers) out.premium_tiers = tiers;
    for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
    return out;
  },
});

export const slattery = makeSite({
  site: 'slattery', label: 'Slattery', origin: 'https://slatteryauctions.com.au',
  auctionsFrom: config.sites.slattery.auctionsFrom,
  auctionRe: /slatteryauctions\.com\.au\/auctions\/\d+\/?(?:[?#]|$)/i,
  skipFilter: 'EOI|expression of interest|aircraft|real estate|property',
  maxAuctions: config.sites.slattery.maxAuctions,
  // Lot links weren't visible without a browser; accept the usual shapes under the site.
  detailRe: /slatteryauctions\.com\.au\/(?:lots?|listings?|products?|items?|assets?|auctions\/\d+\/(?:lots?|listings?|items?|products?))\/[^?#]*?\d{3,}/i,
  idFromUrl: lastNum, scrolls: 6,
});

export const auctionbarn = makeSite({
  site: 'auctionbarn', label: 'The Auction Barn', origin: 'https://bidding.theauctionbarn.com.au',
  auctionsFrom: config.sites.auctionbarn.auctionsFrom,
  auctionRe: /bidding\.theauctionbarn\.com\.au\/auction-items\/\d+/i,
  maxAuctions: config.sites.auctionbarn.maxAuctions,
  // https://bidding.theauctionbarn.com.au/lot-details/2565/689061
  detailRe: /bidding\.theauctionbarn\.com\.au\/lot-details\/\d+\/\d+/i,
  idFromUrl: u => (/\/lot-details\/\d+\/(\d+)/i.exec(u || '') || [])[1] || null,
  scrolls: 6,
});
