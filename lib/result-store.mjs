import { hash } from "./db.mjs";
import { ranks } from "./dsl.mjs";

export const RESULT_STORAGE = "chunks-v1";
export const CHUNK_ROWS = 128;
const MAX_CHUNK_BYTES = 512 * 1024;
const MAX_CHUNKS = 2000;

export function resultRows(result, run) {
  const { panel, variables, diagnostic } = result;
  const points =
    result.account?.points ||
    panel.dates.flatMap((date, t) => {
      const rank = ranks(variables.score[t]);
      return panel.assets.map((asset, a) => ({
        date,
        asset,
        score: variables.score[t][a],
        rank: rank[a],
        reason:
          "Reference-rate diagnostic only; no executable orders or fills.",
      }));
    });
  const ti = new Map(panel.dates.map((d, i) => [d, i]));
  const ai = new Map(panel.assets.map((a, i) => [a, i]));
  const byDate = new Map();
  for (const point of points) {
    if (!byDate.has(point.date)) byDate.set(point.date, []);
    byDate.get(point.date).push(point);
  }
  return {
    points: points.map((p) => ({
      ...p,
      kind: "point",
      variables: Object.fromEntries(
        Object.entries(variables).map(([k, v]) => [
          k,
          v[ti.get(p.date)][ai.get(p.asset)],
        ]),
      ),
      forwardReturn: diagnostic.labels[ti.get(p.date)][ai.get(p.asset)],
    })),
    timeline: diagnostic.series.map((r, t) => ({
      ...r,
      ...result.account?.series[t],
      kind: "timeline",
      asset: "",
      ideal: result.ideal[t],
      icByHorizon: Object.fromEntries(
        diagnostic.decay.map((d) => [d.horizon, d.byTime[t]]),
      ),
      pointHash: hash({
        scores: variables.score[t],
        points: byDate.get(r.date) || [],
      }),
    })),
    ledger: (result.account?.ledger || []).map((r, event) => ({
      ...r,
      run,
      event,
      _id: `${run}:${event}`,
    })),
  };
}

export function packResults(result, run) {
  const rows = resultRows(result, run),
    chunks = [];
  for (const [kind, records] of [
    ["point", rows.points],
    ["timeline", rows.timeline],
    ["ledger", rows.ledger],
  ]) {
    const groups = new Map();
    for (const row of records) {
      const asset = row.asset || "";
      if (!groups.has(asset)) groups.set(asset, []);
      groups.get(asset).push(row);
    }
    for (const [asset, records] of groups) {
      let batch = [],
        bytes = 0,
        bucket = 0;
      const flush = () => {
        if (!batch.length) return;
        const dates = batch.map((r) => r.date).sort();
        const decisions = batch
          .map((r) => r.decisionDate)
          .filter(Boolean)
          .sort();
        chunks.push({
          run,
          kind,
          asset,
          bucket: bucket++,
          startDate: dates[0],
          endDate: dates.at(-1),
          decisionStart: decisions[0] || null,
          decisionEnd: decisions.at(-1) || null,
          count: batch.length,
          checksum: hash(batch),
          rows: batch,
        });
        batch = [];
        bytes = 0;
      };
      for (const record of records) {
        // Normalize optional/nonfinite values identically before hashing and BSON storage.
        const encoded = JSON.stringify(record),
          size = Buffer.byteLength(encoded);
        if (size > MAX_CHUNK_BYTES)
          throw new Error("Result row exceeds storage limit.");
        if (batch.length >= CHUNK_ROWS || bytes + size > MAX_CHUNK_BYTES)
          flush();
        batch.push(JSON.parse(encoded));
        bytes += size;
      }
      flush();
    }
  }
  if (chunks.length > MAX_CHUNKS)
    throw new Error("Result chunk limit exceeded.");
  return {
    chunks,
    counts: {
      points: rows.points.length,
      sessions: rows.timeline.length,
      ledger: rows.ledger.length,
    },
  };
}

export function verifyChunks(expected, stored) {
  if (stored.length !== expected.length)
    throw new Error("Result chunk count mismatch.");
  const key = (c) => `${c.kind}|${c.asset}|${c.bucket}`;
  const wanted = new Map(expected.map((c) => [key(c), c]));
  for (const chunk of stored) {
    const source = wanted.get(key(chunk));
    if (
      !source ||
      source.count !== chunk.count ||
      chunk.rows.length !== chunk.count ||
      source.checksum !== chunk.checksum ||
      hash(chunk.rows) !== chunk.checksum
    )
      throw new Error("Result readback checksum mismatch.");
    wanted.delete(key(chunk));
  }
  if (wanted.size) throw new Error("Missing result chunk.");
}

export function selectChunkRows(
  chunks,
  { asset, from, to, decisionDate, sort = "date", limit = 5000 } = {},
) {
  const matchesDate = (date) => (!from || date >= from) && (!to || date <= to);
  const rows = chunks
    .flatMap((c) => c.rows)
    .filter(
      (r) =>
        (asset === undefined || r.asset === asset) &&
        (matchesDate(r.date) ||
          (decisionDate && r.decisionDate === decisionDate)),
    );
  rows.sort(
    sort === "score"
      ? (a, b) =>
          (b.score ?? -Infinity) - (a.score ?? -Infinity) ||
          a.asset.localeCompare(b.asset)
      : sort === "event"
        ? (a, b) => a.event - b.event
        : (a, b) =>
            a.date.localeCompare(b.date) ||
            (a.asset || "").localeCompare(b.asset || ""),
  );
  return rows.slice(0, limit);
}

// Caller must authenticate/authorize the run before using this storage adapter.
export async function readResult(database, run, kind, options = {}) {
  const {
    asset,
    from,
    to,
    decisionDate,
    sort = "date",
    limit = 5000,
  } = options;
  if (run.resultStorage !== RESULT_STORAGE) {
    const query = { run: run._id, ...(kind === "ledger" ? {} : { kind }) };
    if (asset !== undefined) query.asset = asset;
    const date = {
      ...(from ? { $gte: from } : {}),
      ...(to ? { $lte: to } : {}),
    };
    if (decisionDate) query.$or = [{ date }, { decisionDate }];
    else if (from || to) query.date = date;
    return database
      .collection(kind === "ledger" ? "ledger_events" : "run_series")
      .find(query, kind === "ledger" ? {} : { projection: { _id: 0, run: 0 } })
      .sort(
        sort === "score"
          ? { score: -1, asset: 1 }
          : sort === "event"
            ? { event: 1 }
            : { date: 1, asset: 1 },
      )
      .limit(limit)
      .toArray();
  }
  const query = { run: run._id, kind };
  if (asset !== undefined) query.asset = asset;
  const window = {
    ...(to ? { startDate: { $lte: to } } : {}),
    ...(from ? { endDate: { $gte: from } } : {}),
  };
  if (decisionDate)
    query.$or = [
      window,
      {
        decisionStart: { $lte: decisionDate },
        decisionEnd: { $gte: decisionDate },
      },
    ];
  else Object.assign(query, window);
  const chunks = await database
    .collection("result_chunks")
    .find(query, { projection: { _id: 0, rows: 1 } })
    .limit(MAX_CHUNKS + 1)
    .toArray();
  if (chunks.length > MAX_CHUNKS)
    throw new Error("Result read limit exceeded.");
  return selectChunkRows(chunks, options);
}
