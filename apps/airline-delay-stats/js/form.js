// The query form: builds its controls from the manifest, and converts to/from a query object and the URL hash.
import { DAYS } from "./stats.js";

const $ = (id) => document.getElementById(id);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function defaultQuery(manifest) {
  const labels = manifest.months.map((m) => m.label);
  return {
    airlines: ["WN", "AA", "AS", "QX"].filter((c) => manifest.carriers.some((x) => x.code === c)),
    origin: ["SAN"], destination: ["SJC"],
    start: labels[0], end: labels[labels.length - 1],
    day_of_week: "Friday", time_range: "1800-0000", delay: "", max_delay: 200,
  };
}

export function queryToHash(q) {
  const p = new URLSearchParams();
  const set = (k, v) => { if (v !== "" && v !== null && v !== undefined) p.set(k, v); };
  set("airlines", q.airlines.join(","));
  set("origin", q.origin.join(","));
  set("dest", q.destination.join(","));
  set("start", q.start); set("end", q.end);
  set("dow", q.day_of_week); set("time", q.time_range);
  set("delay", q.delay); set("max", q.max_delay);
  return p.toString();
}

export function hashToQuery(hash, fallback) {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  if (![...p.keys()].length) return null;
  const list = (k) => (p.get(k) || "").split(",").filter(Boolean);
  return {
    airlines: list("airlines"), origin: list("origin"), destination: list("dest"),
    start: p.get("start") || fallback.start, end: p.get("end") || fallback.end,
    day_of_week: p.get("dow") || fallback.day_of_week, time_range: p.get("time") || "",
    delay: p.get("delay") || "", max_delay: p.get("max") || "",
  };
}

/** A text box that turns airport codes into removable chips. */
function chipInput(root, validCodes) {
  const input = root.querySelector("input");
  const hint = root.parentElement.querySelector(".hint");
  const chips = [];
  const render = () => {
    root.querySelectorAll(".chip").forEach((c) => c.remove());
    for (const code of chips) {
      const chip = Object.assign(document.createElement("span"), { className: "chip", textContent: code });
      const x = Object.assign(document.createElement("button"), { type: "button", textContent: "×" });
      x.setAttribute("aria-label", `Remove ${code}`);
      x.addEventListener("click", () => { chips.splice(chips.indexOf(code), 1); render(); });
      chip.append(x);
      root.insertBefore(chip, input);
    }
  };
  const commit = () => {
    const rejected = [];
    for (const tok of input.value.toUpperCase().split(/[\s,]+/).filter(Boolean)) {
      if (!validCodes.has(tok)) rejected.push(tok);
      else if (!chips.includes(tok)) chips.push(tok);
    }
    input.value = rejected.join(" ");
    hint.textContent = rejected.length ? `Unknown airport code: ${rejected.join(", ")}` : "";
    render();
  };
  input.addEventListener("input", () => { // 3-letter codes (typed or picked from the list) are added at once
    const t = input.value.trim().toUpperCase();
    if (t.length === 3 && validCodes.has(t)) commit();
  });
  input.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === ",") && input.value.trim()) { e.preventDefault(); commit(); }
    else if (e.key === "Backspace" && !input.value && chips.length) { chips.pop(); render(); }
  });
  input.addEventListener("blur", commit);
  root.addEventListener("click", () => input.focus());
  return {
    get: () => { commit(); return [...chips]; },
    set: (list) => { chips.splice(0, chips.length, ...list); input.value = ""; hint.textContent = ""; render(); },
  };
}

const hhmm = (t) => t.replace(":", "");
const toTime = (s) => `${s.slice(0, 2)}:${s.slice(2)}`;

export function initForm(manifest, onSubmit) {
  const form = $("query");
  const valid = new Set(manifest.airports.map((a) => a.code));
  $("airport-list").replaceChildren(...manifest.airports.map((a) =>
    Object.assign(document.createElement("option"), { value: a.code, label: a.city, textContent: a.city })));

  const origin = chipInput($("origin"), valid);
  const dest = chipInput($("destination"), valid);

  // Most-flown carriers first.
  const carriers = [...manifest.carriers].sort((a, b) => b.n - a.n);
  $("airlines").replaceChildren(...carriers.map((c) => {
    const label = document.createElement("label");
    label.className = "pill";
    const box = Object.assign(document.createElement("input"), { type: "checkbox", value: c.code });
    label.append(box, ` ${c.code}`);
    label.title = c.name;
    return label;
  }));

  const monthOptions = manifest.months.map((m) => {
    const [y, mo] = m.label.split("-").map(Number);
    return Object.assign(document.createElement("option"), { value: m.label, textContent: `${MONTHS[mo - 1]} ${y}` });
  });
  $("start").replaceChildren(...monthOptions.map((o) => o.cloneNode(true)));
  $("end").replaceChildren(...monthOptions.map((o) => o.cloneNode(true)));
  $("day").replaceChildren(...DAYS.map((d) => Object.assign(document.createElement("option"), { value: d, textContent: d })));

  const syncTime = () => { $("time-start").disabled = $("time-end").disabled = $("any-time").checked; };
  $("any-time").addEventListener("change", syncTime);

  function getQuery() {
    let time_range = "";
    if (!$("any-time").checked) {
      if (!$("time-start").value || !$("time-end").value) {
        throw new Error("Enter both a start and an end time, or tick 'Any time'");
      }
      time_range = `${hhmm($("time-start").value)}-${hhmm($("time-end").value)}`;
    }
    return {
      airlines: [...$("airlines").querySelectorAll("input:checked")].map((b) => b.value),
      origin: origin.get(), destination: dest.get(),
      start: $("start").value, end: $("end").value,
      day_of_week: $("day").value, time_range,
      delay: $("delay").value, max_delay: $("max-delay").value.trim(),
    };
  }

  function setQuery(q) {
    const chosen = new Set(q.airlines);
    $("airlines").querySelectorAll("input").forEach((b) => { b.checked = chosen.has(b.value); });
    origin.set(q.origin); dest.set(q.destination);
    $("start").value = q.start; $("end").value = q.end;
    $("day").value = q.day_of_week;
    $("any-time").checked = !q.time_range;
    const m = /^(\d{4})-(\d{4})$/.exec(q.time_range || "");
    $("time-start").value = m ? toTime(m[1]) : "18:00";
    $("time-end").value = m ? toTime(m[2]) : "00:00";
    $("delay").value = q.delay || "";
    $("max-delay").value = q.max_delay ?? "";
    syncTime();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    try { onSubmit(getQuery()); } catch (err) { onSubmit(null, err); }
  });
  return { getQuery, setQuery };
}
