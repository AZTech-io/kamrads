// One shared headless Chromium, one cookie context per site, at most MAX_OPEN_PAGES tabs at a time.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './log.js';

let browser = null;
let startedAt = 0;
const contexts = new Map();
// Two lanes so neither starves the other: 'hot' re-checks closing lots, 'bg' does the regular scan.
const lanes = { hot: { active: 0, waiters: [] }, bg: { active: 0, waiters: [] } };
const busy = () => lanes.hot.active + lanes.bg.active;

const statePath = site => path.join(config.dataDir, `state-${site}.json`);
export const debugDir = path.join(config.dataDir, 'debug');
fs.mkdirSync(debugDir, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

let launching = null;
async function getBrowser() {
  if (launching) return launching;
  launching = launchBrowser().finally(() => { launching = null; });
  return launching;
}

async function launchBrowser() {
  const tooOld = browser && Date.now() - startedAt > config.browserRecycleMin * 60000 && busy() === 0;
  if (tooOld) await closeBrowser();
  if (browser?.isConnected()) return browser;
  const launch = {
    headless: config.headless,
    executablePath: config.chromePath || undefined,
    args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu', '--no-zygote', '--disable-extensions',
      '--disable-background-networking', '--mute-audio', '--js-flags=--max-old-space-size=384'],
  };
  if (config.proxy) {
    const u = new URL(config.proxy);
    launch.proxy = { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(u.username) || undefined, password: decodeURIComponent(u.password) || undefined };
  }
  browser = await chromium.launch(launch);
  startedAt = Date.now();
  contexts.clear();
  log.info('browser', 'Chromium started');
  return browser;
}

export async function closeBrowser() {
  for (const [site, p] of contexts) { await p.then(ctx => saveState(site, ctx)).catch(() => {}); }
  contexts.clear();
  if (browser) await browser.close().catch(() => {});
  browser = null;
}

async function saveState(site, ctx) {
  const state = await ctx.storageState();
  fs.writeFileSync(statePath(site), JSON.stringify(state));
}

export async function getContext(site) {
  const b = await getBrowser();
  if (!contexts.has(site)) contexts.set(site, makeContext(b, site).catch(e => { contexts.delete(site); throw e; }));
  return contexts.get(site);
}

async function makeContext(b, site) {
  const opts = { userAgent: UA, locale: 'en-AU', timezoneId: 'Australia/Sydney', viewport: { width: 1366, height: 900 } };
  if (fs.existsSync(statePath(site))) opts.storageState = statePath(site);
  const ctx = await b.newContext(opts);
  // Save RAM and bandwidth: skip images, fonts, video and trackers.
  await ctx.route('**/*', route => {
    const r = route.request();
    const t = r.resourceType();
    const u = r.url();
    if (['image', 'media', 'font'].includes(t)) return route.abort();
    if (/google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|clarity\.ms|newrelic|nr-data|segment\.io|tiktok|bing\.com\/bat/.test(u)) return route.abort();
    return route.continue();
  });
  return ctx;
}

export async function persist(site) {
  const ctx = await contexts.get(site);
  if (ctx) await saveState(site, ctx).catch(e => log.warn('browser', `save state ${site}: ${e.message}`));
}

async function acquire(lane) {
  const l = lanes[lane];
  const cap = lane === 'hot' ? config.hotPages : config.maxOpenPages;
  if (l.active < cap && l.waiters.length === 0) { l.active++; return; }
  await new Promise(res => l.waiters.push(res));
  l.active++;
}
function release(lane) { const l = lanes[lane]; l.active--; const next = l.waiters.shift(); if (next) next(); }

/**
 * Open a URL, capture every JSON response the page loads, run `fn(page)` and close the tab.
 * Returns { json: [{url, body}], html, text, finalUrl, result }.
 */
export async function withPage(site, url, fn = null, { scrolls = 0, waitMs = 2500, high = false } = {}) {
  const lane = high ? 'hot' : 'bg';
  await acquire(lane);
  let page;
  try {
    const ctx = await getContext(site);
    page = await ctx.newPage();
    page.setDefaultTimeout(config.pageTimeoutMs);
    const json = [];
    page.on('response', async res => {
      try {
        const ct = res.headers()['content-type'] || '';
        const u = res.url();
        if (!/json|javascript\+json|graphql/.test(ct) && !/\/api\/|graphql|\.json(\?|$)/.test(u)) return;
        if (res.request().resourceType() === 'script') return;
        const body = await res.json().catch(() => null);
        if (body && typeof body === 'object') json.push({ url: u, body });
      } catch { /* response gone */ }
    });
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.pageTimeoutMs });
    const status = resp?.status() ?? 0;
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    for (let i = 0; i < scrolls; i++) {
      await page.mouse.wheel(0, 2500);
      await page.waitForTimeout(900);
    }
    await page.waitForTimeout(waitMs);
    const result = fn ? await fn(page) : null;
    const html = await page.content();
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    return { status, json, html, text, finalUrl: page.url(), result };
  } finally {
    if (page) await page.close().catch(() => {});
    release(lane);
  }
}

/** Save a screenshot + HTML for debugging a failed page. */
export async function debugSnapshot(site, name, page) {
  const base = path.join(debugDir, `${site}-${name}-${Date.now()}`);
  await page.screenshot({ path: base + '.png', fullPage: false }).catch(() => {});
  fs.writeFileSync(base + '.html', await page.content().catch(() => ''));
  return base;
}

export function looksBlocked(r) {
  return r.status === 403 || r.status === 429 ||
    /access denied|request blocked|unusual traffic|are you a robot|captcha|attention required|incapsula|perimeterx|px-captcha|cf-chl/i.test(r.text?.slice(0, 4000) || '');
}
