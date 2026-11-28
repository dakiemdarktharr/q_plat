import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWikiCohortPlan,
  constituentSourceHash,
  parseConstituentsCsv,
  selectEligibleConstituents,
} from "../lib/wiki-cohorts.mjs";

function fixtureConstituents(count, sectors = 10) {
  return Array.from({ length: count }, (_, index) => ({
    symbol: `Q${String(index).padStart(4, "0")}`,
    sector: `Sector ${String(index % sectors).padStart(2, "0")}`,
    subIndustry: `Industry ${index % 17}`,
  }));
}

test("S&P constituent parser handles quoted commas and requires a complete universe", () => {
  const records = fixtureConstituents(400);
  const lines = [
    "Symbol,Security,GICS Sector,GICS Sub-Industry",
    ...records.map(
      (item, index) =>
        `${item.symbol},"Company ${index}, Inc.","${item.sector}","${item.subIndustry}"`,
    ),
  ];
  const parsed = parseConstituentsCsv(lines.join("\n"));
  assert.equal(parsed.length, 400);
  assert.deepEqual(parsed[0], records[0]);
  assert.equal(constituentSourceHash(lines.join("\n")).length, 64);
  assert.throws(
    () => parseConstituentsCsv(lines.slice(0, 300).join("\n")),
    /incomplete/,
  );
});

test("source screen rejects thin, malformed, out-of-order and unexplained-jump series", () => {
  const constituents = fixtureConstituents(5, 5);
  const baseline = {
    count: 1500,
    rejected: 0,
    largeMoves: 0,
    orderErrors: 0,
  };
  const stats = {
    [constituents[0].symbol]: { ...baseline },
    [constituents[1].symbol]: { ...baseline, count: 1399 },
    [constituents[2].symbol]: { ...baseline, rejected: 8 },
    [constituents[3].symbol]: { ...baseline, largeMoves: 1 },
    [constituents[4].symbol]: { ...baseline, orderErrors: 1 },
  };
  assert.deepEqual(
    selectEligibleConstituents(constituents, stats).map((item) => item.symbol),
    [constituents[0].symbol],
  );
});

test("cohort plan is deterministic, contains six screened stocks per dataset and prefers disjoint panels", () => {
  const eligible = fixtureConstituents(500);
  const first = buildWikiCohortPlan(eligible);
  const second = buildWikiCohortPlan(eligible);
  assert.equal(first.length, 70);
  assert.deepEqual(first, second);
  assert.equal(new Set(first.map((panel) => panel.id)).size, 70);
  assert.ok(first.every((panel) => panel.meta.symbols.length === 6));
  assert.equal(new Set(first.flatMap((panel) => panel.meta.symbols)).size, 420);
  assert.ok(first.every((panel) => panel.meta.reality === "Real"));
});

test("cohort planning reports when the 70-panel contract cannot be satisfied", () => {
  assert.throws(() => buildWikiCohortPlan(fixtureConstituents(5, 1)), /Only 0/);
});
