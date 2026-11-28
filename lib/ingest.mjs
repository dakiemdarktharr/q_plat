import { Unzip, UnzipInflate, strFromU8 } from "fflate";
import { createHash } from "node:crypto";
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
import {
  buildKaggleEtfCandidates,
  KAGGLE_ETF_BUNDLE,
  KAGGLE_ETF_COUNT,
  KAGGLE_ETF_PLAN_ID,
  KAGGLE_ETFS_PER_PANEL,
  KAGGLE_OWNER,
  KAGGLE_SLUG,
  KAGGLE_SOURCE_VERSION,
  kaggleEtfPanelMeta,
  parseKaggleEtfCsv,
} from "./kaggle-etfs.mjs";
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

const kaggleDelay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function kaggleFetch(url, maxBytes, fileRequest = false) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(fileRequest ? 20000 : 15000),
        redirect: "manual",
        headers: {
          Accept: fileRequest
            ? "application/zip, text/csv, */*"
            : "application/json",
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = new URL(response.headers.get("location"), url);
        if (
          !fileRequest ||
          location.protocol !== "https:" ||
          !["storage.googleapis.com", "storage.cloud.google.com"].includes(
            location.hostname,
          )
        )
          throw new Error("Kaggle returned an unapproved redirect.");
        await response.body?.cancel();
        response = await fetch(location, {
          cache: "no-store",
          signal: AbortSignal.timeout(20000),
          redirect: "error",
        });
      }
    } catch (error) {
      lastError = error;
      if (/unapproved redirect/i.test(error.message)) throw error;
      if (attempt === 2) break;
      await kaggleDelay(500 * 2 ** attempt);
      continue;
    }
    if (response.status === 404 && fileRequest) {
      await response.body?.cancel();
      throw Object.assign(new Error("Kaggle file is missing."), {
        unsuitable: true,
      });
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      lastError = new Error(
        `Kaggle temporarily returned HTTP ${response.status}.`,
      );
      if (attempt === 2) break;
      await kaggleDelay(750 * 2 ** attempt);
      continue;
    }
    if (response.status === 401 || response.status === 403)
      throw new Error(
        `Kaggle denied the cloud request (HTTP ${response.status}).`,
      );
    if (!response.ok) {
      await response.body?.cancel();
      if (fileRequest && [400, 410].includes(response.status))
        throw Object.assign(
          new Error(`Kaggle file is unavailable (HTTP ${response.status}).`),
          { unsuitable: true },
        );
      throw new Error(`Kaggle returned HTTP ${response.status}.`);
    }
    const contentType = response.headers.get("content-type") || "";
    if (fileRequest && /text\/html/i.test(contentType)) {
      await response.body?.cancel();
      throw new Error(
        "Kaggle returned an HTML challenge instead of a data file.",
      );
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw Object.assign(
          new Error("Kaggle response exceeded the RAM limit."),
          {
            unsuitable: fileRequest,
          },
        );
      }
      chunks.push(chunk);
    }
    return { buffer: Buffer.concat(chunks), contentType };
  }
  throw Object.assign(
    new Error(
      `Kaggle cloud request did not recover: ${lastError?.name || "network error"}.`,
      { cause: lastError },
    ),
    { retryable: true },
  );
}

async function kaggleJson(url) {
  const { buffer, contentType } = await kaggleFetch(url, 4 * 1024 * 1024);
  if (contentType && !/json/i.test(contentType))
    throw new Error("Kaggle metadata response was not JSON.");
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error("Kaggle returned malformed metadata.");
  }
}

