// Garage: own vehicles / jet skis / beacons. Each login sees only their own, admins see everyone's;
// logging a service rolls the next one on; reminders go out once per stage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kamrads-garage-'));
process.env.DASH_USER = 'aaron'; process.env.DASH_PASS = 'a'; process.env.DASH_USERS = 'matthew:m,sam:s';
process.env.PORT = '18793'; process.env.HOST = '127.0.0.1';
process.env.DIGEST_TZ = 'Australia/Perth';

const g = await import('../src/garage/store.js');
const { startServer } = await import('../src/server.js');
startServer();
await new Promise(r => setTimeout(r, 300));
const H = (u, type = 'application/json') => ({ authorization: 'Basic ' + Buffer.from(u).toString('base64'), 'content-type': type });
const api = async (m, p, body, who = 'aaron:a') => {
  const r = await fetch('http://127.0.0.1:18793' + p, { method: m, headers: H(who), body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* page */ }
  return { status: r.status, json, text };
};
const today = g.todayIn('Australia/Perth');

test('dates: months roll over month ends, days between', () => {
  assert.equal(g.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(g.addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(g.addMonths('2026-11-28', 12), '2027-11-28');
  assert.equal(g.addMonths('2026-11-28', -12), '2025-11-28');
  assert.equal(g.daysBetween('2026-11-28', '2026-12-05'), 7);
  assert.equal(g.daysBetween('2026-12-05', '2026-11-28'), -7);
});

let ski;
test('add a jet ski: usual due items come with it, dates from the form', async () => {
  const r = await api('POST', '/api/garage/assets', { kind: 'jetski', name: 'Sea-Doo GTX', make: 'Sea-Doo', rego: 'wa123x', rego_state: 'wa', ident: 'ydv12345a919',
    meter: 'hours', meter_value: '87.4', kept_at: 'Storage locker', dues: { rego: g.addMonths(today, 2), battery: g.addMonths(today, -30) } });
  assert.equal(r.status, 200, r.text);
  ski = r.json.id;
  const a = (await api('GET', `/api/garage/assets/${ski}`)).json;
  assert.equal(a.rego, 'WA123X'); assert.equal(a.regoState, 'WA'); assert.equal(a.ident, 'YDV12345A919');
  assert.equal(a.meterValue, 87.4); assert.equal(a.meterDate, today); assert.equal(a.owner, 'aaron');
  assert.deepEqual(a.dues.map(d => d.kind).sort(), ['battery', 'insurance', 'rego', 'service']);
  const rego = a.dues.find(d => d.kind === 'rego');
  assert.equal(rego.dueDate, g.addMonths(today, 2)); assert.equal(rego.state, 'ok');
  const batt = a.dues.find(d => d.kind === 'battery');
  assert.equal(batt.lastDate, g.addMonths(today, -30), 'battery asks when it was fitted');
  assert.equal(batt.dueDate, g.addMonths(today, 6), '36 months after it was fitted');
  const svc = a.dues.find(d => d.kind === 'service');
  assert.equal(svc.state, 'unset'); assert.equal(svc.everyMeter, 100); assert.equal(svc.everyMonths, 12);
  assert.equal((await api('POST', '/api/garage/assets', { kind: 'jetski', name: ' ' })).status, 400);
  assert.equal((await api('POST', '/api/garage/assets', { kind: 'jetski', name: 'x', dues: { rego: 'soon' } })).status, 400);
});

test('logging a service rolls it on by months and hours; the hours reading updates', async () => {
  const on = today;
  const r = await api('POST', `/api/garage/assets/${ski}/logs`, { kind: 'service', date: on, meter: '90', cost: '$420', title: 'Oil, filter, plugs', done_by: 'Dealer' });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.dueId, 'matched the only Service item');
  let a = (await api('GET', `/api/garage/assets/${ski}`)).json;
  const svc = a.dues.find(d => d.kind === 'service');
  assert.equal(svc.dueDate, g.addMonths(on, 12)); assert.equal(svc.dueMeter, 190); assert.equal(svc.lastMeter, 90);
  assert.equal(a.meterValue, 90, 'same day as the one typed in: the service reading wins');
  assert.equal(a.logs[0].cost, 420); assert.equal(a.spent12, 420);
  // an older reading doesn't wind the hours back
  await api('POST', `/api/garage/assets/${ski}/logs`, { kind: 'reading', date: g.addMonths(today, -3), meter: 70 });
  a = (await api('GET', `/api/garage/assets/${ski}`)).json;
  assert.equal(a.meterValue, 90);
  // close to the hours: due soon
  await api('POST', `/api/garage/assets/${ski}/logs`, { kind: 'reading', date: today, meter: 183 });
  a = (await api('GET', `/api/garage/assets/${ski}`)).json;
  const s2 = a.dues.find(d => d.kind === 'service');
  assert.equal(a.meterValue, 183); assert.equal(s2.left, 7); assert.equal(s2.state, 'soon');
  // removing that reading goes back to the latest one left
  await api('DELETE', `/api/garage/logs/${a.logs.find(l => l.meter === 183).id}`);
  a = (await api('GET', `/api/garage/assets/${ski}`)).json;
  assert.equal(a.meterValue, 90);
});

test('rego paid early runs on from the old expiry, not the day paid', async () => {
  const a = (await api('GET', `/api/garage/assets/${ski}`)).json;
  const rego = a.dues.find(d => d.kind === 'rego');
  await api('POST', `/api/garage/assets/${ski}/logs`, { kind: 'rego', date: today, cost: 95, due_id: rego.id });
  const b = (await api('GET', `/api/garage/assets/${ski}`)).json;
  const r2 = b.dues.find(d => d.kind === 'rego');
  assert.equal(r2.dueDate, g.addMonths(rego.dueDate, 12)); assert.equal(r2.cost, 95);
  // a typed-in next date wins (what the new papers say)
  await api('POST', `/api/garage/assets/${ski}/logs`, { kind: 'rego', date: today, due_id: rego.id, next_date: '2028-03-01' });
  assert.equal((await api('GET', `/api/garage/assets/${ski}`)).json.dues.find(d => d.kind === 'rego').dueDate, '2028-03-01');
});

test('beacon battery has no repeat: done without a new expiry shows "not set"', async () => {
  const r = await api('POST', '/api/garage/assets', { kind: 'beacon', name: 'GME EPIRB', dues: { battery: g.addMonths(today, 2), registration: g.addMonths(today, 20) } });
  const a = (await api('GET', `/api/garage/assets/${r.json.id}`)).json;
  assert.equal(a.meter, null);
  const batt = a.dues.find(d => d.kind === 'battery');
  assert.equal(batt.dueDate, g.addMonths(today, 2), 'beacon battery asks for the expiry on the label');
  await api('POST', `/api/garage/assets/${r.json.id}/logs`, { kind: 'battery', due_id: batt.id });
  assert.equal((await api('GET', `/api/garage/assets/${r.json.id}`)).json.dues.find(d => d.kind === 'battery').state, 'unset');
  await api('POST', `/api/garage/assets/${r.json.id}/logs`, { kind: 'battery', due_id: batt.id, next_date: '2031-06-30' });
  assert.equal((await api('GET', `/api/garage/assets/${r.json.id}`)).json.dues.find(d => d.kind === 'battery').dueDate, '2031-06-30');
});

test('each login sees only their own; admins see everyone; only the main login picks admins', async () => {
  const m = await api('POST', '/api/garage/assets', { kind: 'motorbike', name: "Matty's bike", rego: '1abc234' }, 'matthew:m');
  assert.equal(m.status, 200);
  const mine = (await api('GET', '/api/garage', null, 'matthew:m')).json;
  assert.equal(mine.admin, false);
  assert.deepEqual(mine.assets.map(a => a.name), ["Matty's bike"]);
  assert.deepEqual(mine.users, ['matthew']);
  assert.equal((await api('GET', `/api/garage/assets/${ski}`, null, 'matthew:m')).status, 404);
  assert.equal((await api('PATCH', `/api/garage/assets/${ski}`, { name: 'mine now' }, 'matthew:m')).status, 404);
  assert.equal((await api('DELETE', `/api/garage/assets/${ski}`, null, 'matthew:m')).status, 404);
  assert.equal((await api('POST', `/api/garage/assets/${ski}/logs`, { kind: 'note' }, 'matthew:m')).status, 404);
  assert.equal((await api('GET', '/api/garage/admins', null, 'matthew:m')).status, 403);
  // a non-admin can't put things under someone else's login
  const sneaky = await api('POST', '/api/garage/assets', { kind: 'car', name: 'x', owner: 'aaron' }, 'matthew:m');
  assert.equal((await api('GET', `/api/garage/assets/${sneaky.json.id}`, null, 'matthew:m')).json.owner, 'matthew');
  await api('DELETE', `/api/garage/assets/${sneaky.json.id}`, null, 'matthew:m');
  // aaron (main) sees both
  const all = (await api('GET', '/api/garage')).json;
  assert.equal(all.admin, true); assert.ok(all.assets.some(a => a.owner === 'matthew'));
  // matthew can't make himself admin; aaron can
  assert.equal((await api('POST', '/api/garage/admins', { user: 'matthew', admin: true }, 'matthew:m')).status, 400);
  assert.equal((await api('POST', '/api/garage/admins', { user: 'matthew', admin: true })).status, 200);
  const now = (await api('GET', '/api/garage', null, 'matthew:m')).json;
  assert.equal(now.admin, true); assert.ok(now.assets.some(a => a.name === 'Sea-Doo GTX'));
  assert.equal((await api('GET', '/api/garage', null, 'sam:s')).json.assets.length, 0, 'sam still sees nothing');
  await api('POST', '/api/garage/admins', { user: 'matthew', admin: false });
  assert.equal((await api('GET', `/api/garage/assets/${ski}`, null, 'matthew:m')).status, 404);
  // an admin can file one under another login (Shay's car under aaron, made by matthew-as-admin, etc.)
  const shay = await api('POST', '/api/garage/assets', { kind: 'car', name: "Shay's car", owner: 'sam' });
  assert.equal((await api('GET', `/api/garage/assets/${shay.json.id}`, null, 'sam:s')).json.owner, 'sam');
  assert.equal((await api('GET', '/garage', null, 'sam:s')).status, 200);
  assert.equal((await fetch('http://127.0.0.1:18793/api/garage')).status, 401, 'login needed');
});

test('photos and PDFs: stored, served only to people who can see the item', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const up = await fetch(`http://127.0.0.1:18793/api/garage/assets/${ski}/files?name=rego%20papers.png`, { method: 'POST', headers: H('aaron:a', 'application/octet-stream'), body: png });
  const j = await up.json();
  assert.equal(up.status, 200, JSON.stringify(j));
  const a = (await api('GET', `/api/garage/assets/${ski}`)).json;
  assert.equal(a.files[0].name, 'rego papers.png'); assert.equal(a.photo, `/api/garage/files/${j.id}`, 'first photo becomes the main one');
  const got = await fetch(`http://127.0.0.1:18793/api/garage/files/${j.id}`, { headers: H('aaron:a') });
  assert.equal(got.status, 200); assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`http://127.0.0.1:18793/api/garage/files/${j.id}`, { headers: H('matthew:m') })).status, 404);
  const html = await fetch(`http://127.0.0.1:18793/api/garage/assets/${ski}/files?name=x.html`, { method: 'POST', headers: H('aaron:a', 'application/octet-stream'), body: '<script>alert(1)</script>' });
  assert.equal(html.status, 400, 'only photos and PDFs');
  const pdf = await fetch(`http://127.0.0.1:18793/api/garage/assets/${ski}/files?name=insurance.pdf`, { method: 'POST', headers: H('aaron:a', 'application/octet-stream'), body: Buffer.from('%PDF-1.4\n%fake\n') });
  assert.equal(pdf.status, 200);
  const stored = fs.readdirSync(g.FILE_DIR);
  assert.equal(stored.length, 2);
  await api('DELETE', `/api/garage/files/${j.id}`);
  assert.equal((await api('GET', `/api/garage/assets/${ski}`)).json.photo, null);
  assert.equal(fs.readdirSync(g.FILE_DIR).length, 1);
});

