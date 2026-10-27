// Loads the manifest and per-airport shard files produced by build_data.py (format in that file's docstring).

const DATA_URL = new URL("../data/", import.meta.url); // relative to this script, so any sub-path works
const cache = new Map();

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  const buf = await res.arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] !== 0x1f || head[1] !== 0x8b) return buf; // server already decoded the gzip
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

export async function loadManifest() {
  const res = await fetch(new URL("manifest.json", DATA_URL));
  if (!res.ok) throw new Error("Could not load data/manifest.json. Run `uv run webapp/build_data.py` first.");
  return res.json();
}

function decode(buf) {
  const n = new DataView(buf).getUint32(0, true);
  let off = 4;
  const take = (Type, bytes) => {
    const arr = new Type(buf, off, n);
    off += n * bytes;
    return arr;
  };
  return {
    n,
    day: take(Uint16Array, 2), other: take(Uint16Array, 2), depMin: take(Uint16Array, 2),
    dep: take(Int16Array, 2), arr: take(Int16Array, 2),
    carrier: take(Uint8Array, 1), canc: take(Uint8Array, 1),
  };
}

/** kind is "origin" or "dest"; shards are cached for the page's lifetime. */
export function loadShard(kind, code) {
  const key = `${kind}/${code}`;
  if (!cache.has(key)) {
    const p = fetchBuffer(new URL(`${key}.bin.gz`, DATA_URL)).then(decode);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return cache.get(key);
}
