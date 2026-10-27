// Query validation, filtering and statistics. A port of airline_stats.py (the reference implementation).

export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const MISSING = -32768; // missing delay in the shard files
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];

/** '1800-0000' -> [1080, 1440] minutes since midnight, end exclusive; end 0000 means midnight. */
export function parseTimeRange(spec) {
  const m = /^\s*(\d{1,4})\s*-\s*(\d{1,4})\s*$/.exec(String(spec));
  const bad = () => new Error(`time_range must look like '1800-0000', got '${spec}'`);
  if (!m) throw bad();
  const [s, e] = [Number(m[1]), Number(m[2])];
  if (s % 100 > 59 || e % 100 > 59) throw bad();
  const start = Math.floor(s / 100) * 60 + (s % 100);
  let end = Math.floor(e / 100) * 60 + (e % 100);
  if (end === 0) end = 1440;
  if (!(start >= 0 && start < 1440 && start < end && end <= 1440)) {
    throw new Error("time_range must lie within one day (end after start, or 0000 for midnight)");
  }
  return [start, end];
}

function monthLabel(label, long) {
  const [y, m] = label.split("-").map(Number);
  return `${(long ? MONTHS_LONG : MONTHS)[m - 1]} ${y}`;
}

function periodLabel(months, i0, i1) {
  if (i0 === i1) return monthLabel(months[i0].label, true);
  return `${monthLabel(months[i0].label)} – ${monthLabel(months[i1].label)}`;
}

const unique = (xs) => [...new Set(xs)];
const codes = (xs) => unique((xs || []).map((x) => String(x).trim().toUpperCase()).filter(Boolean));

/** Validate the query against the manifest and work out which shard files are needed. */
export function resolveQuery(q, manifest) {
  const day = DAYS.indexOf(q.day_of_week);
  if (day < 0) throw new Error(`day_of_week must be one of ${DAYS.join(", ")}`);
  const airlines = codes(q.airlines);
  if (!airlines.length) throw new Error("choose at least one airline");
  const origin = codes(q.origin);
  const dest = codes(q.destination);
  if (!origin.length && !dest.length) throw new Error("specify at least one of 'origin' or 'destination'");

  const airportIndex = new Map(manifest.airports.map((a, i) => [a.code, i]));
  const unknown = [...origin, ...dest].filter((c) => !airportIndex.has(c));
  if (unknown.length) throw new Error(`Unknown airport code(s) ${unknown.join(", ")}`);

  // Default: departure delay unless only a destination is given.
  const delay = q.delay || (dest.length && !origin.length ? "arrival" : "departure");
  if (delay !== "departure" && delay !== "arrival") throw new Error("delay must be 'departure' or 'arrival'");

  const labels = manifest.months.map((m) => m.label);
  const i0 = labels.indexOf(q.start);
  const i1 = labels.indexOf(q.end || q.start);
  if (i0 < 0 || i1 < 0) throw new Error(`months must be between ${labels[0]} and ${labels[labels.length - 1]}`);
  if (i1 < i0) throw new Error("'end' must not be before 'start'");

  const span = q.time_range ? parseTimeRange(q.time_range) : null;

  let limit = null;
  if (q.max_delay !== null && q.max_delay !== undefined && q.max_delay !== "") {
    limit = Number(q.max_delay);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(`max_delay must be a positive number of minutes, got '${q.max_delay}'`);
    }
  }

  // Read the origin shards when an origin is given (then keep only the requested destinations),
  // otherwise the destination shards.
  const kind = origin.length ? "origin" : "dest";
  const shardCodes = (origin.length ? origin : dest).filter((c) => {
    const a = manifest.airports[airportIndex.get(c)];
    return (origin.length ? a.n_out : a.n_in) > 0;
  });
  return {
    airlines, origin, dest, delay, span, limit, day, airportIndex,
    dayLo: manifest.months[i0].start, dayHi: manifest.months[i1].end,
    period: periodLabel(manifest.months, i0, i1),
    window: span ? `${q.time_range} scheduled dep` : null,
    shards: shardCodes.map((code) => ({ kind, code })),
  };
}

