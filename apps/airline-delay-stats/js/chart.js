// SVG rendering of the result: same layout as the matplotlib figure in airline_stats.py.
import { fmt0, fmtNum } from "./stats.js";

const NS = "http://www.w3.org/2000/svg";
const W = 1000, LEFT = 30, RATE_X = 135, X0 = 340, X1 = 970;
const TOP = 95, ROW_H = 118, PLOT_H = 88, YMAX = 1.3; // y data runs 0..1 inside a 0..YMAX axis

function el(tag, attrs = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Round tick positions (1/2/5 x 10^k) inside [lo, hi]. */
function niceTicks(lo, hi, target = 8) {
  const raw = (hi - lo) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) ticks.push(Number(t.toFixed(6)));
  return ticks;
}

export function renderChart(container, res) {
  const { rows, grid, lo, hi, limit } = res;
  const H = TOP + rows.length * ROW_H + 60;
  const sx = (v) => X0 + ((v - lo) / (hi - lo)) * (X1 - X0);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", class: "chart",
    "aria-label": `${res.title}. ${res.subtitle}` });
  svg.append(el("text", { x: LEFT, y: 28, class: "t-title" }, res.title));
  svg.append(el("text", { x: LEFT, y: 52, class: "t-sub" }, res.subtitle));

  // The right-hand limit is labelled "N+" (it stands for every delay at or above N).
  let ticks = niceTicks(lo, hi);
  const labels = new Map(ticks.map((t) => [t, fmtNum(t)]));
  if (limit) {
    ticks = ticks.filter((t) => t < hi - 0.06 * (hi - lo));
    ticks.push(hi);
    labels.set(hi, `${fmtNum(hi)}+`);
  }

  rows.forEach((r, i) => {
    const base = TOP + i * ROW_H + ROW_H - 18;
    const s = PLOT_H / YMAX;
    const g = el("g", { class: "row" });
    g.append(el("title", {}, `${r.code} (${r.name})`));
    g.append(el("text", { x: LEFT, y: base - 30, class: "t-code" }, r.code));
    if (r.n) {
      g.append(el("text", { x: RATE_X, y: base - 70, class: "t-small" }, `${r.n} scheduled flights`));
      g.append(el("text", { x: RATE_X, y: base - 40, class: "t-rate" }, `${(r.cr * 100).toFixed(1)}%`));
      g.append(el("text", { x: RATE_X, y: base - 14, class: "t-small" }, "cancelled"));
    } else {
      g.append(el("text", { x: RATE_X, y: base - 30, class: "t-small" }, "no flights"));
    }
    g.append(el("line", { x1: sx(0), x2: sx(0), y1: base - YMAX * s, y2: base, class: "zero" }));
    g.append(el("line", { x1: X0, x2: X1, y1: base, y2: base, class: "axis" }));
    for (const t of ticks) g.append(el("line", { x1: sx(t), x2: sx(t), y1: base, y2: base + 4, class: "axis" }));

    if (r.y) {
      const pts = grid.map((v, k) => `${sx(v).toFixed(1)},${(base - r.y[k] * s).toFixed(1)}`);
      g.append(el("polygon", { points: `${sx(grid[0])},${base} ${pts.join(" ")} ${sx(grid[grid.length - 1])},${base}`,
        class: "violin-fill" }));
      g.append(el("polyline", { points: pts.join(" "), class: "violin-line" }));
      const pos = Math.min(r.median, hi); // a median beyond the limit is drawn at the edge
      g.append(el("line", { x1: sx(pos), x2: sx(pos), y1: base, y2: base - s, class: "median" }));
      const atEdge = pos > hi - 0.05 * (hi - lo);
      g.append(el("text", { x: sx(pos), y: base - 1.05 * s - 4, class: "t-small",
        "text-anchor": atEdge ? "end" : "middle" }, `median ${fmt0(r.median)}`));
      if (r.plotted.length <= 40) { // show individual flights when the sample is small
        for (const d of r.plotted) {
          g.append(el("line", { x1: sx(d), x2: sx(d), y1: base + 3, y2: base + 11, class: "flight" }));
        }
      }
    }
    svg.append(g);
  });

  const last = TOP + (rows.length - 1) * ROW_H + ROW_H - 18;
  for (const t of ticks) svg.append(el("text", { x: sx(t), y: last + 24, class: "t-tick", "text-anchor": "middle" }, labels.get(t)));
  svg.append(el("text", { x: (X0 + X1) / 2, y: last + 50, class: "t-axis", "text-anchor": "middle" }, res.xlabel));
  container.replaceChildren(svg);
}

export function renderTable(container, res) {
  const table = document.createElement("table");
  table.innerHTML = "<thead><tr><th>Airline</th><th>Scheduled flights</th><th>Cancelled</th>"
    + "<th>Cancel rate</th><th>Median delay (min)</th></tr></thead>";
  const body = document.createElement("tbody");
  for (const r of res.rows) {
    const tr = document.createElement("tr");
    const cells = [`${r.code} · ${r.name}`, r.n, r.n ? r.cancelled : "–",
      r.n ? `${(r.cr * 100).toFixed(1)}%` : "–", fmt0(r.median)];
    for (const c of cells) tr.append(Object.assign(document.createElement("td"), { textContent: c }));
    body.append(tr);
  }
  table.append(body);
  container.replaceChildren(table);
}
