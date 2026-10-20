// Test the automatic login on its own: npm run login -- pickles
import { ensureLogin } from '../src/login.js';
import { closeBrowser } from '../src/browser.js';
import * as pickles from '../src/sites/pickles.js';
import * as manheim from '../src/sites/manheim.js';

const sites = { pickles, manheim };
const name = process.argv[2];
if (!sites[name]) { console.log('Usage: npm run login -- <pickles|manheim>'); process.exit(1); }
const ok = await ensureLogin(name, sites[name].loginUrl);
console.log(ok ? 'Logged in - session saved.' : 'Not logged in - see the message above (screenshot saved in data/debug).');
await closeBrowser();
process.exit(ok ? 0 : 1);