/** Filter the loaded shards and group flights by airline. */
export function collect(plan, manifest, shards) {
  const carrierIndex = new Map(manifest.carriers.map((c, i) => [c.code, i]));
  const slot = new Int16Array(256).fill(-1);
  plan.airlines.forEach((a, k) => { if (carrierIndex.has(a)) slot[carrierIndex.get(a)] = k; });
  const otherOk = plan.origin.length && plan.dest.length
    ? Uint8Array.from({ length: manifest.airports.length }, () => 0) : null;
  if (otherOk) plan.dest.forEach((c) => { otherOk[plan.airportIndex.get(c)] = 1; });

  const rows = plan.airlines.map((code) => ({ code, n: 0, cancelled: 0, list: [] }));
  const [t0, t1] = plan.span || [0, 65536];
  const dow0 = manifest.epoch_dow;
  for (const s of shards) {
    const delays = plan.delay === "departure" ? s.dep : s.arr;
    for (let i = 0; i < s.n; i++) {
      const d = s.day[i];
      if (d < plan.dayLo || d >= plan.dayHi || (dow0 + d) % 7 !== plan.day) continue;
      const k = slot[s.carrier[i]];
      if (k < 0) continue;
      if (otherOk && !otherOk[s.other[i]]) continue;
      if (plan.span && (s.depMin[i] < t0 || s.depMin[i] >= t1)) continue;
      const r = rows[k];
      r.n++;
      if (s.canc[i]) r.cancelled++;
      else if (delays[i] !== MISSING) r.list.push(delays[i]);
    }
  }
  return rows.map((r) => ({
    code: r.code, n: r.n, cancelled: r.cancelled,
    cr: r.n ? r.cancelled / r.n : NaN,
    delays: Float64Array.from(r.list).sort(), // typed-array sort is numeric
  }));
}

/** numpy-style linear-interpolated percentile of a sorted array. */
export function percentile(sorted, p) {
  const n = sorted.length;
  if (!n) return NaN;
  const pos = ((n - 1) * p) / 100;
  const i = Math.floor(pos);
  return i + 1 < n ? sorted[i] + (sorted[i + 1] - sorted[i]) * (pos - i) : sorted[n - 1];
}

export const median = (sorted) => percentile(sorted, 50);

/** Gaussian KDE (unnormalised: the caller rescales so the peak is 1). Silverman bandwidth with a robust
 *  spread, capped so a few very late flights don't smear the on-time cluster. Equal values are merged. */
export function kde(sorted, grid, maxBw = 10) {
  const n = sorted.length;
  let bw = 5;
  if (n > 1) {
    const mean = sorted.reduce((a, b) => a + b, 0) / n;
    const std = Math.sqrt(sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    const iqr = percentile(sorted, 75) - percentile(sorted, 25);
    const spread = Math.min(std, iqr / 1.34) || std;
    bw = Math.min(Math.max(0.9 * spread * n ** -0.2, 2.0), maxBw);
  }
  const vals = [], counts = [];
  for (const v of sorted) {
    if (vals.length && vals[vals.length - 1] === v) counts[counts.length - 1]++;
    else { vals.push(v); counts.push(1); }
  }
  return grid.map((g) => {
    let sum = 0;
    for (let j = 0; j < vals.length; j++) {
      const z = (g - vals[j]) / bw;
      sum += counts[j] * Math.exp(-0.5 * z * z);
    }
    return sum;
  });
}

/** Everything the chart needs: axis range, KDE curves, medians (taken before clipping). */
export function buildResult(plan, manifest, rows) {
  const all = Float64Array.from(rows.flatMap((r) => Array.from(r.delays))).sort();
  let lo = all.length ? percentile(all, 1) : 0;
  let hi = all.length ? percentile(all, 99) : 0;
  lo = Math.min(lo, -15);
  hi = Math.max(hi, 30);
  const limit = plan.limit;
  if (limit) {
    hi = limit;
    lo = Math.min(lo, -15, limit - 1);
  }
  const grid = Array.from({ length: 400 }, (_, i) => lo + ((hi - lo) * i) / 399);
  const names = new Map(manifest.carriers.map((c) => [c.code, c.name]));

  const out = rows.map((r) => {
    const med = r.delays.length ? median(r.delays) : NaN; // true median, before clipping
    const plotted = limit ? r.delays.map((d) => Math.min(d, limit)) : r.delays;
    let y = null;
    if (plotted.length) {
      const raw = kde(plotted, grid);
      const peak = Math.max(...raw);
      if (peak > 0) y = raw.map((v) => v / peak);
    }
    return { ...r, name: names.get(r.code) || r.code, median: med, plotted, y };
  });

  const route = [plan.origin, plan.dest].map((x) => (x.length ? x.join(", ") : "any")).join(" → ");
  const day = DAYS[plan.day];
  return {
    title: `${plan.delay[0].toUpperCase()}${plan.delay.slice(1)} delays, ${route}`,
    subtitle: `${day}s, ${plan.period}${plan.window ? `, ${plan.window}` : ""}`,
    xlabel: "Delay (minutes; negative = early, cancelled flights excluded"
      + (limit ? `; ${fmtNum(limit)}+ = all delays of ${fmtNum(limit)} min or more)` : ")"),
    rows: out, grid, lo, hi, limit,
  };
}

export const fmtNum = (x) => String(Number(x.toFixed(6)));

/** Round to a whole number, ties to even (like Python's f"{x:.0f}"), so numbers match the Python tool. */
export function fmt0(x) {
  if (!Number.isFinite(x)) return "–";
  const tie = Math.abs(x % 1) === 0.5;
  return String(tie ? 2 * Math.round(x / 2) : Math.round(x));
}
