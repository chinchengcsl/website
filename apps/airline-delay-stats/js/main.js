import { loadManifest, loadShard } from "./data.js";
import { resolveQuery, collect, buildResult } from "./stats.js";
import { renderChart, renderTable } from "./chart.js";
import { initForm, defaultQuery, queryToHash, hashToQuery } from "./form.js";

const $ = (id) => document.getElementById(id);
let seq = 0; // lets a newer query supersede one still loading

function status(text, isError = false) {
  const s = $("status");
  s.textContent = text;
  s.classList.toggle("error", isError);
}

async function run(manifest, q, err) {
  const mine = ++seq;
  if (err) return fail(err);
  history.replaceState(null, "", `#${queryToHash(q)}`);
  status("Loading…");
  try {
    const plan = resolveQuery(q, manifest);
    const shards = await Promise.all(plan.shards.map((s) => loadShard(s.kind, s.code)));
    if (mine !== seq) return;
    const res = buildResult(plan, manifest, collect(plan, manifest, shards));
    renderChart($("chart"), res);
    renderTable($("table"), res);
    const total = res.rows.reduce((a, r) => a + r.n, 0);
    status(total ? `${total.toLocaleString()} scheduled flights matched.` : "No flights match this query.");
  } catch (e) {
    if (mine === seq) fail(e);
  }
}

function fail(e) {
  $("chart").replaceChildren();
  $("table").replaceChildren();
  status(e.message, true);
}

async function main() {
  let manifest;
  try {
    manifest = await loadManifest();
  } catch (e) {
    return fail(e);
  }
  const first = manifest.months[0].label, last = manifest.months[manifest.months.length - 1].label;
  $("data-range").textContent = `Data: ${first} to ${last}, ${manifest.airports.length} airports.`;

  const form = initForm(manifest, (q, err) => run(manifest, q, err));
  const fallback = defaultQuery(manifest);
  const fromHash = () => hashToQuery(location.hash, fallback) || fallback;
  form.setQuery(fromHash());
  window.addEventListener("hashchange", () => { const q = fromHash(); form.setQuery(q); run(manifest, q); });
  run(manifest, fromHash());
}

main();
