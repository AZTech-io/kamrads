import { config } from './config.js';
import { log } from './log.js';
import * as settings from './settings.js';

/** Push to the director's phone via ntfy (free app for iOS/Android). */
export async function push({ title, message, url, priority = 'high', tags = 'rotating_light' }) {
  log.info('alert', `${title} — ${message}`);
  const ntfyUrl = settings.get('ntfyUrl');
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
