import test from "node:test";
import assert from "node:assert/strict";
import {
  equityHeader,
  parseEquityLine,
  auditEquityPanel,
  readEquityArchive,
} from "../lib/equities.mjs";
import { EQUITY_CATALOG } from "../lib/equity-catalog.mjs";
const header = equityHeader(
  "ticker,date,open,high,low,close,volume,ex-dividend,split_ratio,adj_open,adj_high,adj_low,adj_close,adj_volume",
);
const line = (date, adjOpen = 50) =>
  `AAPL,${date},100,110,90,104,1000,1,2,${adjOpen},55,45,52,2000`;

test("equity normalization preserves audit fields, adjusted units and DST timestamps", () => {
  const winter = parseEquityLine(line("2014-01-06"), header).row;
  const summer = parseEquityLine(line("2014-07-07"), header).row;
  assert.equal(winter.openAt, "2014-01-06T14:30:00Z");
  assert.equal(summer.openAt, "2014-07-07T13:30:00Z");
  assert.equal(winter.availableAt, "2014-01-06T23:59:59Z");
  assert.equal(winter.close, 52);
  assert.equal(winter.rawClose, 104);
  assert.equal(winter.volume, 2000);
  assert.equal(winter.rawVolume, 1000);
  assert.equal(winter.cashDividend, 1);
  assert.equal(winter.splitRatio, 2);
  assert.equal(winter.adjustmentFactor, 0.5);
});
test("equity importer rejects malformed bars and unexplained adjustment mismatch", () => {
  assert.throws(() => equityHeader("date,close"), /schema/);
  assert.throws(
    () => parseEquityLine(line("2014-01-06", 51), header),
    /adjustment/,
  );
  assert.throws(
    () => parseEquityLine(line("2014-01-06").replace(",1000,", ",-1,"), header),
    /OHLCV/,
  );
  assert.throws(
    () => parseEquityLine(line("2014-01-06").replace(",1000,", ",,"), header),
    /Missing/,
  );
  assert.equal(parseEquityLine(line("2018-01-06"), header), null);
});
test("equity panels are distinct fixed universes; quality gates reject thin or duplicate data", () => {
  const metas = Object.values(EQUITY_CATALOG);
  assert.equal(metas.length, 10);
  assert.equal(new Set(metas.flatMap((m) => m.symbols)).size, 60);
  const row = parseEquityLine(line("2014-01-06"), header).row;
  assert.throws(() => auditEquityPanel([row], metas[0]), /coverage/);
  assert.throws(() => auditEquityPanel([row, row], metas[0]), /Duplicate/);
});
test("equity archive refuses to download in a local process", async () => {
  if (!process.env.VERCEL_DEPLOYMENT_ID)
    await assert.rejects(readEquityArchive(), /cloud-only/);
});