async function kaggleManifest(check, reportProgress) {
  const metadata = await kaggleJson(
    `https://www.kaggle.com/api/v1/datasets/view/${KAGGLE_OWNER}/${KAGGLE_SLUG}`,
  );
  const versions = Array.isArray(metadata.versions) ? metadata.versions : [];
  if (
    !versions.some(
      (version) =>
        Number(version.versionNumber) === KAGGLE_SOURCE_VERSION &&
        version.status === "Ready",
    ) ||
    !/CC0/i.test(metadata.licenseName || "")
  )
    throw new Error("Pinned Kaggle version or CC0 license metadata changed.");

  const files = [];
  let pageToken = "",
    page = 0;
  do {
    await check();
    const url = new URL(
      `https://www.kaggle.com/api/v1/datasets/list/${KAGGLE_OWNER}/${KAGGLE_SLUG}`,
    );
    url.searchParams.set("datasetVersionNumber", String(KAGGLE_SOURCE_VERSION));
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const listing = await kaggleJson(url);
    if (!Array.isArray(listing.datasetFiles))
      throw new Error("Kaggle file manifest changed schema.");
    files.push(...listing.datasetFiles);
    pageToken = listing.nextPageToken || "";
    page++;
    if (page > 100)
      throw new Error("Kaggle file manifest exceeded page limit.");
    if (page === 1 || page % 10 === 0 || !pageToken)
      await reportProgress(
        "Reading the pinned ETF manifest",
        Math.min(4, Math.floor((4 * page) / 12)),
        { completed: page, total: Math.max(page, 12) },
      );
  } while (pageToken);

  const candidates = buildKaggleEtfCandidates(files);
  if (!candidates.length)
    throw new Error("Pinned Kaggle version has no eligible ETF files.");
  return {
    candidates,
    manifestSha256: hash(
      candidates.map(({ name, symbol, totalBytes }) => ({
        name,
        symbol,
        totalBytes,
      })),
    ),
    sourceVersion: KAGGLE_SOURCE_VERSION,
    license: metadata.licenseName,
    fileCount: files.length,
    candidateCount: candidates.length,
  };
}

