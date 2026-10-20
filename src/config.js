// All settings come from environment variables (see .env.example).
const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);
const bool = (k, d) => (env[k] === undefined || env[k] === '' ? d : /^(1|true|yes|on)$/i.test(env[k]));
const list = (k, d) => (env[k] ? env[k].split('|').map(s => s.trim()).filter(Boolean) : d);

export const config = {
  dataDir: env.DATA_DIR || './data',
  port: num('PORT', 8787),
  host: env.HOST || '0.0.0.0',
  dashUser: env.DASH_USER || 'admin',
  dashPass: env.DASH_PASS || '',
  // Extra logins, each with their own watchlist, bids and alerts: DASH_USERS=matthew:secret,sam:pass2
  users: (() => {
    const out = {};
    if (env.DASH_PASS) out[(env.DASH_USER || 'admin').toLowerCase()] = env.DASH_PASS;
    for (const pair of (env.DASH_USERS || '').split(',')) {
      const i = pair.indexOf(':');
      if (i > 0) out[pair.slice(0, i).trim().toLowerCase()] = pair.slice(i + 1).trim();
    }
    return out;
  })(),

  backupKeep: num('BACKUP_KEEP', 14),
  photoCacheMb: num('PHOTO_CACHE_MB', 400),   // lot thumbnails cached on the server          // daily database copies kept in data/backups

  // Where you are: distance filter, transport estimates. "Name:lat,lon|Name:lat,lon"
  homeBases: (env.HOME_BASES || 'Karnup WA:-32.369,115.857|Canberra ACT:-35.281,149.129').split('|').map(p => {
    const [name, ll] = p.split(':'); const [lat, lon] = String(ll || '').split(',').map(Number);
    return { name: name.trim(), lat, lon };
  }).filter(b => b.name && Number.isFinite(b.lat) && Number.isFinite(b.lon)),
  geocode: bool('GEOCODE', true),               // look suburbs up on OpenStreetMap (cached)
  transport: {
    pickupKm: num('TRANSPORT_PICKUP_KM', 80),     // closer than this: you collect it yourself, $0
    vehicleBase: num('TRANSPORT_VEHICLE_BASE', 250),
    vehiclePerKm: num('TRANSPORT_VEHICLE_PER_KM', 0.35),  // ~Perth-Sydney car carrier $1.6k
    heavyFactor: num('TRANSPORT_HEAVY_FACTOR', 2.2),       // trucks, machinery, trailers
    goodsBase: num('TRANSPORT_GOODS_BASE', 60),
    goodsPerKm: num('TRANSPORT_GOODS_PER_KM', 0.08),       // ~a pallet Perth-Sydney $370
  },
  // Buyer's fees by site. A lot's own "Buyer's Premium x%" (read from its page) wins over these.
  fees: {
    // vehicles: flat fee by price band; general goods: a percentage
    // Pickles: one schedule per product line (pickles.com.au/fees). Tiers are "up to $:fee", fee is $ or %.
    pickles: { lines: {
      cars: { tiers: env.PICKLES_FEES_CARS || env.PICKLES_FEES || '1000:110,5000:275,15000:440,*:660', processing: num('PICKLES_PROCESSING', 0) },
      salvage: { tiers: env.PICKLES_FEES_SALVAGE || env.PICKLES_FEES || '1000:110,5000:275,15000:440,*:660', processing: num('PICKLES_PROCESSING', 0) },
      industrial: { tiers: env.PICKLES_FEES_INDUSTRIAL || '*:10%', processing: num('PICKLES_PROCESSING', 0) },
      general: { tiers: env.PICKLES_FEES_GENERAL || '*:16.5%', processing: num('PICKLES_PROCESSING', 0) },
    } },
    manheim: { tiers: env.MANHEIM_FEES || '1000:110,5000:275,15000:440,*:660', goodsPct: num('MANHEIM_GOODS_PREMIUM', 16.5) },
    allbids: { premiumPct: num('ALLBIDS_PREMIUM', 15) },
    lloyds: { premiumPct: num('LLOYDS_PREMIUM', 16.5) },
    // Grays vehicles: from their lot pages (Oct 2026); other goods vary by lot
    grays: { tiers: env.GRAYS_FEES || '2000:495,5000:650,10000:710,30000:7%,40000:6%,*:5%', goodsPct: num('GRAYS_GOODS_PREMIUM', 16.5) },
    slattery: { premiumPct: num('SLATTERY_PREMIUM', 12) },
    auctionbarn: { premiumPct: num('AUCTIONBARN_PREMIUM', 16.5) },
  },

  // Morning digest push (each person can change hour / time zone in Settings)
  digestHour: num('DIGEST_HOUR', 7),
  digestTz: env.DIGEST_TZ || 'Australia/Sydney',

  // Browser
  proxy: env.PROXY_URL || '',              // e.g. http://user:pass@au.proxy.example:8000 (only if blocked)
  maxOpenPages: num('MAX_OPEN_PAGES', 1),  // tabs for the regular scan
  hotPages: num('HOT_PAGES', 1),           // tabs for closing-soon re-checks (separate, so the scan never stalls)
  pageTimeoutMs: num('PAGE_TIMEOUT_MS', 45000),
  browserRecycleMin: num('BROWSER_RECYCLE_MIN', 180),
  headless: bool('HEADLESS', true),
  chromePath: env.CHROME_PATH || '',        // only needed if not using the bundled Playwright Chromium

  // Polling
  discoveryEveryMin: num('DISCOVERY_EVERY_MIN', 10),
  hotEverySec: num('HOT_EVERY_SEC', 30),
  watchEverySec: num('WATCH_EVERY_SEC', 60),   // your watchlist is re-checked this often until it closes
  hotWindowMin: num('HOT_WINDOW_MIN', 15),
  finalWindowMin: num('FINAL_WINDOW_MIN', 3),  // last N minutes of a lot...
  finalEverySec: num('FINAL_EVERY_SEC', 10),   // ...are re-read this often (fast feed / watchlist)     // lots closing within this get re-checked every HOT_EVERY_SEC
  warmWindowMin: num('WARM_WINDOW_MIN', 60),   // lots closing within this get re-checked every WARM_EVERY_MIN
  warmEveryMin: num('WARM_EVERY_MIN', 5),
  hotBatch: num('HOT_BATCH', 4),
  fillTimesPerScan: num('FILL_TIMES_PER_SCAN', 40),  // lot pages read per scan where lists show no close time (Grays)
  fastBatch: num('FAST_BATCH', 80),          // max fast-feed reads per cycle (each ~0.3 s)               // max detail pages per hot cycle
  hotMaxBid: num('HOT_MAX_BID', 25000),        // don't waste browser time on lots already above this

  // Alerts
  alertMinutes: num('ALERT_MINUTES', 10),
  sleeperRatio: num('SLEEPER_RATIO', 0.25),
  cheapVehicleMax: num('CHEAP_VEHICLE_MAX', 3000),
  pennyMax: num('PENNY_MAX', 5),
  pennyGeneral: bool('PENNY_GENERAL', false),  // penny alerts for general goods (paint, household...) too
  includeStatutory: bool('INCLUDE_STATUTORY', false),
  ntfyUrl: env.NTFY_URL || '',                 // e.g. https://ntfy.sh/katara-auctions-8f3k2
  ntfyToken: env.NTFY_TOKEN || '',
  dashboardPublicUrl: env.DASHBOARD_URL || '',

  // AI resale estimate (optional)
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  anthropicModel: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',   // market research with web search
  researchPerDay: num('RESEARCH_PER_DAY', 60),                  // cap on automatic lookups (each ~5-10c)
  researchWithinHours: num('RESEARCH_WITHIN_HOURS', 6),         // auto-research lots closing within this
  researchMinBid: num('RESEARCH_MIN_BID', 50),                  // skip junk lots below this (vehicles always qualify)
  estimatesPerHour: num('ESTIMATES_PER_HOUR', 60),
  estimateWithinHours: num('ESTIMATE_WITHIN_HOURS', 24),

  // Freight board (/freight): Airtasker + Truckit job lists
  freight: {
    everyMin: num('FREIGHT_EVERY_MIN', 10),
    keepHours: num('FREIGHT_KEEP_HOURS', 36),   // a job that drops off the lists this long is treated as taken
    airtasker: {
      enabled: bool('AIRTASKER_ENABLED', true),
      categories: list('AIRTASKER_CATEGORIES', ['delivery', 'removals', 'courier-services', 'man-with-a-van', 'ute-removals']),
      cities: list('AIRTASKER_CITIES', ['canberra', 'sydney']),
    },
    truckit: {
      enabled: bool('TRUCKIT_ENABLED', true),
      pages: list('TRUCKIT_PAGES', ['https://www.truckit.net/search-for-jobs']),
      maxPages: num('TRUCKIT_MAX_PAGES', 5),
    },
  },

  sites: {
    pickles: {
      enabled: bool('PICKLES_ENABLED', true),
      email: env.PICKLES_EMAIL || '',
      password: env.PICKLES_PASSWORD || '',
      maxPages: num('PICKLES_MAX_PAGES', 3),
      pageSize: num('PICKLES_PAGE_SIZE', 120),
      searches: list('PICKLES_SEARCHES', [
        // Online (timed) salvage items - cars, trucks, everything
        'https://www.pickles.com.au/used/search/items?filter=and%255B0%255D%255Bor%255D%255B0%255D%255BbuyMethod%255D%3DPickles%2520Online%26and%255B1%255D%255Bor%255D%255B0%255D%255Bsalvage%255D%3DSalvage&contentkey=online-salvage',
        // All salvage cars (includes Pickles Live lanes)
        'https://www.pickles.com.au/used/search/cars?contentkey=salvage-cars&filter=and%255B0%255D%255Bor%255D%255B0%255D%255Bsalvage%255D%3DSalvage',
        // Non-salvage cars sold online
        'https://www.pickles.com.au/used/search/cars?filter=and%255B0%255D%255Bor%255D%255B0%255D%255BbuyMethod%255D%3DPickles%2520Online&contentkey=all-cars',
        // Trucks (the Isuzu NPR type of lot)
        'https://www.pickles.com.au/used/search/trucks?contentkey=trucks',
      ]),
    },
    allbids: {
      enabled: bool('ALLBIDS_ENABLED', true),
      scrolls: num('ALLBIDS_SCROLLS', 25),
      pages: list('ALLBIDS_PAGES', [
        'https://www.allbids.com.au/closing-today',                                  // everything closing today, all categories
        'https://www.carbids.com.au/c/allbids-car-auctions/motor-vehicles-cars',     // cars (close on weekdays)
        'https://www.allbids.com.au/c/trucks-trailers',
      ]),
    },
    lloyds: {
      enabled: bool('LLOYDS_ENABLED', true),
      maxAuctions: num('LLOYDS_MAX_AUCTIONS', 20),     // soonest-closing auctions scanned each pass
      withinHours: num('LLOYDS_WITHIN_HOURS', 72),
      maxPages: num('LLOYDS_MAX_PAGES', 8),
      pageSize: num('LLOYDS_PAGE_SIZE', 100),
      // Auctions whose name matches this are skipped (regex): property tenders etc.
      skipFilter: env.LLOYDS_SKIP || 'real estate|hectares?|acres?|property|land for sale|house and land|tender',
    },
    grays: {
      enabled: bool('GRAYS_ENABLED', true),
      listings: list('GRAYS_LISTINGS', ['https://www.grays.com/search/automotive-trucks-and-marine']),
      maxPages: num('GRAYS_MAX_PAGES', 5),
    },
    slattery: {
      enabled: bool('SLATTERY_ENABLED', true),
      auctionsFrom: env.SLATTERY_AUCTIONS || 'https://slatteryauctions.com.au/auctions?categoryGroups=Motor%20Vehicles',
      maxAuctions: num('SLATTERY_MAX_AUCTIONS', 12),
    },
    auctionbarn: {
      enabled: bool('AUCTIONBARN_ENABLED', true),
      auctionsFrom: env.AUCTIONBARN_AUCTIONS || 'https://theauctionbarn.com.au/upcoming-auctions',
      maxAuctions: num('AUCTIONBARN_MAX_AUCTIONS', 8),
    },
    manheim: {
      enabled: bool('MANHEIM_ENABLED', true),
      email: env.MANHEIM_EMAIL || '',
      password: env.MANHEIM_PASSWORD || '',
      home: env.MANHEIM_HOME || 'https://www.manheim.com.au/',
      proxy: env.MANHEIM_PROXY_URL || '',   // Australian proxy for Manheim only (it blocks US servers)
      // Only events whose name matches this are scanned (regex, case-insensitive)
      eventFilter: env.MANHEIM_EVENT_FILTER || 'statutory|damage|bidnow|clearing|government|fleet|motorcyc|transport|general goods',
      maxEvents: num('MANHEIM_MAX_EVENTS', 12),
      scrolls: num('MANHEIM_SCROLLS', 6),
    },
  },
};
