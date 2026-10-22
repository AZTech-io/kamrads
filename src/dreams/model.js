// What a listing is, read from its title / body text: Isuzu D-Max spec (drive, cab, generation, engine),
// Isuzu truck model code and weight class (NLR... FVL), body type (curtainsider, pantech, tipper...),
// and how damaged it is. Pure functions, no database.

// Isuzu truck codes: N series (NLR, NPR, NQR...), F series (FRR, FSR, FTR, FVR, FVL, FVZ, FXY...), Giga (CXY, EXY...)
const CODE_RE = /\b(n[hklmnpqr][rsd]|f[rstvxy][a-z]|g[vx][a-z]|c[xy][a-z]|ex[a-z])(?=\d|\s|-|\/|$)/i;
export const CLASSES = {
  n45: 'N Series 4.5t (NLR, NNR)',
  n75: 'N Series 7.5–8.7t (NPR, NPS, NQR)',
  f11: 'F Series 11–15t (FRR, FSR, FTR)',
  f16: 'F Series 16t+ (FVR, FVD, FVL, FVM)',
  f6x4: '6x4 & heavy (FVZ, FXY, FYJ, Giga)',
};
const CODE_CLASS = {
  nhr: 'n45', nkr: 'n45', nlr: 'n45', nls: 'n45', nnr: 'n45', nns: 'n45',
  npr: 'n75', nps: 'n75', nqr: 'n75', nrr: 'n75', nmr: 'n75',
  frr: 'f11', frd: 'f11', fsr: 'f11', fsd: 'f11', fss: 'f11', ftr: 'f11', fts: 'f11',
  fvr: 'f16', fvd: 'f16', fvl: 'f16', fvm: 'f16', fvy: 'f16',
};
const classOfCode = c => (c ? CODE_CLASS[c] || (/^(f[vxy]|g|c|e)/.test(c) ? 'f6x4' : null) : null);
const classOfGvm = g => (!g ? null : g <= 5000 ? 'n45' : g <= 9500 ? 'n75' : g <= 15500 ? 'f11' : g <= 19000 ? 'f16' : 'f6x4');

const BODIES = [
  ['curtainsider', /curtain|taut[\s-]?l?i?ner|tautiner/],
  ['refrigerated', /refrigerat|fridge|freezer|chiller/],
  ['pantech', /pantech|box\s?van|\bvan body/],
  ['tipper', /tipper/],
  ['tilt tray', /tilt\s?tray|car carrier|tilt\s?slide|beaver/],
  ['tray', /table\s?top|\btray|flat\s?top|drop\s?side|flat\s?deck/],
  ['service', /service\s?(?:truck|body)|workshop|\blube\b|tyre truck/],
  ['crane', /crane/],
  ['ewp', /elevated work|\bewp\b|boom lift|cherry picker/],
  ['bus', /\bbus\b|motorhome|camper/],
  ['special', /vacuum|tanker|water (?:truck|cart)|skip|hook\s?lift|garbage|compactor|agitator|tow truck|traffic|attenuator|horse|livestock|stock crate|borer|jinker/],
  ['ute', /\butility\b|\bute\b|pick-?up|style\s?side|tub\b/],
  ['cab chassis', /cab\s?chassis/],
];