test('reminders: once per stage, to the owner, nothing for sold ones', async () => {
  const c = await api('POST', '/api/garage/assets', { kind: 'car', name: 'Perth ute', rego: 'ute1', dues: { rego: g.addMonths(today, 0) } });
  const id = c.json.id;
  const ins = (await api('GET', `/api/garage/assets/${id}`)).json.dues.find(d => d.kind === 'insurance');
  const in20 = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10) + 20)).toISOString().slice(0, 10);
  await api('PATCH', `/api/garage/dues/${ins.id}`, { due_date: in20, provider: 'RAC', ref: 'MOT123' });
  const first = g.remindersDue(Date.now(), { quiet: false }).filter(r => r.assetId === id);
  assert.deepEqual(first.map(r => r.stage).sort(), ['d0', 'd30']);
  const rego = first.find(r => r.stage === 'd0');
  assert.equal(rego.to, 'aaron'); assert.match(rego.title, /Perth ute: Rego due TODAY/); assert.match(rego.message, /Rego UTE1/);
  assert.match(first.find(r => r.stage === 'd30').message, /RAC · MOT123/);
  assert.equal(g.remindersDue(Date.now(), { quiet: false }).filter(r => r.assetId === id).length, 0, 'not again');
  // three weeks on: d7 for the insurance, weekly overdue nags for the rego
  const later = Date.now() + 15 * 86400000;
  const next = g.remindersDue(later, { quiet: false }).filter(r => r.assetId === id);
  assert.deepEqual(next.map(r => r.stage).sort(), ['d7', 'o2']);
  assert.match(next.find(r => r.stage === 'o2').title, /OVERDUE by 15 days/);
  // the ski is 7 hours off its service: hours reminder
  await api('POST', `/api/garage/assets/${ski}/logs`, { kind: 'reading', date: today, meter: 185 });
  const hrs = g.remindersDue(Date.now(), { quiet: false }).filter(r => r.assetId === ski);
  assert.ok(hrs.some(r => r.stage === 'msoon' && /Service due in 5 hrs/.test(r.title)), JSON.stringify(hrs));
  // sold: no more
  await api('PATCH', `/api/garage/assets/${id}`, { archived: true });
  assert.equal(g.remindersDue(Date.now() + 40 * 86400000, { quiet: false }).filter(r => r.assetId === id).length, 0);
  const list = (await api('GET', '/api/garage')).json;
  assert.ok(list.assets.find(a => a.id === id).archived);
  assert.ok(!list.coming.some(d => d.assetId === id), 'sold ones leave "coming up"');
});

test('delete takes the history and files with it', async () => {
  await api('DELETE', `/api/garage/assets/${ski}`);
  assert.equal((await api('GET', `/api/garage/assets/${ski}`)).status, 404);
  assert.equal(fs.readdirSync(g.FILE_DIR).length, 0);
  setTimeout(() => process.exit(0), 50);
});
