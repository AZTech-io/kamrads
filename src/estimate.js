// Optional AI resale estimate via the Claude API. Without ANTHROPIC_API_KEY the monitor still
// works: you set an estimate per lot on the dashboard, and cheap vehicles still alert at T-10.
import { config } from './config.js';
import { q } from './db.js';
import { log } from './log.js';
import { isVehicle } from './extract.js';

let budget = { hour: 0, used: 0 };

export async function estimatePending() {
  if (!config.anthropicKey) return;
  const hour = Math.floor(Date.now() / 3600000);
  if (budget.hour !== hour) budget = { hour, used: 0 };
  const left = config.estimatesPerHour - budget.used;
  if (left <= 0) return;
  const now = Date.now();
  const rows = q.needsEstimate.all(now, now + config.estimateWithinHours * 3600000, Math.min(left, 10));
  for (const lot of rows) {
    if (!isVehicle(lot) && (lot.bid ?? 0) > 2000) { q.setEstimate.run(null, null, 'skipped', now, lot.key); continue; }
    budget.used++;
    try {
      const e = await ask(lot);
      q.setEstimate.run(e.low, e.high, e.note, Date.now(), lot.key);
    } catch (err) {
      log.warn('estimate', `${lot.key}: ${err.message}`);
      q.setEstimate.run(null, null, `error: ${err.message}`.slice(0, 200), Date.now(), lot.key);
    }
  }
}

async function ask(lot) {
  const facts = {
    title: lot.title, year: lot.year, make: lot.make, model: lot.model, odometer_km: lot.odometer,
    wovr_status: lot.wovr, location: [lot.location, lot.state].filter(Boolean).join(' '),
    category: lot.category, auction: lot.site, sale: lot.sale_name,
  };
  const body = {
    model: config.anthropicModel,
    max_tokens: 300,
    system: 'You value used goods for an Australian buyer who resells auction purchases. Reply with JSON only.',
    messages: [{
      role: 'user',
      content: `Estimate the realistic Australian private-sale resale value (AUD) of this auction lot in its described state, `
        + `ignoring the current bid. A statutory write-off can never be re-registered: value it as parts only. `
        + `A repairable write-off must pass inspection before registration. If you cannot tell, give a wide range and low confidence.\n\n`
        + JSON.stringify(facts)
        + `\n\nReply exactly as {"low": number, "high": number, "confidence": "low"|"medium"|"high", "note": "max 12 words"}`,
    }],
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Claude API HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  const text = (data.content || []).map(c => c.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in reply');
  const j = JSON.parse(m[0]);
  const low = Number(j.low), high = Number(j.high);
  if (!Number.isFinite(low) || !Number.isFinite(high)) throw new Error('bad numbers');
  return { low, high, note: `${j.confidence || '?'} · ${j.note || ''}`.slice(0, 120) };
}
