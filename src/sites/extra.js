// Sites built from the generic adapter. If one stops finding lots, its link pattern here is the
// first thing to check (npm run probe -- <a lot url> shows what the page returns).
import { makeSite } from './generic.js';
import { config } from '../config.js';

const lastNum = u => { const m = String(u || '').split(/[?#]/)[0].match(/\d{3,}/g); return m ? m[m.length - 1] : null; };

export const grays = makeSite({
  site: 'grays', label: 'Grays', origin: 'https://www.grays.com',
  // https://www.grays.com/lot/0007-23502659/motor-vehicles-motor-cycles/2016-hyundai-accent-active-petrol
  detailRe: /grays\.com\/lot\/\d{2,6}-\d{5,}(?:[/?#]|$)/i,
  idFromUrl: u => (/\/lot\/(\d{2,6}-\d{5,})/i.exec(u || '') || [])[1] || null,
  listings: config.sites.grays.listings, pageParam: 'page', maxPages: config.sites.grays.maxPages, scrolls: 4,
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
