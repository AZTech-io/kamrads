import { startServer } from './server.js';
import { startScheduler, stop } from './scheduler.js';
import { closeBrowser } from './browser.js';
import { log } from './log.js';

startServer();
startScheduler().catch(e => log.error('main', e.stack || e.message));

const shutdown = async sig => {
  log.info('main', `${sig} - shutting down`);
  stop();
  await closeBrowser();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', e => log.error('main', `unhandled: ${e?.stack || e}`));