function extractKaggleCsv(buffer, symbol) {
  if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) return buffer;
  let selected = null,
    expanded = 0,
    matches = 0,
    error = null;
  const unzip = new Unzip((file) => {
    if (file.name.split("/").at(-1).toUpperCase() !== `${symbol}.CSV`) return;
    if (++matches !== 1) {
      error = new Error("Kaggle archive contains duplicate CSV members.");
      return;
    }
    const parts = [];
    file.ondata = (issue, bytes, final) => {
      if (issue || error) {
        error ||= issue;
        return;
      }
      expanded += bytes.length;
      if (expanded > 8 * 1024 * 1024) {
        error = new Error("Kaggle CSV exceeded the expanded-size limit.");
        file.terminate();
        return;
      }
      parts.push(bytes);
      if (final) selected = Buffer.concat(parts);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    unzip.push(buffer, true);
  } catch {
    throw Object.assign(
      new Error("Kaggle download was not a valid CSV archive."),
      {
        unsuitable: true,
      },
    );
  }
  if (error)
    throw Object.assign(new Error("Kaggle CSV archive failed validation."), {
      unsuitable: true,
    });
  if (matches !== 1 || !selected)
    throw Object.assign(
      new Error("Expected ETF CSV was absent from the Kaggle archive."),
      {
        unsuitable: true,
      },
    );
  return selected;
}

async function readKaggleEtf(candidate) {
  const path = candidate.name.split("/").map(encodeURIComponent).join("/"),
    url = new URL(
      `https://www.kaggle.com/api/v1/datasets/download/${KAGGLE_OWNER}/${KAGGLE_SLUG}/${path}`,
    );
  url.searchParams.set("datasetVersionNumber", String(KAGGLE_SOURCE_VERSION));
  const maxBytes = Math.min(
    16 * 1024 * 1024,
    Math.max(2 * 1024 * 1024, candidate.totalBytes * 5 + 512 * 1024),
  );
  const { buffer } = await kaggleFetch(url, maxBytes, true),
    csvBytes = extractKaggleCsv(buffer, candidate.symbol),
    sourceSha256 = createHash("sha256").update(csvBytes).digest("hex"),
    parsed = parseKaggleEtfCsv(strFromU8(csvBytes), candidate.symbol);
  return {
    ...parsed,
    sourceFile: {
      name: candidate.name,
      symbol: candidate.symbol,
      totalBytes: candidate.totalBytes,
      sourceSha256,
      downloadedBytes: buffer.length,
    },
  };
}

function sourceRejectReason(error) {
  const message = String(error?.message || "Invalid source file.");
  if (/coverage/i.test(message)) return "coverage";
  if (/liquidity|dollar volume/i.test(message)) return "liquidity";
  if (/volume/i.test(message)) return "volume";
  if (/move|reconciliation/i.test(message)) return "large_move";
  if (/order|duplicate/i.test(message)) return "date_order";
  if (/calendar|session/i.test(message)) return "calendar";
  if (/field|schema|CSV|archive/i.test(message)) return "schema";
  if (/missing|unavailable|limit/i.test(message)) return "source_file";
  return "invalid_bar";
}

async function ingestKaggleEtfPanels(database, check, reportProgress) {
  const plans = database.collection("dataset_ingest_plans"),
    deadline = Date.now() + 235000;
  let plan = await plans.findOne({ _id: KAGGLE_ETF_PLAN_ID });
  if (!plan) {
    const manifest = await kaggleManifest(check, reportProgress);
    if (manifest.candidateCount < KAGGLE_ETF_COUNT * KAGGLE_ETFS_PER_PANEL)
      throw new Error(
        "Kaggle metadata has fewer than 420 candidate ETF files.",
      );
    const initial = {
      _id: KAGGLE_ETF_PLAN_ID,
      bundle: KAGGLE_ETF_BUNDLE,
      status: "screening",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourceVersion: manifest.sourceVersion,
      sourceLicense: manifest.license,
      manifestSha256: manifest.manifestSha256,
      sourceFileCount: manifest.fileCount,
      candidateCount: manifest.candidateCount,
      candidates: manifest.candidates,
      candidateIndex: 0,
      pendingSymbols: [],
      panels: [],
      rejectionCounts: {},
      rejectedSamples: [],
    };
    await plans.updateOne(
      { _id: KAGGLE_ETF_PLAN_ID },
      { $setOnInsert: initial },
      { upsert: true },
    );
    plan = await plans.findOne({ _id: KAGGLE_ETF_PLAN_ID });
  }
  if (
    plan.sourceVersion !== KAGGLE_SOURCE_VERSION ||
    !Array.isArray(plan.candidates) ||
    !Array.isArray(plan.panels)
  )
    throw new Error(
      "Stored Kaggle import plan does not match its pinned schema.",
    );
  if (plan.status === "complete") {
    const snapshots = await database
      .collection("dataset_versions")
      .find({ _id: { $in: plan.snapshotIds || [] }, status: "ready" })
      .toArray();
    if (snapshots.length !== KAGGLE_ETF_COUNT)
      throw new Error(
        "Completed Kaggle plan has an incomplete Atlas snapshot set.",
      );
    return { datasets: snapshots.length, snapshots, idempotent: true };
  }

  const savePlan = async (changes) => {
    const updatedAt = new Date().toISOString();
    plan = { ...plan, ...changes, updatedAt };
    await plans.updateOne(
      { _id: KAGGLE_ETF_PLAN_ID },
      { $set: { ...changes, updatedAt } },
    );
  };
  const progressPercent = () =>
    Math.min(
      99,
      5 +
        (40 * plan.candidateIndex) / Math.max(1, plan.candidateCount) +
        (54 * plan.panels.length) / KAGGLE_ETF_COUNT +
        (5 * (plan.pendingSymbols?.length || 0)) / KAGGLE_ETFS_PER_PANEL,
    );
  const pauseForKaggle = async (error) => {
    const failures = (plan.transientFailures || 0) + 1;
    if (failures > 12) throw error;
    await savePlan({
      candidateIndex: plan.candidateIndex,
      rejectionCounts: plan.rejectionCounts,
      rejectedSamples: plan.rejectedSamples,
      transientFailures: failures,
    });
    await reportProgress(
      "Waiting for the free data source",
      progressPercent(),
      {
        completed: plan.candidateIndex,
        total: plan.candidateCount,
      },
    );
    return {
      status: "pause",
      datasets: KAGGLE_ETF_COUNT,
      completed: plan.panels.length,
      percent: progressPercent(),
      stage: "Waiting for the free data source",
    };
  };
  const members = [];
  for (const saved of plan.pendingSymbols || []) {
    if (Date.now() >= deadline)
      return {
        status: "continue",
        datasets: KAGGLE_ETF_COUNT,
        completed: plan.panels.length,
        percent: progressPercent(),
        stage: `Screened ${plan.candidateIndex} source files`,
      };
    await check();
    const candidate = plan.candidates.find(
      (item) => item.symbol === saved.symbol,
    );
    if (!candidate)
      throw new Error("Pending ETF is missing from the pinned manifest.");
    let member;
    try {
      member = await readKaggleEtf(candidate);
    } catch (error) {
      if (error?.retryable) return pauseForKaggle(error);
      throw error;
    }
    if (member.sourceFile.sourceSha256 !== saved.sourceSha256)
      throw new Error("Pinned Kaggle source file changed during resume.");
    members.push(member);
  }

  let uncheckpointedRejects = 0,
    lastScreenProgress = Date.now();
  while (plan.panels.length < KAGGLE_ETF_COUNT) {
    await check();
    if (Date.now() >= deadline && members.length < KAGGLE_ETFS_PER_PANEL) {
      if (uncheckpointedRejects)
        await savePlan({
          candidateIndex: plan.candidateIndex,
          rejectionCounts: plan.rejectionCounts,
          rejectedSamples: plan.rejectedSamples,
        });
      return {
        status: "continue",
        datasets: KAGGLE_ETF_COUNT,
        completed: plan.panels.length,
        percent: progressPercent(),
        stage: `Screened ${plan.candidateIndex} source files`,
      };
    }
    if (members.length < KAGGLE_ETFS_PER_PANEL) {
      const candidate = plan.candidates[plan.candidateIndex];
      if (!candidate) {
        await savePlan({
          status: "exhausted",
          candidateIndex: plan.candidateIndex,
          rejectionCounts: plan.rejectionCounts,
          rejectedSamples: plan.rejectedSamples,
        });
        throw new Error(
          `Kaggle screening exhausted after ${plan.panels.length} complete panels; another licensed source is required.`,
        );
      }
      let member;
      try {
        member = await readKaggleEtf(candidate);
      } catch (error) {
        if (error?.retryable) return pauseForKaggle(error);
        if (!error?.unsuitable) throw error;
        const reason = sourceRejectReason(error),
          rejectionCounts = {
            ...plan.rejectionCounts,
            [reason]: (plan.rejectionCounts?.[reason] || 0) + 1,
          },
          rejectedSamples = [...(plan.rejectedSamples || [])];
        if (rejectedSamples.length < 100)
          rejectedSamples.push({ symbol: candidate.symbol, reason });
        plan = {
          ...plan,
          candidateIndex: plan.candidateIndex + 1,
          rejectionCounts,
          rejectedSamples,
        };
        uncheckpointedRejects++;
        if (uncheckpointedRejects >= 8) {
          await savePlan({
            candidateIndex: plan.candidateIndex,
            rejectionCounts,
            rejectedSamples,
          });
          uncheckpointedRejects = 0;
        }
        if (!uncheckpointedRejects || Date.now() - lastScreenProgress > 5000) {
          await reportProgress(
            `Screened ${candidate.symbol}`,
            progressPercent(),
            { completed: plan.candidateIndex, total: plan.candidateCount },
          );
          lastScreenProgress = Date.now();
        }
        continue;
      }
      const pendingSymbols = [
        ...(plan.pendingSymbols || []),
        member.sourceFile,
      ];
      members.push(member);
      await savePlan({
        candidateIndex: plan.candidateIndex + 1,
        pendingSymbols,
        rejectionCounts: plan.rejectionCounts,
        rejectedSamples: plan.rejectedSamples,
        transientFailures: 0,
      });
      uncheckpointedRejects = 0;
      await reportProgress(`Qualified ${candidate.symbol}`, progressPercent(), {
        completed: plan.candidateIndex,
        total: plan.candidateCount,
      });
      continue;
    }

    const panelIndex = plan.panels.length,
      symbols = members.map((member) => member.sourceFile.symbol),
      meta = kaggleEtfPanelMeta(panelIndex, symbols),
      rows = members.flatMap((member) => member.rows),
      minCoverage = Math.min(
        ...members.map((member) => member.quality.coverage),
      ),
      audit = {
        version: "kaggle-etf-audit-1",
        expectedSessions: members[0].quality.expectedSessions,
        assets: members.length,
        observations: rows.length,
        minimumAssetSessions: Math.min(
          ...members.map((member) => member.quality.observations),
        ),
        minimumCoverage: minCoverage,
        medianDollarVolumeByAsset: Object.fromEntries(
          members.map((member) => [
            member.sourceFile.symbol,
            member.quality.medianDollarVolume,
          ]),
        ),
        invalidSourceRows: members.reduce(
          (total, member) => total + member.quality.invalidRows,
          0,
        ),
        zeroVolumeRows: members.reduce(
          (total, member) => total + member.quality.zeroVolumeRows,
          0,
        ),
        largeMoves: members.reduce(
          (total, member) => total + member.quality.largeMoves,
          0,
        ),
      },
      sourceArtifact = {
        provider: "Kaggle",
        owner: KAGGLE_OWNER,
        slug: KAGGLE_SLUG,
        version: KAGGLE_SOURCE_VERSION,
        license: plan.sourceLicense,
        manifestSha256: plan.manifestSha256,
        files: members.map(({ sourceFile }) => ({ ...sourceFile })),
      },
      range = [
        8 + (90 * panelIndex) / KAGGLE_ETF_COUNT,
        8 + (90 * (panelIndex + 1)) / KAGGLE_ETF_COUNT,
      ];
    const snapshot = await persistSnapshot(
      database,
      meta.id,
      rows,
      check,
      { sourceArtifact, quantAudit: audit },
      100000,
      Infinity,
      (percent, completed, total) =>
        reportProgress(`Saving ${meta.name}`, percent, {
          completed: panelIndex + completed / Math.max(1, total),
          total: KAGGLE_ETF_COUNT,
        }),
      range,
      meta,
      panelIndex % 2 === 0 ? "qt70a-" : "qt70b-",
    );
    const panel = {
      dataset: meta.id,
      version: snapshot.version,
      checksum: snapshot.checksum,
      count: snapshot.count,
      objective: meta.objective,
      objectiveId: meta.objectiveId,
      symbols,
      minimumCoverage: minCoverage,
    };
    const panels = [...plan.panels, panel],
      snapshotIds = panels.map((item) => item.version);
    await savePlan({
      panels,
      snapshotIds,
      pendingSymbols: [],
      transientFailures: 0,
      status: panels.length === KAGGLE_ETF_COUNT ? "complete" : "screening",
      ...(panels.length === KAGGLE_ETF_COUNT
        ? {
            completedAt: new Date().toISOString(),
            importedCount: panels.length,
          }
        : {}),
    });
    members.splice(0, members.length);
    await reportProgress(
      `Verified ${panels.length} of ${KAGGLE_ETF_COUNT} ETF panels`,
      panels.length === KAGGLE_ETF_COUNT ? 99 : progressPercent(),
      { completed: panels.length, total: KAGGLE_ETF_COUNT },
    );
    if (panels.length < KAGGLE_ETF_COUNT && Date.now() >= deadline)
      return {
        status: "continue",
        datasets: KAGGLE_ETF_COUNT,
        completed: panels.length,
        percent: progressPercent(),
        stage: `Verified ${panels.length} of ${KAGGLE_ETF_COUNT} ETF panels`,
      };
  }

  const snapshots = await database
    .collection("dataset_versions")
    .find({ _id: { $in: plan.snapshotIds }, status: "ready" })
    .toArray();
  if (snapshots.length !== KAGGLE_ETF_COUNT)
    throw new Error(
      "Kaggle ETF panel count did not pass the final Atlas check.",
    );
  return {
    datasets: snapshots.length,
    snapshots: snapshots.map(({ _id, count, checksum }) => ({
      version: _id,
      count,
      checksum,
    })),
    idempotent: false,
  };
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
  if (dataset === KAGGLE_ETF_BUNDLE)
    return ingestKaggleEtfPanels(database, check, reportProgress);
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
  versionPrefix = "",
) {
  const meta = metaOverride || CATALOG[dataset],
    rows = canonicalRows(input);
  if (!meta) throw new Error("Dataset metadata is missing.");
  const checksum = hash(rows),
    version = `${versionPrefix}${dataset}-${checksum.slice(0, 20)}`;
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
