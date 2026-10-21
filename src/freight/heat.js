// How fresh a freight job is. Fresh jobs get quoted fast; older ones that are still listed are
// the ones to ring when a truck is already going that way ("still need this moved?").
const H = 3600000, D = 24 * H;
export const TIERS = [
  { key: 'ultra', label: 'Ultra Hot', max: 24 * H },
  { key: 'hot', label: 'Hot', max: 72 * H },
  { key: 'warm', label: 'Warm', max: 7 * D },
  { key: 'luke', label: 'Luke Warm', max: 14 * D },
  { key: 'cold', label: 'Cold', max: Infinity },
];

/** When the job was posted, as best we know it, and how sure we are. */
export function postedOf(j) {
  if (j.posted_at != null) return { at: j.posted_at, approx: j.age_basis === 'est' };
  // Loadshift shows no post date: until we can estimate it, the age is unknown (first_seen would make
  // a month-old load look brand new the first time we read it)
  if (j.site === 'loadshift') return { at: null, approx: true };
  return { at: j.first_seen, approx: true };
}

export function tierOf(j, now = Date.now()) {
  const { at } = postedOf(j);
  if (at == null) return 'unknown';
  const age = Math.max(0, now - at);
  return TIERS.find(t => age <= t.max).key;
}

/** Dates on the job: passed (the latest date has gone by), flexible (no date set) or neither. */
export function dateFlag(j, now = Date.now()) {
  if (j.date_by != null && j.date_by < now - 12 * H) return 'passed';
  if (j.flexible) return 'flexible';
  return null;
}

/** Loadshift numbers its loads in order. From the loads we watched appear (id -> time posted) we fit
 *  a line (Theil-Sen, so a few odd ones don't skew it) and use it to date every other load. */
export function fitIdTime(points) {
  const P = points.filter(p => Number.isFinite(p.id) && Number.isFinite(p.t)).sort((a, b) => a.id - b.id);
  if (P.length < 6) return null;
  const spanT = Math.max(...P.map(p => p.t)) - Math.min(...P.map(p => p.t));
  if (spanT < 3 * H) return null;
  const step = Math.max(1, Math.floor(P.length / 120)); // keep the pairwise work small
  const S = P.filter((_, i) => i % step === 0);
  const slopes = [];
  for (let i = 0; i < S.length; i++) for (let k = i + 1; k < S.length; k++) {
    const di = S[k].id - S[i].id, dt = S[k].t - S[i].t;
    if (di > 0) slopes.push(dt / di);
  }
  if (!slopes.length) return null;
  slopes.sort((a, b) => a - b);
  const b = slopes[slopes.length >> 1];
  if (!(b > 0)) return null;
  const ints = P.map(p => p.t - b * p.id).sort((x, y) => x - y);
  const a = ints[ints.length >> 1];
  return { a, b, n: P.length, at: id => a + b * id };
}
