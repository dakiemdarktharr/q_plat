# Research jobs and progress

Verified on 2026-11-28 against production Vercel and the existing Atlas M0 cluster. No paid service, new cache service, local dataset or data migration is required.

## Pipeline

Previously, the worker recalculated the edge and robustness after every 4,000 persisted points and wrote each point, timeline row and ledger event as a separate MongoDB document. The technology benchmark produced 12,160 result documents and three worker invocations. Atlas documents a 100 operations/second free-cluster limit, making individual result writes expensive under shared load ([official limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/)).

The worker now loads the frozen panel once, computes the edge and robustness once, and groups results by kind and asset into chunks of at most 128 rows and 512 KiB of serialized row content. A date map also replaces repeated full-point filtering when building timeline hashes. Batches of 24 chunks are idempotently upserted with checkpoints. Every stored chunk is read back and its checksum verified before the run becomes ready. Cancel is checked between stages and batches. A resumed invocation skips saved chunks; the exceptional deadline/retry path can still recompute deterministic results.

New runs use `result_chunks`; a storage adapter keeps existing `run_series` / `ledger_events` runs readable. Public bounded windows, traces, cross sections and comparisons retain their numerical meaning. The numerical engine remains `q-engine-1.1.0`. Ledger record IDs for new runs are deterministic opaque IDs; they are not a trading identifier.

## Measured example

Frozen snapshot `wiki_technology-37624ed02d0eeff762fa`, six stocks, 1,508 sessions, 20-day risk-adjusted momentum, 10 bps fees, 5 bps slippage, rebalance every five sessions, robustness enabled. Run hash: `67c6982e38ac64dc30dd884bf9d083a34584ec84253505efe16ffeed07a74dd4`.

| Measurement | Accepted to completed | Worker invocations | Result documents |
| --- | ---: | ---: | ---: |
| Previous single run | 63.117 s | 3 | 12,160 |
| New sequential run 1 | 7.740 s | 1 | 101 |
| New sequential run 2 | 4.275 s | 1 | 101 |
| New sequential run 3 | 3.887 s | 1 | 101 |

These are observed production samples, not an SLA or a controlled cold-start study. No other acceptance jobs ran during the three new measurements. Their median is 4.275 s, 93.2% below the previous single-run sample. The first includes more queue/dispatch time. Shared Atlas/Vercel load and larger research panels can change durations.

The previous run is `19f4311b-f085-41bc-9512-80da01bc1d16`; the new samples are `7a5f6c46-753a-492b-94fb-77c8d436d46a`, `9714cb70-fe57-416b-ac5e-eaac099c6fa4`, and `3daf686b-8041-4400-aae6-197a00078d02`. An Atlas aggregation compared all four: metrics, diagnostic summaries, robustness output and run hashes were exactly equal. Only scalar evidence is recorded here.

A second sequential batch after the cancellation UI fix measured 8.382 / 4.693 / 3.920 seconds, again one invocation and 101 chunks each. Its run IDs are `ac22fc4c-2ef0-445a-9e43-2603a3295373`, `1337235f-b62b-4c42-a0b7-cc7701b5a5a1`, and `54a771a5-e6b0-4456-a372-970f97941be8`. This batch also completed the entire progress interaction suite.

## Progress contract

The editor and Runs show a native progress bar, current stage, percentage and elapsed time. The server persists progress and the browser polls every second while visible, every four seconds while hidden. Reload reconnects to the active job in the current workspace. Network failures retry polling. Workspace changes invalidate previous polling callbacks.

| Stage | Progress |
| --- | ---: |
| Queued | 0% |
| Loading data | 3% |
| Calculating edge | 15% |
| Testing robustness / preparing results | 35% |
| Saving results | 55–95%, based on confirmed chunks |
| Verifying results | 97% |
| Verified and committed | 100% |

These percentages describe weighted work stages, not elapsed-time interpolation or a completion-time forecast. They never count upward because time passed. Within a job, retry cannot reduce the persisted percentage. A manual retry creates a new job beginning at zero. Cancelled/failed jobs never reach 100%; elapsed time freezes at the terminal timestamp. Legacy jobs without a measurable checkpoint use indeterminate progress.

REST and MCP `job_status` expose the identical `progress` object. `pipeline.timings` in the completed report records loading, calculation, robustness, preparation, writes and verification for diagnosing future regressions.

## Reproduction

`npm test` exercises chunk boundaries, hashes, missing/duplicate/tampered chunks, decision-date reads, reference-only research and terminal progress states with generated fixtures. `node scripts/admin.mjs verify` runs actual Atlas parity/readback and partial-write recovery checks in cloud. `node scripts/performance-e2e.mjs` runs three sequential real-equity measurements and checks reload, mobile layout, cancellation, retry, Runs tracking and the official MCP client. `node scripts/e2e.mjs` and `node scripts/ai-e2e.mjs` cover the existing research and AI journeys. Browser contexts and returned payloads are ephemeral; no screenshot, trace, HAR or dataset is written to disk.

## Acceptance evidence

Application revision `2b8483c306b8f99896668b7dba693119657e8587`, production deployment `dpl_5ZVe3PUyKEjXULwzC5NDzhEJoV9E`:

- 33 unit tests passed; GitHub CI build, dependency audit and production source/download checks passed.
- Seven progress/performance assertions passed, including real cancellation `9346e99a-a01b-442b-8f23-ab99a3f5439c` and successful retry `eb5fb6df-7bbf-4268-b8aa-0032a8a7cfb3`.
- All 20 existing research UI checks passed, including a 1,200-session synthetic robustness run and a 3,842-session reference-rate run through the new storage adapter.
- All eight AI checks passed, including official HTTP/stdio MCP clients, scope enforcement, revocation, workspace isolation and mobile controls.
- Visual inspection of actual queued/completed frames passed on desktop and at 390px. Browser storage counts were zero, with no page errors. Vercel error/fatal logs were empty during verification.
- Actual Atlas cloud verification record `e288477e-d4ae-4f1d-9cf5-b68328171a01` contains 23 passed checks and zero failures. This ran on pipeline revision `f231f7d16a0c45da13ebefbc1e786f8d58f1fce0`; subsequent application edits only refined frontend tracking/cancellation. It includes chunk/legacy parity, partial-write recovery, independent ledger arithmetic and readback of all 13 ready snapshots.

Verified HTML SHA-256: `665db797dd69e26b8a42cf6d4998224f4df42ad424dbdc7f53d44a9d0d70654a`. Later documentation-only release commits retain these application bytes; `scripts/release-check.mjs --wait` verifies the current HEAD against the production health endpoint, public GitHub source and download attachment.