/** Everything we can tell from a title (+ body / subtitle text). */
export function features(text) {
  const t = String(text || '').toLowerCase();
  const isuzu = /isuzu/.test(t);
  const dmax = isuzu && /d[\s-]?max\b/.test(t);
  const mux = isuzu && /mu[\s-]?x\b/.test(t);
  const after = isuzu ? t.slice(t.indexOf('isuzu') + 5) : t;
  const code = isuzu && !dmax && !mux ? (CODE_RE.exec(after) || [])[1]?.toLowerCase() || null : null;
  const series = code ? code[0] : isuzu && /\bn[\s-]?series\b/.test(after) ? 'n' : isuzu && /\bf[\s-]?series\b/.test(after) ? 'f' : null;
  const gvm = Number(((/\b(\d{1,2}),?(\d{3})\s*kg\b/.exec(t) || []).slice(1).join('')) || 0) || null;
  const cls = classOfCode(code) || (series ? classOfGvm(gvm) : null);
  const body = (BODIES.find(([, re]) => re.test(t)) || [])[0] || null;
  const truck = !dmax && !mux && (!!code || !!series || /\btrucks?\b|prime mover/.test(t));
  const drive = /4x4|4wd|dual range|four wheel drive|\b4x4\b/.test(t) ? '4x4' : /4x2|2wd|rear wheel drive|hi-?ride 4x2/.test(t) ? '4x2' : null;
  const cab = /crew|dual cab|double cab|4dr/.test(t) && !/space|extended|king|club/.test(t) ? 'crew' : /space|extended|king|club/.test(t) ? 'space' : /single cab|single\b|2dr/.test(t) ? 'single' : null;
  const gen = dmax ? (/\brg\b/.test(t) ? 'RG' : /\btf\b/.test(t) ? 'TF' : null) : null;
  const engine = dmax ? (/1\.9|1\.9dt|\bls-?m 1\.9/.test(t) ? '1.9' : /3\.0|3\.0dt|3l\b/.test(t) ? '3.0' : null) : null;
  const trim = dmax ? canonTrim((/\b(x-?terrain|x-?rider|x-?runner|ls-?u\s?\+|ls-?u|ls-?m|sx|blade)(?![a-z0-9])/.exec(t) || [])[1]) : null;
  return { isuzu, dmax, mux, truck, code, series, cls, gvm, body, curtain: body === 'curtainsider', drive, cab, gen, engine, trim };
}

// ---- D-Max trims ----
// Rough price of each trim against an X-Terrain of the same age and km (from new prices and what's on
// Carsales: a Blade lists ~12% above an X-Terrain, an SX cab chassis ~20% below). Used only to re-price a
// comparable of a different trim, and the valuation is marked rough when it leans on that.
export const TRIMS = {
  sx: { label: 'SX', index: 0.8, tier: 0 },
  'ls-m': { label: 'LS-M', index: 0.84, tier: 1 },
  'ls-u': { label: 'LS-U', index: 0.9, tier: 2 },
  'x-runner': { label: 'X-Runner', index: 0.9, tier: 2 },
  'ls-u+': { label: 'LS-U+', index: 0.93, tier: 2.5 },
  'x-rider': { label: 'X-Rider', index: 0.92, tier: 2.5 },
  'x-terrain': { label: 'X-Terrain', index: 1, tier: 3 },
  blade: { label: 'Blade', index: 1.12, tier: 3.6 },
};
function canonTrim(s) {
  if (!s) return null;
  const k = s.toLowerCase().replace(/\s+/g, '').replace(/^x-?/, 'x-').replace(/^ls-?/, 'ls-');
  return TRIMS[k] ? k : null;
}
export const trimRatio = (a, b) => (a && b && TRIMS[a] && TRIMS[b] ? TRIMS[a].index / TRIMS[b].index : 1);

