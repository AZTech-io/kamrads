// Best-effort generic login: find the email + password fields, submit, then keep the cookies.
// If a site's login can't be automated (captcha, SSO quirks), use scripts/import-cookies.js instead.
import { getContext, persist, debugSnapshot } from './browser.js';
import { q } from './db.js';
import { log } from './log.js';
import { config } from './config.js';

// Only an explicit log-out link proves a session: menus show "My Pickles" etc. to guests too.
const LOGGED_IN = /\b(log\s?out|sign\s?out)\b/i;

async function isLoggedIn(page) {
  return page.evaluate(inSrc => {
    const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const all = [...document.querySelectorAll('a, button')];
    const text = e => (e.innerText || e.textContent || '').trim();
    // Only a visible log-out / sign-out control proves a session.
    return all.filter(visible).some(e => new RegExp(inSrc, 'i').test(text(e)));
  }, LOGGED_IN.source);
}
const EMAIL_SEL = 'input[type="email"], input[autocomplete="username"], input[name*="email" i], input[id*="email" i], input[name*="user" i], input[id*="user" i]';
const PASS_SEL = 'input[type="password"]';

async function firstVisible(page, sel) {
  for (const el of await page.$$(sel)) if (await el.isVisible().catch(() => false)) return el;
  return null;
}

export async function ensureLogin(site, startUrl) {
  const creds = config.sites[site];
  const ctx = await getContext(site);
  const page = await ctx.newPage();
  page.setDefaultTimeout(config.pageTimeoutMs);
  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    if (await isLoggedIn(page)) {
      q.statusLogin.run(site, 1);
      log.info(site, 'already logged in (saved session)');
      return true;
    }
    if (!creds.email || !creds.password) {
      q.statusLogin.run(site, 0);
      log.warn(site, 'no login details set - continuing as a guest (live bids may be hidden)');
      return false;
    }
    if (!(await firstVisible(page, PASS_SEL))) {
      const opener = page.locator('a, button').filter({ hasText: /^\s*(log\s?in|sign\s?in|login\s*\/\s*sign\s?up|sign\s?up\s*\/\s*log\s?in)\s*$/i }).first();
      if (await opener.count()) {
        await opener.click().catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }
    }
    const email = await firstVisible(page, EMAIL_SEL);
    if (!email) throw new Error('could not find the email field');
    await email.fill(creds.email);
    let pass = await firstVisible(page, PASS_SEL);
    if (!pass) { // two-step forms: email first, then password
      await email.press('Enter');
      await page.waitForTimeout(3000);
      pass = await firstVisible(page, PASS_SEL);
    }
    if (!pass) throw new Error('could not find the password field');
    await pass.fill(creds.password);
    await pass.press('Enter');
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const stillForm = await firstVisible(page, PASS_SEL);
    if (stillForm || !(await isLoggedIn(page))) throw new Error('login form still showing - wrong password, captcha or 2FA?');
    await persist(site);
    q.statusLogin.run(site, 1);
    log.info(site, 'logged in and session saved');
    return true;
  } catch (e) {
    const snap = await debugSnapshot(site, 'login', page);
    q.statusLogin.run(site, 0);
    log.warn(site, `login failed: ${e.message} (screenshot: ${snap}.png)`);
    return false;
  } finally {
    await page.close().catch(() => {});
  }
}
