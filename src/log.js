const ts = () => new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney', hour12: false });
const out = (lvl, tag, msg) => console.log(`${ts()} ${lvl} [${tag}] ${msg}`);
export const log = {
  info: (tag, msg) => out('INFO', tag, msg),
  warn: (tag, msg) => out('WARN', tag, msg),
  error: (tag, msg) => out('ERR ', tag, msg),
};