// ---- damage ----
// Allowance: share of the retail value to set aside for repairs, by what's wrong. Stigma: what a written-off
// history takes off the value even once it's fixed (insurance, resale).
const DAMAGE = [
  ['fire', /fire\s*damage|burnt|\bfire\b/, 0.5, true],
  ['flood', /flood|water\s*damage|submerged/, 0.4, true],
  ['rollover', /roll[\s-]?over|rolled/, 0.35],
  ['non-runner', /non[\s-]?runner|not\s*running|won'?t\s*start|does\s*not\s*start|no start|engine\s*(?:damage|seized|failure)|no\s*drive/, 0.18],
  // from the lot page's condition notes: "transmission needs attention", "DPF warning", "engine runs rough"...
  ['mechanical', /engine\s*(?:fault|issue|runs rough)|gearbox|transmission\s*(?:fault|needs attention)|dpf warning|warning light on|overheating|smoking/, 0.1],
  ['rust', /major rust/, 0.06],
  ['airbags', /airbags deployed/, 0.15],
  ['accident', /accident|collision|impact|front\s*damage|rear\s*damage|side\s*damage|panel\s*damage|structural|smash/, 0.15],
  ['theft', /theft|stolen|recovered|stripped|vandal/, 0.12],
  ['hail', /\bhail\b/, 0.08],
  ['minor', /minor\s*damage|cosmetic|scratch|dent/, 0.05],
  ['no keys', /no keys/, 0.02],
];

/** { level: clean|repairable|damaged|statutory, kinds[], allowancePct, stigmaPct, avoid, label } */
export function damageOf(lot, { stigma = 0.15 } = {}) {
  const w = String(lot.wovr || '').toLowerCase();
  const text = `${lot.title || ''} ${lot.sale_name || ''} ${lot.category || ''} ${lot.damage || ''} ${lot.check_flags || ''}`.toLowerCase();
  // condition notes read off the lot page are a short list of real problems (never scratches and stains)
  const cond = String(lot.condition || '').toLowerCase();
  const kinds = DAMAGE.filter(([k, re]) => re.test(text) || (cond && k !== 'minor' && re.test(cond)));
  const statutory = /statutory/.test(w);
  const repairable = !statutory && /repairable|inspection passed/.test(w);
  const salvage = lot.market === 'salvage' || /salvage|insurance|damaged|non[\s-]?runner/.test(`${lot.sale_name || ''} ${lot.category || ''} ${lot.url || ''}`.toLowerCase());
  const level = statutory ? 'statutory' : repairable ? 'repairable' : kinds.length || salvage ? 'damaged' : 'clean';
  let allowancePct = kinds.reduce((m, k) => Math.max(m, k[2]), 0);
  if (!allowancePct && (repairable || salvage)) allowancePct = 0.15;   // written off / salvage but we can't tell why
  const avoid = statutory || kinds.some(k => k[3]);
  const label = statutory ? 'Statutory write-off: can never be registered'
    : [repairable ? (/inspection passed/.test(w) ? 'Repairable write-off (inspection passed)' : 'Repairable write-off') : salvage && !kinds.length ? 'Salvage' : null,
      ...kinds.map(k => k[0])].filter(Boolean).join(' · ') || 'No damage listed';
  return { level, kinds: kinds.map(k => k[0]), allowancePct: level === 'clean' ? 0 : allowancePct, stigmaPct: repairable ? stigma : 0, avoid, label };
}

// ---- dream types ----
export const KINDS = {
  dmax: {
    label: 'Isuzu D-Max', icon: '🛻',
    match: f => (f.dmax ? 'yes' : null),
    pickles: ['https://www.pickles.com.au/used/search/cars/isuzu/d-max'],
    kmScale: 40000, rates: { year: 0.085, km: 0.11 }, factor: 0.8, onRoad: 750, stigma: 0.22,
    group: f => `${f.trim || '?'}|${f.drive || '?'}|${f.cab || '?'}`,
  },
  curtainsider: {
    label: 'Isuzu curtainsider', icon: '🚚',
    // body stated: curtainsider = yes; body not stated = maybe (eyeball it); any other body = no
    match: f => (f.isuzu && f.truck ? (f.curtain ? 'yes' : !f.body || f.body === 'cab chassis' ? 'maybe' : null) : null),
    pickles: ['https://www.pickles.com.au/used/search/trucks/isuzu'],
    kmScale: 120000, rates: { year: 0.07, km: 0.06 }, factor: 0.72, onRoad: 1500, stigma: 0.12,
    group: f => f.cls || f.series || '?',
  },
  custom: {
    label: 'Custom', icon: '⭐',
    match: () => null, // set per dream from its search terms
    pickles: [],
    kmScale: 60000, rates: { year: 0.08, km: 0.09 }, factor: 0.78, onRoad: 750, stigma: 0.2,
    group: f => f.drive || '?',
  },
};

/** How far apart two vehicles are for valuing one against the other (0 = same spec). */
export function specGap(kind, a, b) {
  if (kind === 'dmax') {
    let d = 0;
    if (a.drive && b.drive && a.drive !== b.drive) d += 1.5;
    if (a.cab && b.cab && a.cab !== b.cab) d += 1;
    if (a.body && b.body && a.body !== b.body) d += 0.4;
    if (a.gen && b.gen && a.gen !== b.gen) d += 0.8;
    if (a.engine && b.engine && a.engine !== b.engine) d += 0.6;
    if (a.trim && b.trim && a.trim !== b.trim) d += 0.8 + Math.abs(TRIMS[a.trim].tier - TRIMS[b.trim].tier) * 0.6;
    else if (!a.trim !== !b.trim) d += 0.6;   // one of them doesn't say its trim
    return d;
  }
  if (kind === 'curtainsider') {
    if (a.code && b.code && a.code === b.code) return 0;
    if (a.cls && b.cls) return a.cls === b.cls ? 0.4 : a.cls[0] === b.cls[0] ? 2.5 : 4;
    return 1.2;
  }
  return a.drive && b.drive && a.drive !== b.drive ? 1 : 0;
}
