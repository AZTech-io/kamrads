import { config } from './config.js';
import { log } from './log.js';
import * as settings from './settings.js';

/** Push to the director's phone via ntfy (free app for iOS/Android). */
export async function push({ title, message, url, priority = 'high', tags = 'rotating_light', to }) {
  log.info('alert', `${to ? '@' + to + ' ' : ''}${title} — ${message}`);
  // Personal alerts (outbid, your saved searches) go to that person's own link if they set one,
  // otherwise to the shared link with their name on it.
  const own = to ? settings.getUser(to, 'ntfyUrl') : null;
  const ntfyUrl = own || settings.get('ntfyUrl');
  if (to && !own) title = `[${to}] ${title}`;
  if (!ntfyUrl) return false;
  const headers = { Title: encodeHeader(title), Priority: priority, Tags: tags };
  if (url) headers.Click = url;
  if (config.dashboardPublicUrl) headers.Actions = `view, Dashboard, ${config.dashboardPublicUrl}`;
  if (config.ntfyToken) headers.Authorization = `Bearer ${config.ntfyToken}`;
  try {
    const res = await fetch(ntfyUrl, { method: 'POST', headers, body: message, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (e) {
    log.warn('alert', `push failed: ${e.message}`);
    return false;
  }
}

// HTTP headers must be latin-1; ntfy accepts RFC 2047 encoded words for anything else.
const encodeHeader = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
