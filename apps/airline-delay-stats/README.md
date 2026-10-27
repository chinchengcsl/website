# Flight delay stats web app

Static page (vanilla JS, no build step). `airline_stats.py` in the parent folder is the reference implementation.

- **Build the data** (only when the monthly CSVs in `../data/` change): `uv run webapp/build_data.py` from the project root. Writes `data/manifest.json` and per-airport shards `data/origin/*.bin.gz`, `data/dest/*.bin.gz`.
- **Run locally**: `cd webapp && python3 -m http.server 8000`, then open http://localhost:8000/ (ES modules and `fetch` need http, not `file://`).
- **Deploy**: copy this folder to `app/flight-stats/` in the Jekyll website repo, leaving out `build_data.py` and this README. All URLs are relative, so it works under any sub-path.
