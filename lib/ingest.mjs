import { Unzip, UnzipInflate, strFromU8 } from "fflate";
import { CATALOG } from "./catalog.mjs";
import { rng } from "./metrics.mjs";
import { hash, bulkUpsert } from "./db.mjs";
import { EQUITY_BUNDLE, EQUITY_CATALOG } from "./equity-catalog.mjs";
import {
  buildWikiCohortPlan,
  constituentSourceHash,
  parseConstituentsCsv,
  selectEligibleConstituents,
  SP500_CONSTITUENTS_URL,
  WIKI_COHORT_BUNDLE,
  WIKI_COHORT_COUNT,
  WIKI_COHORT_PLAN_ID,
} from "./wiki-cohorts.mjs";
import { readEquityArchive, auditEquityPanel } from "./equities.mjs";
import { EQUITY_AUDIT_VERSION } from "./equity-calendar.mjs";
export function csv(text) {
  const lines = [];
  let row = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((x) => x !== "")) lines.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) throw new Error("Unterminated CSV quote.");
  if (field || row.length) {
    row.push(field);
    lines.push(row);
  }
  if (!lines.length) return [];
  const headers = lines.shift().map((x) => x.replace(/^\uFEFF/, "").trim());
  return lines.map((r) =>
    Object.fromEntries(headers.map((h, i) => [h, r[i]?.trim() ?? ""])),
  );
}
const dateISO = (d) => d.toISOString().slice(0, 10);
export function parseUCI(text) {
  return csv(text).map((r) => {
    if (!r.stock || !r.date) throw new Error("Unexpected UCI schema.");
    const [m, d, y] = r.date.split("/").map(Number),
      date = dateISO(new Date(Date.UTC(y, m - 1, d))),
      weekOpen = new Date(date + "T14:30:00Z");
    weekOpen.setUTCDate(
      weekOpen.getUTCDate() - ((weekOpen.getUTCDay() + 6) % 7),
    );
    const row = {
      asset: r.stock,
      date,
      availableAt: date + "T23:59:00Z",
      openAt: weekOpen.toISOString(),
      group: "UCI sample",
    };
    for (const f of ["open", "high", "low", "close", "volume"]) {
      const n = Number(r[f]?.replace(/[$,]/g, ""));
      if (!Number.isFinite(n) || n < 0)
        throw new Error("Invalid UCI numeric field.");
      row[f] = n;
    }
    // Deliberately never copy next-week, dividend, percent-return or unknown source fields.
    return row;
  });
}
export function parseECB(text) {
  return csv(text)
    .filter((r) => r.OBS_VALUE !== "" && r.OBS_VALUE !== undefined)
    .map((r) => {
      const asset = r.CURRENCY,
        date = r.TIME_PERIOD,
        close = Number(r.OBS_VALUE);
      if (
        !["USD", "GBP", "JPY", "CHF", "CAD", "AUD"].includes(asset) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !(close > 0)
      )
        throw new Error("Unexpected ECB schema.");
      return {
        asset,
        date,
        close,
        availableAt: new Date(
          Date.parse(date + "T00:00:00Z") + 86400000,
        ).toISOString(),
        observationStatus: r.OBS_STATUS || null,
      };
    });
}
export function synthetic(seed = 271828, sessions = 1200, assets = 28) {
  const random = rng(seed),
    rows = [],
    prices = Array.from({ length: assets }, (_, a) => 40 + a * 4),
    prev = Array(assets).fill(0);
  let date = new Date("2018-01-01T00:00:00Z");
  for (let t = 0; t < sessions; t++) {
    while ([0, 6].includes(date.getUTCDay()))
      date.setUTCDate(date.getUTCDate() + 1);
    const day = dateISO(date),
      regime = Math.floor(t / 200) % 3,
      market = (random() - 0.5) * 0.016;
    for (let a = 0; a < assets; a++) {
      const innovation = (random() - 0.5) * 0.035,
        trend =
          regime === 0 ? 0.12 * prev[a] : regime === 1 ? -0.08 * prev[a] : 0,
        open = prices[a] * (1 + (random() - 0.5) * 0.006),
        ret = market + innovation + trend + 0.00015,
        close = open * (1 + ret),
        spread = random() * 0.014;
      prices[a] = close;
      prev[a] = ret;
      if ((a === assets - 1 && t < 200) || (t + a * 11) % 137 === 0) continue;
      rows.push({
        asset: `S${String(a + 1).padStart(2, "0")}`,
        date: day,
        openAt: day + "T14:30:00Z",
        availableAt: day + "T21:01:00Z",
        open,
        high: Math.max(open, close) * (1 + spread),
        low: Math.min(open, close) * (1 - spread),
        close,
        volume: (t + a) % 97 === 0 ? 0 : Math.floor(100000 + random() * 900000),
        group: `Sector ${(a % 4) + 1}`,
        regime,
      });
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return rows;
}
export function corporateActionFixture() {
  return {
    name: "Synthetic split fixture",
    splitRatio: 2,
    rawBefore: 100,
    rawAfter: 50,
    sharesBefore: 100,
    sharesAfter: 200,
    navBefore: 10000,
    navAfter: 10000,
    adjustment: "Separate fixture; not mixed into research panel.",
  };
}
async function boundedFetch(url, max = 32 * 1024 * 1024) {
  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(90000),
    redirect: "error",
    headers: { Accept: "text/csv, application/zip, */*" },
  });
  if (!res.ok) throw new Error(`Publisher returned HTTP ${res.status}`);
  let size = 0;
  const chunks = [];
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > max)
      throw new Error("Publisher response exceeded RAM buffer limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function uciZip(buffer) {
  let output = null,
    total = 0,
    error = null;
  const unzip = new Unzip((file) => {
    if (!file.name.endsWith(".data")) return;
    const parts = [];
    file.ondata = (err, data, final) => {
      if (err) {
        error = err;
        return;
      }
      total += data.length;
      if (total > 4 * 1024 * 1024) {
        file.terminate();
        error = new Error("ZIP expanded-size limit.");
        return;
      }
      parts.push(data);
      if (final) output = Buffer.concat(parts);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.push(buffer, true);
  if (error) throw error;
  if (!output) throw new Error("UCI .data member missing.");
  return strFromU8(output);
}
export function canonicalRows(rows) {
  return [...rows]
    .sort(
      (a, b) => a.date.localeCompare(b.date) || a.asset.localeCompare(b.asset),
    )
    .map((r) =>
      Object.fromEntries(
        Object.keys(r)
          .sort()
          .map((k) => [k, r[k]]),
      ),
    );
}
export async function ingest(
  database,
  dataset,
  check = async () => {},
  reportProgress = async () => {},
) {
  if (!process.env.VERCEL_DEPLOYMENT_ID)
    throw new Error(
      "Ingestion is cloud-only. Local dataset downloads are prohibited.",
    );
  if (dataset === WIKI_COHORT_BUNDLE)
    return ingestWikiCohorts(database, check, reportProgress);
  if (dataset === EQUITY_BUNDLE || EQUITY_CATALOG[dataset]) {
    const deadline = Date.now() + 180000;
    const ids =
      dataset === EQUITY_BUNDLE ? Object.keys(EQUITY_CATALOG) : [dataset];
    const ready = await database
      .collection("dataset_versions")
      .find({
        dataset: { $in: ids },
        status: "ready",
        "meta.normalizerVersion": "wiki-panels-1",
        "quantAudit.version": EQUITY_AUDIT_VERSION,
        supersededBy: { $exists: false },
      })
      .toArray();
    const snapshots = [];
    for (const id of ids) {
      const v = ready.find((snapshot) => snapshot.dataset === id);
      if (!v) continue;
      const count = await database
        .collection("bars")
        .countDocuments({ version: v._id });
      if (count !== v.count)
        throw new Error("Equity snapshot readback count mismatch.");
      snapshots.push({
        dataset: id,
        version: v._id,
        count,
        checksum: v.checksum,
      });
    }
    if (ids.every((id) => ready.some((v) => v.dataset === id))) {
      return { datasets: snapshots.length, snapshots, idempotent: true };
    }
    const remainingIds = ids.filter(
      (id) => !ready.some((snapshot) => snapshot.dataset === id),
    );
    const readyCount = snapshots.length;
    const { groups, rejected, sourceArtifact } = await readEquityArchive(
      check,
      reportProgress,
      remainingIds,
    );
    const audits = Object.fromEntries(
      remainingIds.map((id) => [
        id,
        auditEquityPanel(groups[id], EQUITY_CATALOG[id], rejected[id]),
      ]),
    );
    for (const [panelIndex, id] of remainingIds.entries()) {
      await check();
      const meta = EQUITY_CATALOG[id],
        startPercent = 40 + (50 * (readyCount + panelIndex)) / ids.length,
        endPercent = 40 + (50 * (readyCount + panelIndex + 1)) / ids.length;
      const snapshot = await persistSnapshot(
        database,
        id,
        groups[id],
        check,
        { sourceArtifact, quantAudit: audits[id] },
        100000,
        deadline,
        (percent, completed, total) =>
          reportProgress("Saving " + meta.sector, percent, {
            completed: readyCount + panelIndex + completed / Math.max(1, total),
            total: ids.length,
          }),
        [startPercent, endPercent],
      );
      if (snapshot.status === "continue") {
        const fraction = snapshot.checkpoint / Math.max(1, snapshot.total);
        return {
          ...snapshot,
          datasets: ids.length,
          completed: readyCount + panelIndex,
          percent: startPercent + (endPercent - startPercent) * fraction,
          stage: "Saving " + meta.sector,
        };
      }
      snapshots.push({
        dataset: id,
        ...snapshot,
      });
      await reportProgress("Verified " + meta.sector, endPercent, {
        completed: readyCount + panelIndex + 1,
        total: ids.length,
      });
      groups[id] = [];
      if (Date.now() >= deadline && snapshots.length < ids.length)
        return {
          status: "continue",
          datasets: ids.length,
          completed: snapshots.length,
          percent: 40 + (50 * snapshots.length) / ids.length,
          stage:
            "Verified " + snapshots.length + " of " + ids.length + " panels",
        };
    }
    return { datasets: snapshots.length, snapshots, idempotent: false };
  }
  const meta = CATALOG[dataset];
  if (!meta) throw new Error("Dataset not in audited source catalog.");
  let rows;
  await reportProgress("Loading " + meta.name, 5, { completed: 0, total: 1 });
  if (dataset === "synthetic") rows = synthetic(meta.seed);
  else {
    const bytes = await boundedFetch(meta.download);
    rows =
      dataset === "uci"
        ? parseUCI(uciZip(bytes))
        : parseECB(bytes.toString("utf8"));
  }
  await reportProgress("Validating " + meta.name, 40, {
    completed: 1,
    total: 1,
  });
  return persistSnapshot(
    database,
    dataset,
    rows,
    check,
    {},
    100000,
    Infinity,
    (percent, completed, total) =>
      reportProgress("Saving " + meta.name, percent, { completed, total }),
    [40, 95],
  );
}

async function readConstituents(check) {
  const response = await fetch(SP500_CONSTITUENTS_URL, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers: { Accept: "text/csv" },
  });
  if (!response.ok)
    throw new Error("Constituent source HTTP " + response.status);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    await check();
    size += chunk.length;
    if (size > 512 * 1024) throw new Error("Constituent source size limit.");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return {
    text,
    constituents: parseConstituentsCsv(text),
    sha256: constituentSourceHash(text),
  };
}

function candidateUniverse(constituents) {
  return new Map(
    constituents.map((item) => [
      item.symbol,
      {
        id: item.symbol,
        sector: item.sector,
        subIndustry: item.subIndustry,
        from: "2012-01-01",
        to: "2017-12-31",
      },
    ]),
  );
}

async function createWikiCohortPlan(database, check, reportProgress) {
  const existing = await database
    .collection("dataset_ingest_plans")
    .findOne({ _id: WIKI_COHORT_PLAN_ID });
  if (existing?.panels?.length === WIKI_COHORT_COUNT) return existing;

  await reportProgress("Loading the open S&P constituent metadata", 2, {
    completed: 0,
    total: WIKI_COHORT_COUNT,
  });
  const source = await readConstituents(check);
  const universe = candidateUniverse(source.constituents);
  await reportProgress("Screening historical stock coverage in cloud", 4, {
    completed: 0,
    total: universe.size,
  });
  const scan = await readEquityArchive(
    check,
    (stage, percent, counts) =>
      reportProgress(stage, 4 + Math.min(20, (percent || 0) / 2), {
        completed: counts.completed,
        total: counts.total,
      }),
    [...universe.keys()],
    { universe, scanOnly: true },
  );
  const eligible = selectEligibleConstituents(
    source.constituents,
    scan.universeStats,
  );
  const panels = buildWikiCohortPlan(eligible, {
    count: WIKI_COHORT_COUNT,
    existing: Object.values(EQUITY_CATALOG).map((meta) => meta.symbols),
  });
  const panelDocs = panels.map(({ id, meta, members }) => ({
    id,
    meta,
    members: members.map(({ symbol, sector, subIndustry }) => ({
      symbol,
      sector,
      subIndustry,
    })),
  }));
  const plan = {
    _id: WIKI_COHORT_PLAN_ID,
    status: "planned",
    createdAt: new Date().toISOString(),
    dataset: WIKI_COHORT_BUNDLE,
    count: panelDocs.length,
    panels: panelDocs,
    universeScreen: {
      source: SP500_CONSTITUENTS_URL,
      license: "ODC-PDDL-1.0",
      sha256: source.sha256,
      sourceCount: universe.size,
      eligibleCount: eligible.length,
      screenedOutCount: universe.size - eligible.length,
      overlapCount: panels.filter((panel) => panel.meta.overlap).length,
      eligibleSymbolHash: hash(eligible.map((item) => item.symbol).sort()),
      requiredCoverage: 0.97,
      minimumBars: 1400,
      maxRejectedRatio: 0.005,
      largeMovesAllowed: 0,
      orderingErrorsAllowed: 0,
      screenedAt: new Date().toISOString(),
    },
    sourceArtifact: scan.sourceArtifact,
  };
  await database
    .collection("dataset_ingest_plans")
    .updateOne(
      { _id: WIKI_COHORT_PLAN_ID },
      { $setOnInsert: plan },
      { upsert: true },
    );
  await reportProgress("Source screen passed; plan saved", 25, {
    completed: 0,
    total: WIKI_COHORT_COUNT,
  });
  const saved = await database
    .collection("dataset_ingest_plans")
    .findOne({ _id: WIKI_COHORT_PLAN_ID });
  if (saved?.panels?.length !== WIKI_COHORT_COUNT)
    throw new Error("Cohort plan was not durably saved.");
  return { ...saved, createdNow: true };
}

async function ingestWikiCohorts(database, check, reportProgress) {
  const deadline = Date.now() + 270000;
  const plan = await createWikiCohortPlan(database, check, reportProgress);
  if (plan.createdNow)
    return {
      status: "continue",
      datasets: WIKI_COHORT_COUNT,
      completed: 0,
      percent: 25,
      stage: "Historical screen saved; starting import",
    };
  const ids = plan.panels.map((panel) => panel.id);
  const ready = await database
    .collection("dataset_versions")
    .find({
      dataset: { $in: ids },
      status: "ready",
      "meta.normalizerVersion": "wiki-sp500-cohorts-1",
      "quantAudit.version": EQUITY_AUDIT_VERSION,
      supersededBy: { $exists: false },
    })
    .toArray();
  for (const version of ready) {
    const count = await database
      .collection("bars")
      .countDocuments({ version: version._id });
    if (count !== version.count)
      throw new Error("Cohort snapshot readback count mismatch.");
  }
  if (ids.every((id) => ready.some((version) => version.dataset === id)))
    return {
      datasets: ids.length,
      snapshots: ready.map((version) => ({
        dataset: version.dataset,
        version: version._id,
        count: version.count,
        checksum: version.checksum,
      })),
      idempotent: true,
    };

  const completedIds = new Set(ready.map((version) => version.dataset));
  const remaining = plan.panels.filter((panel) => !completedIds.has(panel.id));
  const remainingIds = remaining.map((panel) => panel.id);
  const assignments = new Map();
  const panelMetadata = new Map(
    remaining.map((panel) => [panel.id, panel.meta]),
  );
  const universe = new Map();
  for (const panel of remaining) {
    for (const member of panel.members) {
      if (!universe.has(member.symbol))
        universe.set(member.symbol, {
          id: member.symbol,
          sector: member.sector,
          subIndustry: member.subIndustry,
          from: "2012-01-01",
          to: "2017-12-31",
        });
      const targets = assignments.get(member.symbol) || [];
      targets.push(panel.id);
      assignments.set(member.symbol, targets);
    }
  }
  const archive = await readEquityArchive(
    check,
    (stage, percent, counts) =>
      reportProgress(stage, 25 + Math.min(20, (percent || 0) / 2), counts),
    remainingIds,
    { universe, assignments, panelMetadata },
  );
  if (archive.sourceArtifact.sha256 !== plan.sourceArtifact.sha256)
    throw new Error("Pinned WIKI source checksum changed after screening.");

  const snapshots = ready.map((version) => ({
    dataset: version.dataset,
    version: version._id,
    count: version.count,
    checksum: version.checksum,
  }));
  for (const [index, panel] of remaining.entries()) {
    await check();
    const rows = archive.groups[panel.id];
    const audit = auditEquityPanel(
      rows,
      panel.meta,
      archive.rejected[panel.id],
    );
    const startPercent = 45 + (50 * (completedIds.size + index)) / ids.length;
    const endPercent = 45 + (50 * (completedIds.size + index + 1)) / ids.length;
    const snapshot = await persistSnapshot(
      database,
      panel.id,
      rows,
      check,
      {
        sourceArtifact: archive.sourceArtifact,
        constituentSource: {
          url: plan.universeScreen.source,
          license: plan.universeScreen.license,
          sha256: plan.universeScreen.sha256,
          screenedAt: plan.universeScreen.screenedAt,
        },
        universeScreen: plan.universeScreen,
        quantAudit: audit,
      },
      100000,
      deadline,
      (percent, completed, total) =>
        reportProgress("Saving " + panel.meta.name, percent, {
          completed: completedIds.size + index + completed / Math.max(1, total),
          total: ids.length,
        }),
      [startPercent, endPercent],
      panel.meta,
    );
    if (snapshot.status === "continue")
      return {
        ...snapshot,
        status: "continue",
        datasets: ids.length,
        completed: completedIds.size + index,
        percent:
          startPercent +
          (endPercent - startPercent) *
            (snapshot.checkpoint / Math.max(1, snapshot.total)),
        stage: "Saving " + panel.meta.name,
      };
    snapshots.push({ dataset: panel.id, ...snapshot });
    await reportProgress("Verified " + panel.meta.name, endPercent, {
      completed: completedIds.size + index + 1,
      total: ids.length,
    });
    archive.groups[panel.id] = [];
    if (Date.now() >= deadline && completedIds.size + index + 1 < ids.length)
      return {
        status: "continue",
        datasets: ids.length,
        completed: completedIds.size + index + 1,
        percent: endPercent,
        stage: `Verified ${completedIds.size + index + 1} of ${ids.length} cohorts`,
      };
  }
  await database.collection("dataset_ingest_plans").updateOne(
    { _id: WIKI_COHORT_PLAN_ID },
    {
      $set: {
        status: "complete",
        completedAt: new Date().toISOString(),
        importedCount: snapshots.length,
        snapshotIds: snapshots.map((snapshot) => snapshot.version),
      },
    },
  );
  return { datasets: snapshots.length, snapshots, idempotent: false };
}

async function persistSnapshot(
  database,
  dataset,
  input,
  check,
  provenance = {},
  batchLimit = 4000,
  deadline = Infinity,
  reportProgress,
  progressRange = [45, 95],
  metaOverride = null,
) {
  const meta = metaOverride || CATALOG[dataset],
    rows = canonicalRows(input);
  if (!meta) throw new Error("Dataset metadata is missing.");
  const checksum = hash(rows),
    version = `${dataset}-${checksum.slice(0, 20)}`;
  const exists = await database
    .collection("dataset_versions")
    .findOne({ _id: version, status: "ready" });
  if (exists) {
    const count = await database.collection("bars").countDocuments({ version });
    if (count !== exists.count)
      throw new Error("Existing snapshot count mismatch.");
    if (
      provenance.quantAudit &&
      exists.quantAudit?.version !== provenance.quantAudit.version
    ) {
      const readback = await database
        .collection("bars")
        .find({ version }, { projection: { _id: 0, version: 0 } })
        .toArray();
      if (hash(canonicalRows(readback)) !== checksum)
        throw new Error("Audit upgrade readback checksum mismatch.");
      // Append independent validation evidence; immutable observations/hash are unchanged.
      await database.collection("dataset_versions").updateOne(
        { _id: version },
        {
          $set: { quantAudit: provenance.quantAudit },
          $push: {
            auditHistory: {
              version: provenance.quantAudit.version,
              verifiedAt: new Date().toISOString(),
            },
          },
        },
      );
    }
    await reportProgress?.(progressRange[1], rows.length, rows.length);
    return { version, count, checksum, idempotent: true };
  }
  if (EQUITY_CATALOG[dataset])
    await database.collection("dataset_versions").updateMany(
      {
        dataset,
        status: "ready",
        _id: { $ne: version },
        supersededBy: { $exists: false },
      },
      {
        $set: {
          supersededBy: version,
          supersededReason:
            "Corrected source calendar validation; original snapshot retained for reproducibility.",
        },
      },
    );
  const keys = new Set(rows.map((r) => r.asset + "|" + r.date)),
    assets = [...new Set(rows.map((r) => r.asset))].sort(),
    dates = [...new Set(rows.map((r) => r.date))].sort();
  if (keys.size !== rows.length)
    throw new Error("Duplicate publisher observation.");
  if (dataset === "uci" && (rows.length !== 750 || assets.length !== 30))
    throw new Error("UCI count contract changed.");
  if (dataset === "ecb" && (assets.length !== 6 || dates.length < 3500))
    throw new Error("ECB coverage contract failed.");
  for (const r of rows)
    if (
      meta.kind === "ohlcv" &&
      (!(r.low <= Math.min(r.open, r.close)) ||
        !(r.high >= Math.max(r.open, r.close)))
    )
      throw new Error("OHLC invariant failed.");
  const now = new Date().toISOString();
  await database.collection("dataset_versions").updateOne(
    { _id: version },
    {
      $setOnInsert: {
        dataset,
        status: "staging",
        createdAt: now,
        schemaVersion: 1,
        checksum,
        meta,
        ...provenance,
      },
    },
    { upsert: true },
  );
  const staged = await database
    .collection("dataset_versions")
    .findOne({ _id: version });
  const start = staged.checkpoint || 0,
    end = Math.min(rows.length, start + batchLimit);
  // These six-asset daily panels are about 9k rows. Keep one panel in one
  // idempotent Atlas bulk write so workflow continuations do not pay for five
  // relay round-trips and five checkpoints per snapshot.
  const writeBatchSize = 10000;
  for (let i = start; i < end; i += writeBatchSize) {
    await check();
    await bulkUpsert(
      database.collection("bars"),
      rows
        .slice(i, Math.min(i + writeBatchSize, end))
        .map((r) => ({ ...r, version })),
      ["version", "asset", "date"],
      writeBatchSize,
    );
    const checkpoint = Math.min(i + writeBatchSize, end);
    await database
      .collection("dataset_versions")
      .updateOne({ _id: version, status: "staging" }, { $max: { checkpoint } });
    const percent =
      progressRange[0] +
      ((progressRange[1] - progressRange[0]) * checkpoint) /
        Math.max(1, rows.length);
    await reportProgress?.(percent, checkpoint, rows.length);
    if (Date.now() >= deadline && checkpoint < rows.length)
      return {
        status: "continue",
        version,
        checkpoint,
        total: rows.length,
      };
  }
  if (end < rows.length)
    return { status: "continue", version, checkpoint: end, total: rows.length };
  await check();
  const count = await database.collection("bars").countDocuments({ version });
  if (count !== rows.length)
    throw new Error("Snapshot readback count mismatch.");
  const readback = await database
    .collection("bars")
    .find({ version }, { projection: { _id: 0, version: 0 } })
    .sort({ date: 1, asset: 1 })
    .toArray();
  if (hash(canonicalRows(readback)) !== checksum)
    throw new Error("Snapshot readback checksum mismatch.");
  const quality = {
    duplicates: 0,
    missingRows: assets.length * dates.length - count,
    coverage: count / (assets.length * dates.length),
    zeroVolume: rows.filter((r) => r.volume === 0).length,
    fields: Object.fromEntries(
      meta.fields.map((f) => [
        f,
        {
          type: "number",
          unit: meta.units[f],
          missing: rows.filter((r) => !Number.isFinite(r[f])).length,
        },
      ]),
    ),
  };
  await database.collection("dataset_versions").updateOne(
    { _id: version },
    {
      $set: {
        ...provenance,
        status: "ready",
        count,
        assets,
        from: dates[0],
        to: dates.at(-1),
        sessions: dates.length,
        quality,
        retrievedAt: now,
        readyAt: new Date().toISOString(),
        fixture: dataset === "synthetic" ? corporateActionFixture() : null,
      },
    },
  );
  await database
    .collection("datasets")
    .updateOne(
      { _id: dataset },
      { $set: { currentVersion: version, ...meta } },
      { upsert: true },
    );
  return { version, count, checksum, idempotent: false };
}
