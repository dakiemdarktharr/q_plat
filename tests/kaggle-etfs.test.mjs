import test from "node:test";
import assert from "node:assert/strict";
import {
  buildKaggleEtfCandidates,
  ETF_OBJECTIVES,
  KAGGLE_ETF_COUNT,
  KAGGLE_ETF_SOURCE,
  kaggleEtfPanelMeta,
  parseKaggleEtfCsv,
  screenKaggleEtfCsv,
} from "../lib/kaggle-etfs.mjs";
import { kaggleFileDownloadUrl } from "../lib/kaggle-download.mjs";
import {
  isKaggleEtfSession,
  KAGGLE_ETF_SESSIONS,
} from "../lib/etf-calendar.mjs";

function syntheticCsv(sessions = KAGGLE_ETF_SESSIONS) {
  return [
    "Date,Open,High,Low,Close,Adj Close,Volume,Note",
    ...sessions.map(
      (date) => `${date},100,102,99,101,95.95,4000,"fixture, row"`,
    ),
  ].join("\n");
}

test("ETF calendar pins the requested interval and recognizes NYSE closures", () => {
  assert.equal(KAGGLE_ETF_SESSIONS.length, 1321);
  assert.equal(KAGGLE_ETF_SESSIONS[0], "2015-01-02");
  assert.equal(KAGGLE_ETF_SESSIONS.at(-1), "2020-04-01");
  for (const date of [
    "2015-01-01",
    "2017-01-02",
    "2018-12-05",
    "2019-07-04",
    "2020-01-01",
  ])
    assert.equal(isKaggleEtfSession(date), false, date);
  assert.equal(isKaggleEtfSession("2019-11-29"), true);
});

test("Yahoo CSV normalization adjusts OHLC, retains raw audit values and timestamps", () => {
  const parsed = parseKaggleEtfCsv(syntheticCsv(), "FIXTURE");
  assert.equal(parsed.rows.length, 1321);
  assert.ok(Math.abs(parsed.rows[0].open - 95) < 1e-12);
  assert.ok(Math.abs(parsed.rows[0].close - 95.95) < 1e-12);
  assert.equal(parsed.rows[0].sourceClose, 101);
  assert.ok(Math.abs(parsed.rows[0].adjustmentFactor - 0.95) < 1e-12);
  assert.equal(parsed.rows[0].volume, 4000);
  assert.equal(parsed.rows[0].openAt, "2015-01-02T14:30:00Z");
  assert.equal(
    parsed.rows.find((row) => row.date === "2015-07-06").openAt,
    "2015-07-06T13:30:00Z",
  );
  assert.equal(parsed.quality.coverage, 1);
  assert.equal(parsed.quality.medianDollarVolume, 404000);
});

test("ETF quality gates reject thin histories, illiquid assets, invalid dates and bad order", () => {
  const short = KAGGLE_ETF_SESSIONS.slice(0, 1200);
  assert.throws(
    () => parseKaggleEtfCsv(syntheticCsv(short), "SHORT"),
    /coverage/,
  );
  assert.throws(
    () => parseKaggleEtfCsv(syntheticCsv().replaceAll(",4000,", ",1,"), "THIN"),
    /liquidity/,
  );
  assert.throws(
    () =>
      screenKaggleEtfCsv(syntheticCsv().replaceAll(",4000,", ",0,"), "ZERO"),
    (error) => /volume/.test(error.message) && error.unsuitable === true,
  );
  const records = syntheticCsv().split("\n");
  [records[1], records[2]] = [records[2], records[1]];
  assert.throws(() => parseKaggleEtfCsv(records.join("\n"), "ORDER"), /order/);
  assert.throws(
    () =>
      parseKaggleEtfCsv(
        syntheticCsv().replace("2015-01-02", "2015-01-03"),
        "HOLIDAY",
      ),
    /calendar/,
  );
});

test("candidate metadata removes duplicate and leveraged products before screening", () => {
  const candidates = buildKaggleEtfCandidates([
    { name: "etfs/SPY.csv", totalBytes: 500000 },
    { name: "etfs/SPY.csv", totalBytes: 450000 },
    { name: "etfs/QQQ.csv", totalBytes: 400000 },
    { name: "etfs/TQQQ.csv", totalBytes: 700000 },
    { name: "stocks/MSFT.csv", totalBytes: 900000 },
    { name: "etfs/TINY.csv", totalBytes: 10 },
  ]);
  assert.deepEqual(
    candidates.map((item) => item.symbol),
    ["SPY", "QQQ"],
  );
});

test("Kaggle file download uses the RPC and only accepts signed Google Storage redirects", async () => {
  let request;
  const target =
    "https://storage.googleapis.com/archive/etfs/CEF.csv.zip?sig=private";
  const url = await kaggleFileDownloadUrl(
    { name: "etfs/CEF.csv", totalBytes: 736212 },
    async (input, init) => {
      request = { input: String(input), init };
      return new Response(null, {
        status: 302,
        headers: { location: target },
      });
    },
  );
  assert.equal(
    request.input,
    "https://api.kaggle.com/v1/datasets.DatasetApiService/DownloadDataset",
  );
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.redirect, "manual");
  assert.deepEqual(JSON.parse(request.init.body), {
    ownerSlug: "jacksoncrow",
    datasetSlug: "stock-market-dataset",
    fileName: "etfs/CEF.csv",
    datasetVersionNumber: 2,
  });
  assert.equal(url.hostname, "storage.googleapis.com");
  await assert.rejects(
    kaggleFileDownloadUrl(
      { name: "etfs/CEF.csv" },
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.invalid/file.csv" },
        }),
    ),
    /unapproved storage redirect/,
  );
});

test("seventy panel records split evenly across seven research objectives", () => {
  assert.equal(ETF_OBJECTIVES.length, 7);
  const panels = Array.from({ length: KAGGLE_ETF_COUNT }, (_, index) =>
    kaggleEtfPanelMeta(
      index,
      Array.from({ length: 6 }, (_, asset) => `T${index}_${asset}`),
    ),
  );
  assert.equal(new Set(panels.map((panel) => panel.id)).size, 70);
  assert.deepEqual(
    Object.fromEntries(
      ETF_OBJECTIVES.map((objective) => [
        objective.id,
        panels.filter((panel) => panel.objectiveId === objective.id).length,
      ]),
    ),
    Object.fromEntries(ETF_OBJECTIVES.map((objective) => [objective.id, 10])),
  );
  assert.ok(panels.every((panel) => panel.symbols.length === 6));
  assert.equal(KAGGLE_ETF_SOURCE.reality, "Real");
  assert.match(
    KAGGLE_ETF_SOURCE.limitation || KAGGLE_ETF_SOURCE.limitations,
    /survivorship/,
  );
});
