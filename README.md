# q_plat

Single-file quant research frontend, cloud-only market ingestion, MongoDB Atlas snapshots and private workspaces. The project is still under acceptance testing; this README does not claim a completed release.

## Run and verify

Node 22+. `npm ci`, `npm test`, `npm run build`. Only generated numeric fixtures run locally. Never download market data or run ingestion locally. Ingestion refuses to execute outside a Vercel deployment.

Production environment: `MONGODB_URI`, `MONGODB_DB=q_plat`, `OWNER_KEY`, `APP_ORIGIN`. Secrets are server-side only. A database identity must be restricted to `readWrite` on the app database and its named test database. Do not open network access or enable paid features to work around connectivity.

## Architecture

`index.html → same-origin /api → Atlas`. Next.js provides only backend routes and durable Vercel Workflow handlers; it does not build or rewrite the frontend. `/` and `/download` return identical source bytes. A downloaded `file://` document can read bounded public catalog/window endpoints using anonymous CORS; private operations require production HTTPS and an HTTP-only session cookie.

`lib/dsl.mjs` is a bounded parser/interpreter (no eval). `lib/engine.mjs` and `lib/metrics.mjs` are pure calculation modules. `lib/ingest.mjs` fetches allowlisted publishers into bounded cloud RAM, checks normalized hashes and readback, then publishes an immutable ready snapshot. Labels never enter the DSL feature allowlist. `lib/jobs.mjs` persists outputs in bounded documents and idempotent bulk writes; Workflow persists job execution across disconnects. Workflow inputs/outputs contain IDs/counts/hashes, not market panels. Atlas is the long-term store.

## Research conventions

- UCI is 750 weekly OHLCV observations for 30 assets in 2011 H1, CC BY 4.0, attributed to Michael Brown / UCI DOI 10.24432/C5788V. Price-only, not total return. The benchmark is `equal-weight sample`, not the official Dow Jones index.
- ECB is six daily reference FX rates quoted in foreign currency per EUR, 2010–2024. Source: ECB statistics. Raw statistics are preserved; derived statistics are labeled. No executable OHLC/volume is fabricated.
- Synthetic generator: seed 271828, 28 assets × 1,200 weekday sessions with missing rows, late listing, sectors, regimes and zero volume. The split fixture is separate.
- Average ties, ascending percentile rank. Rolling uses dataset session slots, requires full windows and ddof=1 standard deviation. Missing/zero denominator returns null. Historical publication times are conservative proxies, not point-in-time verified data.
- OHLC evaluation label: `open(t+1+h)/open(t+1)-1`. Per-session Spearman IC with block bootstrap. Ideal long/short is a diagnostic (gross 1/net 0), not a borrow-enabled account. Quantile paths with overlapping horizons are diagnostics.
- Long-only orders are sized at decision close, filled at a later observed open with per-side fees/slippage, lots, cash and participation constraints. Missing open/zero volume never fills. Cash settlement is immediate; last prices mark stale positions; terminal holdings are not liquidated. No dividends or borrow model.
- Chronological splits purge labels crossing the next cutoff. Walk-forward selects top-K from two predeclared candidates on train only and reports every candidate. Opening a report marks holdout as viewed. Research metrics are never required to be profitable.

## Editing the next UI revision

Keep `index.html` as the sole frontend source. Sections are marked `THEME`, `LAYOUT`, `API CLIENT`, `CHART RENDERERS`, `INTERACTION`. Change CSS tokens in `:root`, named layout classes, or the canvas plot functions. Preserve API contracts and source/run/version labels. Do not reimport data or change the production project/alias when changing appearance. Run unit/build checks and relevant production E2E, compare `/` and `/download` SHA-256, and deploy the same Git-connected project.

## Acceptance status

| Gate | Status |
|---|---|
| Numeric/DSL unit suite | 17 passing locally |
| Dependency audit | 0 known vulnerabilities after pinned overrides |
| Frontend/backend build | Passed initial build |
| Atlas integration, cloud ingestion | Pending |
| Production browser journeys 01–12 | Pending |
| Artifact hash / public HEAD / production alias | Pending |

No HAR, trace, screenshot containing market rows, database dump, or market payload artifact is permitted. Browser storage is checked by names/counts only. Test evidence is scalar assertions and hashes.

Sources: [UCI](https://archive.ics.uci.edu/dataset/312/dow%2Bjones%2Bindex), [ECB usage policy](https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html), [Vercel Workflow](https://workflow-sdk.dev/docs/getting-started/next). CryptoDataDownload is not imported because public redistribution permission for underlying venue data is not clear enough.
