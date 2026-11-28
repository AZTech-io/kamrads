// Sends Garage reminders (rego, insurance, service, battery...) to each owner's phone.
import { push } from '../notify.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { remindersDue } from './store.js';

export async function garageTick(now = Date.now()) {
  const base = config.dashboardPublicUrl ? config.dashboardPublicUrl.replace(/\/+$/, '') : '';
  for (const r of remindersDue(now)) {
    await push({ to: r.to, title: r.title, message: r.message, priority: r.priority, tags: r.priority === 'high' ? 'warning,wrench' : 'wrench',
      url: base ? `${base}/garage#a${r.assetId}` : undefined }).catch(e => log.warn('garage', e.message));
  }
}
