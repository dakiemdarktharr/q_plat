# qtpatuti interaction redesign

Research date: 2026-11-27. Scope: preserve the research engine, snapshots and private workspace history; redesign the single HTML frontend and add AI access. No paid subscriptions were started.

## Evidence boundary

The reference analysis below comes from the linked official public documentation and published descriptions. It is **not** a claim of hands-on access to every authenticated product. The browser-control channel stopped because it could not reliably identify Chrome's URL. WorldQuant BRAIN's public application returned a JavaScript shell; no private simulation screen was inspected. Portfolio123's subscription tools were not accessed. vectorbt, Qlib and NautilusTrader are libraries/frameworks, not equivalent hosted dashboards. “Frame” below means a discrete workflow state, not a measured video frame. No animation timing or inaccessible interaction is invented.

| Reference | Documented state/action sequence | Applied to qtpatuti |
|---|---|---|
| [vectorbt](https://vectorbt.dev/api/portfolio/base/) | Construct portfolio → request selected subplots → inspect returns/trades/drawdown → revise inputs → regenerate output | Keep code editable beside charts; expose only needed panels. Do not expose a notebook setup step to first-time visitors. |
| [WorldQuant BRAIN / Learn2Quant](https://www.worldquant.com/learn2quant/) | Form an alpha idea → express a signal → simulate → review risk/holding assumptions → revise | An editable example and one Run action start the investigation. No leaderboard, submission score or claimed profit is used as a reward. The authenticated editor's precise click behavior remains unverified. |
| [Portfolio123](https://www.portfolio123.com/) | Select universe/ranking approach → define buy/sell rules → simulate → inspect results → change rules | Collapse execution/universe settings under one disclosure; preserve custom formulas and explicit fees. Exact wizard transitions were not observed. |
| [Microsoft Qlib reports](https://qlib.readthedocs.io/en/latest/component/report.html) | Produce a prediction/portfolio record → select performance or signal-analysis graph → inspect IC/rank-label diagnostics → compare experiment | Separate Overview from Signal and Robustness. Keep diagnostic quantile paths distinct from account NAV; do not import Qlib's accumulation conventions into this engine. |
| [QuantConnect LEAN results](https://www.quantconnect.com/docs/v2/cloud-platform/backtesting/results) | Open result → choose chart/series → zoom linked time range → inspect order → open order events → inspect logs/results | Shared chart window, optional layers, first-class Trace tab and recoverable job history. Paid asset-plot functionality was only read about, not accessed. |
| [NautilusTrader visualization](https://nautilustrader.io/docs/latest/concepts/visualization/) and [reports](https://nautilustrader.io/docs/latest/concepts/reports/) | Run backtest → render interactive tear sheet → inspect performance → inspect fills/positions → revise | Results have navigable panels and explicit execution evidence. Retain one self-contained frontend; do not download market reports locally. |
| [TradingView strategies](https://www.tradingview.com/pine-script-docs/concepts/strategies/) | Add strategy to chart → inspect trade markers → open strategy results → change properties → recalculate | Price remains the primary context; signal and execution can be traced by date. No broker connection, paid plan or imitation Pine runtime is added. |

These are design inferences from documented workflows, not a pixel-for-pixel copy or a universal usability ranking.

## Shipped interaction states to verify

| State | Trigger → feedback → next action |
|---|---|
| Boot | Open page → catalog/loading status → real public price window; no fabricated run metrics |
| First experiment | Edit code or choose example → Run → private guest session → durable job accepted → disabled Run with progress → real result |
| Error | Invalid future field/negative lag → line/column message → preserve code → correct and retry |
| Save | Save version → immutable version confirmation → fork/load/diff; save guest workspace to retain access |
| Overview | Completed job → IC/return/drawdown/coverage → NAV and benchmark; red/green only encode financial direction |
| Signal | Select date → Inspect date → ranked cross-section/scatter/IC; click an asset → synchronized chart and source trace |
| Chart | Hover → crosshair/values; wheel/brush → shared window; Reset → full snapshot; layers → volume/feature/exposure |
| Result navigation | Mouse or arrow keys → one selected tab → only its panels visible; Back/Forward restores primary screen |
| Research history | Open Runs → completed runs/jobs → reload or exact rerun → A/B differences |
| AI | Named workspace → choose Read/Research scope → create token → copy once → MCP/API operations → same edges/runs on web → revoke |
| Mobile | 390px viewport → compact navigation → editor first → chart/results below; no horizontal page overflow |
| Local artifact | Open index.html → public bounded data in RAM → private actions point to the same production screen |

Black surfaces, white text, purple actions/signal series, yellow reference/context, green/red price and PnL. Decorative subtitles were removed. Units, attribution, uncertainty and execution assumptions remain available because removing them would make results misleading. No market data is written to local browser storage, screenshots, traces or test reports.

Verification results and exact revisions are recorded in GitHub Actions and the README release section; the checklist itself is not evidence of a passed test.
