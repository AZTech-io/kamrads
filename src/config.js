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
  hotWindowMin: num('HOT_WINDOW_MIN', 15),     // lots closing within this get re-checked every HOT_EVERY_SEC
  warmWindowMin: num('WARM_WINDOW_MIN', 60),   // lots closing within this get re-checked every WARM_EVERY_MIN
  warmEveryMin: num('WARM_EVERY_MIN', 5),
  hotBatch: num('HOT_BATCH', 4),               // max detail pages per hot cycle
  hotMaxBid: num('HOT_MAX_BID', 25000),        // don't waste browser time on lots already above this

  // Alerts
  alertMinutes: num('ALERT_MINUTES', 10),
  sleeperRatio: num('SLEEPER_RATIO', 0.25),
  cheapVehicleMax: num('CHEAP_VEHICLE_MAX', 3000),
  pennyMax: num('PENNY_MAX', 5),
  includeStatutory: bool('INCLUDE_STATUTORY', false),
  ntfyUrl: env.NTFY_URL || '',                 // e.g. https://ntfy.sh/katara-auctions-8f3k2
  ntfyToken: env.NTFY_TOKEN || '',
  dashboardPublicUrl: env.DASHBOARD_URL || '',

  // AI resale estimate (optional)
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  anthropicModel: env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
  estimatesPerHour: num('ESTIMATES_PER_HOUR', 60),
  estimateWithinHours: num('ESTIMATE_WITHIN_HOURS', 24),

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
    manheim: {
      enabled: bool('MANHEIM_ENABLED', true),
      email: env.MANHEIM_EMAIL || '',
      password: env.MANHEIM_PASSWORD || '',
      home: env.MANHEIM_HOME || 'https://www.manheim.com.au/',
      // Only events whose name matches this are scanned (regex, case-insensitive)
      eventFilter: env.MANHEIM_EVENT_FILTER || 'statutory|damage|bidnow|clearing|government|fleet|motorcyc|transport|general goods',
      maxEvents: num('MANHEIM_MAX_EVENTS', 12),
      scrolls: num('MANHEIM_SCROLLS', 6),
    },
  },
};
