import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { start } from "workflow/api";
import { researchWorkflow } from "../../workflows/research.js";
import { db, schema, hash } from "../../lib/db.mjs";
import {
  session,
  login,
  owner,
  rateLimit,
  sameOrigin,
  httpError,
  authorizeOperation,
  issueToken,
  guestSession,
} from "../../lib/auth.mjs";
import { CATALOG, OPTIONAL_SOURCES } from "../../lib/catalog.mjs";
import { EQUITY_BUNDLE, EQUITY_CATALOG } from "../../lib/equity-catalog.mjs";
import { EQUITY_AUDIT_VERSION } from "../../lib/equity-calendar.mjs";
import { parse, evaluate, makePanel } from "../../lib/dsl.mjs";
import { validateConfig, ENGINE_VERSION } from "../../lib/engine.mjs";
import { aggregateBars, distribution } from "../../lib/window.mjs";
import { asOfJoin } from "../../lib/metrics.mjs";
import { cloudChecks } from "../../lib/cloud-checks.mjs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const publicOps = new Set(["health", "catalog", "window"]);
const json = (data, status = 200, headers = {}) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store", ...headers },
  });
async function bodyOf(request) {
  if (Number(request.headers.get("content-length") || 0) > 20000)
    throw httpError("Request too large.", 413);
  const text = await request.text();
  if (text.length > 20000) throw httpError("Request too large.", 413);
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw httpError("Invalid JSON.");
  }
}
async function getVersion(database, id) {
  const v = await database
    .collection("dataset_versions")
    .findOne({ _id: id, status: "ready" });
  if (!v) throw httpError("Snapshot not found or not ready.", 404);
  return v;
}
async function ownedRun(database, id, workspace) {
  const r = await database
    .collection("runs")
    .findOne({ _id: id, workspace, status: "ready" });
  if (!r) throw httpError("Run not found.", 404);
  return r;
}
const clean = (obj) => (obj ? JSON.parse(JSON.stringify(obj)) : obj);
async function enqueue(database, job) {
  if (job.type !== "research")
    return database.collection("jobs").insertOne(job);
  for (let slot = 0; slot < 2; slot++) {
    try {
      return await database.collection("jobs").insertOne({ ...job, slot });
    } catch (e) {
      if (e.code !== 11000) throw e;
    }
  }
  throw httpError("Two jobs are already active.", 429);
}
async function handle(request) {
  const url = new URL(request.url),
    q = url.searchParams,
    op = q.get("op") || "health",
    isPublic = request.method === "GET" && publicOps.has(op),
    headers = isPublic ? { "Access-Control-Allow-Origin": "*" } : {};
  try {
    if (request.method !== "GET") sameOrigin(request);
    if (op === "health") {
      if (request.method !== "GET") throw httpError("Method not allowed.", 405);
      let database = "unconfigured";
      try {
        const d = await db();
        await d.command({ ping: 1 });
        database = "connected";
      } catch {
        database = process.env.MONGODB_URI ? "unavailable" : "unconfigured";
      }
      return json(
        {
          app: "qtpatuti",
          engine: ENGINE_VERSION,
          database,
          commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
          deployment: process.env.VERCEL_DEPLOYMENT_ID || null,
          artifactHash: hash(
            await readFile(process.cwd() + "/index.html", "utf8"),
          ),
        },
        database === "connected" ? 200 : 503,
        headers,
      );
    }
    const database = await db();
    await schema(database);
    if (op === "verify" && request.method === "POST") {
      if (!owner(request)) throw httpError("Owner access required.", 403);
      await rateLimit(database, "owner:verify", 2);
      return json(await cloudChecks());
    }
    if (op === "probe" && request.method === "POST") {
      if (!owner(request)) throw httpError("Owner access required.", 403);
      await rateLimit(database, "owner:probe", 3);
      const b = await bodyOf(request);
      if (!["provider-error", "cancel"].includes(b.probe))
        throw httpError("Unknown verification probe.");
      const id = randomUUID();
      await database.collection("jobs").insertOne({
        _id: id,
        workspace: "owner",
        type: "probe",
        probe: b.probe,
        status: "queued",
        createdAt: new Date().toISOString(),
      });
      const workflow = await start(researchWorkflow, [id]);
      await database
        .collection("jobs")
        .updateOne({ _id: id }, { $set: { workflow: workflow.runId } });
      return json({ job: id }, 202);
    }
    if (op === "catalog" && request.method === "GET") {
      const versions = await database
        .collection("dataset_versions")
        .find({
          status: "ready",
          supersededBy: { $exists: false },
          $or: [
            { dataset: { $nin: Object.keys(EQUITY_CATALOG) } },
            { "quantAudit.version": EQUITY_AUDIT_VERSION },
          ],
        })
        .sort({ createdAt: -1 })
        .limit(30)
        .toArray();
      return json(
        {
          versions: clean(versions),
          sources: CATALOG,
          optional: OPTIONAL_SOURCES,
        },
        200,
        headers,
      );
    }
    if (op === "window" && request.method === "GET") {
      const v = await getVersion(database, q.get("version"));
      const asset = q.get("asset") || v.assets[0];
      if (!v.assets.includes(asset)) throw httpError("Unknown asset.");
      const from = q.get("from") || v.from,
        to = q.get("to") || v.to;
      for (const d of [from, to])
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw httpError("Invalid date.");
      const rows = await database
        .collection("bars")
        .find(
          { version: v._id, asset, date: { $gte: from, $lte: to } },
          { projection: { _id: 0, version: 0 } },
        )
        .sort({ date: 1 })
        .limit(5000)
        .toArray();
      const frame = [1, 5, 20].includes(Number(q.get("frame")))
          ? Number(q.get("frame"))
          : 1,
        offset = Math.max(
          0,
          Math.min(5000, parseInt(q.get("offset") || "0") || 0),
        );
      let context = null;
      if (q.get("contextVersion")) {
        const cv = await getVersion(database, q.get("contextVersion")),
          ca = q.get("contextAsset") || cv.assets[0];
        if (!cv.assets.includes(ca)) throw httpError("Unknown context asset.");
        const secondary = await database
          .collection("bars")
          .find(
            {
              version: cv._id,
              asset: ca,
              date: {
                $gte: new Date(Date.parse(from) - 10 * 86400000)
                  .toISOString()
                  .slice(0, 10),
                $lte: to,
              },
            },
            { projection: { _id: 0, version: 0 } },
          )
          .sort({ date: 1 })
          .limit(5000)
          .toArray();
        const joined = asOfJoin(rows, secondary, 7);
        context = {
          asset: ca,
          units: cv.meta.units.close,
          coverage: joined.length
            ? joined.filter((r) => r.context !== null).length / joined.length
            : 0,
          points: aggregateBars(joined, 350, frame).map((r) => ({
            date: r.date,
            value: r.context,
            observationDate: r.contextDate,
            ageDays: r.ageDays,
          })),
          method:
            "Backward as-of on availableAt; max age 7 calendar days; gaps are not imputed.",
        };
      }
      return json(
        {
          asset,
          version: v._id,
          kind: v.meta.kind,
          unit: v.meta.units.close,
          total: rows.length,
          points: aggregateBars(rows, 350, frame),
          table: rows.slice(offset, offset + 50),
          offset,
          distribution: distribution(
            rows,
            v.meta.fields.includes(q.get("field")) ? q.get("field") : "close",
          ),
          context,
        },
        200,
        headers,
      );
    }
    if (op === "workspace" && request.method === "POST") {
      if (request.headers.has("authorization"))
        throw httpError("Use the website to sign in.", 403);
      await rateLimit(
        database,
        "login:" + (request.headers.get("x-forwarded-for") || "unknown"),
        12,
      );
      const b = await bodyOf(request),
        s = await login(
          database,
          b,
          b.create === true,
          await session(request, database, false),
        );
      return json({ workspace: s.workspace, name: s.name }, 200, {
        "Set-Cookie": s.cookie,
      });
    }
    if (op === "guest" && request.method === "POST") {
      if (request.headers.has("authorization"))
        throw httpError("Use the website to start.", 403);
      const current = await session(request, database, false);
      if (current)
        return json({
          workspace: current.workspace,
          name: current.name,
          guest: !!current.guest,
        });
      await rateLimit(
        database,
        "guest:" + (request.headers.get("x-forwarded-for") || "unknown"),
        2,
      );
      const s = await guestSession(database);
      return json({ workspace: s.workspace, name: s.name, guest: true }, 201, {
        "Set-Cookie": s.cookie,
      });
    }
    if (op === "session" && request.method === "GET") {
      const s = await session(request, database, false);
      return json(
        s
          ? { workspace: s.workspace, name: s.name, guest: !!s.guest }
          : { workspace: null },
      );
    }
    if (op === "logout" && request.method === "POST") {
      if (request.headers.has("authorization"))
        throw httpError("Use the website to sign out.", 403);
      const s = await session(request, database, false);
      if (s) await database.collection("sessions").deleteOne({ _id: s._id });
      return json({ ok: true }, 200, {
        "Set-Cookie":
          "q_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
      });
    }
    if (op === "import" && request.method === "POST") {
      if (!owner(request)) throw httpError("Owner access required.", 403);
      const b = await bodyOf(request);
      if (!CATALOG[b.dataset] && b.dataset !== EQUITY_BUNDLE)
        throw httpError("Unknown catalog source.");
      await rateLimit(database, "owner:import", 4);
      const id = randomUUID();
      await database.collection("jobs").insertOne({
        _id: id,
        workspace: "owner",
        type: "import",
        dataset: b.dataset,
        status: "queued",
        createdAt: new Date().toISOString(),
      });
      try {
        const workflow = await start(researchWorkflow, [id]);
        await database
          .collection("jobs")
          .updateOne({ _id: id }, { $set: { workflow: workflow.runId } });
        return json({ job: id }, 202);
      } catch {
        await database.collection("jobs").updateOne(
          { _id: id },
          {
            $set: {
              status: "failed",
              error: "Dispatch failed; retry available.",
            },
          },
        );
        throw httpError("Cloud dispatcher unavailable.", 503);
      }
    }
    const s = owner(request)
      ? { workspace: "owner" }
      : await session(request, database);
    authorizeOperation(s, op, request.method);
    await rateLimit(
      database,
      s.workspace + ":" + op,
      ["run", "validate", "retry"].includes(op) ? 10 : 120,
    );
    if (op === "tokens") {
      if (s.auth === "token" || s.guest)
        throw httpError(
          "Sign in to a named workspace to manage AI access.",
          403,
        );
      if (request.method === "GET")
        return json({
          tokens: await database
            .collection("api_tokens")
            .find(
              { workspace: s.workspace },
              { projection: { _id: 0, workspace: 0, workspaceName: 0 } },
            )
            .sort({ createdAt: -1 })
            .limit(50)
            .toArray(),
        });
      const b = await bodyOf(request);
      if (b.revoke) {
        await database
          .collection("api_tokens")
          .updateOne(
            { workspace: s.workspace, id: String(b.revoke) },
            { $set: { revokedAt: new Date() } },
          );
        return json({ ok: true });
      }
      await rateLimit(database, s.workspace + ":token-create", 5);
      return json(await issueToken(database, s, b), 201);
    }
    if (s.guest && ["run", "retry"].includes(op) && request.method === "POST") {
      // Atomic lifetime quota; guest sessions cannot consume unbounded cloud jobs.
      const quota = await database.collection("workspaces").updateOne(
        {
          _id: s.workspace,
          guest: true,
          $or: [{ runs: { $lt: 3 } }, { runs: { $exists: false } }],
        },
        { $inc: { runs: 1 } },
      );
      if (!quota.modifiedCount)
        throw httpError(
          "Save your workspace to run more than three experiments.",
          403,
        );
    }
    if (op === "validate" && request.method === "POST") {
      const b = await bodyOf(request),
        v = await getVersion(database, b.datasetVersion),
        ast = parse(b.code, v.meta.fields),
        rows = await database
          .collection("bars")
          .find({ version: v._id }, { projection: { _id: 0, version: 0 } })
          .sort({ date: 1, asset: 1 })
          .limit(70001)
          .toArray(),
        panel = makePanel(rows),
        vars = evaluate(ast, panel);
      const t = Math.max(0, panel.dates.indexOf(b.date || panel.dates.at(-1))),
        a = Math.max(0, panel.assets.indexOf(b.asset || panel.assets[0]));
      return json({
        ok: true,
        astHash: hash(ast),
        date: panel.dates[t],
        asset: panel.assets[a],
        variables: Object.fromEntries(
          Object.entries(vars).map(([k, v]) => [k, v[t][a]]),
        ),
        fields: panel.matrix[t][a],
        operators:
          "Ranks ascending [0,1], average ties. Rolling uses full window, sample std (ddof=1). Missing/zero denominator → null. lag counts dataset sessions, never skips missing asset rows.",
      });
    }
    if (op === "edges") {
      if (request.method === "GET") {
        const list = await database
          .collection("edges")
          .find({ workspace: s.workspace })
          .sort({ updatedAt: -1 })
          .limit(100)
          .toArray();
        if (q.get("id")) {
          const versions = await database
            .collection("edge_versions")
            .find({ workspace: s.workspace, edge: q.get("id") })
            .sort({ version: -1 })
            .limit(100)
            .toArray();
          return json({ versions });
        }
        return json({ edges: list });
      }
      if (request.method === "POST") {
        const b = await bodyOf(request),
          v = await getVersion(database, b.datasetVersion);
        parse(b.code, v.meta.fields);
        if (!b.name || String(b.name).length > 100)
          throw httpError("Name is required (max 100 characters).");
        const edge = b.fork || !b.id ? randomUUID() : b.id;
        let e = await database
          .collection("edges")
          .findOne({ _id: edge, workspace: s.workspace });
        if (b.id && !b.fork && !e) throw httpError("Edge not found.", 404);
        if (!e) {
          await database.collection("edges").insertOne({
            _id: edge,
            workspace: s.workspace,
            version: 0,
            createdAt: new Date().toISOString(),
          });
        }
        e = await database.collection("edges").findOneAndUpdate(
          { _id: edge, workspace: s.workspace },
          {
            $inc: { version: 1 },
            $set: {
              name: String(b.name),
              updatedAt: new Date().toISOString(),
            },
          },
          { returnDocument: "after" },
        );
        const record = {
          edge,
          workspace: s.workspace,
          version: e.version,
          name: String(b.name),
          code: b.code,
          datasetVersion: b.datasetVersion,
          hypothesis: String(b.hypothesis || "").slice(0, 3000),
          notes: String(b.notes || "").slice(0, 3000),
          forkOf: b.fork ? { edge: b.id, version: b.version } : null,
          codeHash: hash(b.code),
          createdAt: new Date().toISOString(),
        };
        await database.collection("edge_versions").insertOne(record);
        return json(record, 201);
      }
    }
    if (op === "run" && request.method === "POST") {
      const b = await bodyOf(request),
        v = await getVersion(database, b.datasetVersion),
        config = validateConfig(b.config);
      parse(b.code, v.meta.fields);
      if (b.expectedEngine && b.expectedEngine !== ENGINE_VERSION)
        throw httpError(
          "This run used " +
            b.expectedEngine +
            ". Exact rerun requires that engine revision; open its recorded source commit before rerunning.",
          409,
        );
      const universe = Array.isArray(b.universe)
        ? [...new Set(b.universe)]
        : [];
      if (universe.some((a) => !v.assets.includes(a)))
        throw httpError("Universe contains unknown symbols.");
      const active = await database.collection("jobs").countDocuments({
        workspace: s.workspace,
        status: { $in: ["queued", "running", "retrying", "committing"] },
      });
      if (active >= 2) throw httpError("Two jobs are already active.", 429);
      const id = randomUUID(),
        job = {
          _id: id,
          workspace: s.workspace,
          type: "research",
          status: "queued",
          createdAt: new Date().toISOString(),
          datasetVersion: v._id,
          code: b.code,
          config,
          universe,
          edge: b.edge || null,
          edgeVersion: b.edgeVersion || null,
          robustness: b.robustness === true,
        };
      if (job.edge) {
        const ev = await database.collection("edge_versions").findOne({
          edge: job.edge,
          version: job.edgeVersion,
          workspace: s.workspace,
        });
        if (!ev || ev.code !== job.code)
          throw httpError(
            "Saved edge version does not match code. Save a new version first.",
          );
      }
      await enqueue(database, job);
      try {
        const workflow = await start(researchWorkflow, [id]);
        await database
          .collection("jobs")
          .updateOne({ _id: id }, { $set: { workflow: workflow.runId } });
      } catch {
        await database.collection("jobs").updateOne(
          { _id: id },
          {
            $set: {
              status: "failed",
              error: "Dispatch failed; retry available.",
            },
          },
        );
        throw httpError("Cloud dispatcher unavailable.", 503);
      }
      return json({ job: id }, 202);
    }
    if (op === "jobs" && request.method === "GET") {
      const filter = { workspace: s.workspace };
      if (q.get("id")) filter._id = q.get("id");
      return json({
        jobs: await database
          .collection("jobs")
          .find(filter, { projection: { code: 0 } })
          .sort({ createdAt: -1 })
          .limit(40)
          .toArray(),
      });
    }
    if (["cancel", "retry"].includes(op) && request.method === "POST") {
      const b = await bodyOf(request),
        job = await database
          .collection("jobs")
          .findOne({ _id: b.id, workspace: s.workspace });
      if (!job) throw httpError("Job not found.", 404);
      if (op === "cancel") {
        const changed = await database.collection("jobs").updateOne(
          {
            _id: job._id,
            status: { $in: ["queued", "running", "retrying", "failed"] },
          },
          {
            $set: {
              status: "cancelled",
              cancelledAt: new Date().toISOString(),
            },
          },
        );
        return json({ cancelled: !!changed.modifiedCount });
      }
      if (!["failed", "cancelled"].includes(job.status))
        throw httpError("Only failed/cancelled jobs can be retried.");
      const id = randomUUID();
      await enqueue(database, {
        ...job,
        _id: id,
        retryOf: job._id,
        status: "queued",
        createdAt: new Date().toISOString(),
        attempts: 0,
        workflow: null,
        error: null,
      });
      const workflow = await start(researchWorkflow, [id]);
      await database
        .collection("jobs")
        .updateOne({ _id: id }, { $set: { workflow: workflow.runId } });
      return json({ job: id }, 202);
    }
    if (op === "runs" && request.method === "GET") {
      return json({
        runs: await database
          .collection("runs")
          .find(
            { workspace: s.workspace, status: "ready" },
            { projection: { code: 0, robustness: 0, terminal: 0 } },
          )
          .sort({ createdAt: -1 })
          .limit(50)
          .toArray(),
      });
    }
    if (op === "report" && request.method === "GET") {
      const r = await ownedRun(database, q.get("run"), s.workspace);
      if (!r.holdoutOpenedAt) {
        r.holdoutOpenedAt = new Date().toISOString();
        await database.collection("runs").updateOne(
          { _id: r._id, workspace: s.workspace },
          {
            $set: { holdoutOpened: true, holdoutOpenedAt: r.holdoutOpenedAt },
          },
        );
      }
      return json(r);
    }
    if (op === "runWindow" && request.method === "GET") {
      const r = await ownedRun(database, q.get("run"), s.workspace),
        v = await getVersion(database, r.datasetVersion),
        asset = q.get("asset") || v.assets[0],
        from = q.get("from") || v.from,
        to = q.get("to") || v.to;
      const filter = { run: r._id, date: { $gte: from, $lte: to } },
        timelines = await database
          .collection("run_series")
          .find(
            { ...filter, kind: "timeline" },
            { projection: { _id: 0, run: 0 } },
          )
          .sort({ date: 1 })
          .limit(5000)
          .toArray(),
        points = await database
          .collection("run_series")
          .find(
            { ...filter, kind: "point", asset },
            { projection: { _id: 0, run: 0 } },
          )
          .sort({ date: 1 })
          .limit(5000)
          .toArray();
      const frame = [1, 5, 20].includes(Number(q.get("frame")))
        ? Number(q.get("frame"))
        : 1;
      const bars = await database
        .collection("bars")
        .find(
          { version: v._id, asset, date: { $gte: from, $lte: to } },
          { projection: { _id: 0, date: 1 } },
        )
        .sort({ date: 1 })
        .limit(5000)
        .toArray();
      const buckets = aggregateBars(bars, 350, frame);
      const pick = (rows) => {
        const byDate = new Map(rows.map((r) => [r.date, r]));
        return buckets.map((b) => ({
          ...byDate.get(b.date),
          date: b.date,
          startDate: b.startDate,
        }));
      };
      return json({
        timeline: pick(timelines),
        points: pick(points),
        fills: await database
          .collection("ledger_events")
          .find({ ...filter, asset })
          .sort({ event: 1 })
          .limit(300)
          .toArray(),
        sampled: buckets.length < bars.length,
      });
    }
    if (op === "cross" && request.method === "GET") {
      const r = await ownedRun(database, q.get("run"), s.workspace),
        date = q.get("date"),
        horizon = Number(q.get("horizon") || r.config.horizon);
      if (!Number.isInteger(horizon) || horizon < 1 || horizon > 12)
        throw httpError("Invalid evaluation horizon.");
      const points = await database
        .collection("run_series")
        .find(
          { run: r._id, kind: "point", date },
          { projection: { _id: 0, run: 0 } },
        )
        .sort({ score: -1 })
        .limit(64)
        .toArray();
      if (horizon !== r.config.horizon) {
        const futureDates = await database
            .collection("run_series")
            .find(
              { run: r._id, kind: "timeline", date: { $gte: date } },
              { projection: { date: 1, _id: 0 } },
            )
            .sort({ date: 1 })
            .limit(horizon + 2)
            .toArray(),
          start = r.meta.kind === "reference" ? 0 : 1,
          end = start + horizon,
          field = r.meta.kind === "reference" ? "close" : "open";
        const bars = await database
            .collection("bars")
            .find(
              {
                version: r.datasetVersion,
                date: {
                  $in: [
                    futureDates[start]?.date,
                    futureDates[end]?.date,
                  ].filter(Boolean),
                },
              },
              { projection: { _id: 0, asset: 1, date: 1, [field]: 1 } },
            )
            .limit(128)
            .toArray(),
          lookup = new Map(bars.map((b) => [b.asset + "|" + b.date, b[field]]));
        points.forEach((p) => {
          const entry = lookup.get(p.asset + "|" + futureDates[start]?.date),
            exit = lookup.get(p.asset + "|" + futureDates[end]?.date);
          p.forwardReturn =
            entry > 0 && Number.isFinite(exit) ? exit / entry - 1 : null;
        });
      }
      return json({ date, horizon, points });
    }
    if (op === "detail" && request.method === "GET") {
      const r = await ownedRun(database, q.get("run"), s.workspace),
        date = q.get("date"),
        asset = q.get("asset"),
        p = await database
          .collection("run_series")
          .findOne(
            { run: r._id, kind: "point", date, asset },
            { projection: { _id: 0, run: 0 } },
          ),
        source = await database
          .collection("bars")
          .findOne(
            { version: r.datasetVersion, date, asset },
            { projection: { _id: 0, version: 0 } },
          ),
        ledger = await database
          .collection("ledger_events")
          .find({ run: r._id, asset, $or: [{ date }, { decisionDate: date }] })
          .limit(20)
          .toArray(),
        timeline = await database
          .collection("run_series")
          .findOne(
            { run: r._id, kind: "timeline", date },
            { projection: { _id: 0, run: 0 } },
          );
      return json({
        source,
        point: p,
        ledger,
        account: timeline
          ? {
              nav: timeline.nav,
              cash: timeline.cash,
              cost: timeline.cost,
              drawdown: timeline.drawdown,
              ideal: timeline.ideal,
            }
          : null,
      });
    }
    if (op === "compare" && request.method === "GET") {
      const a = await ownedRun(database, q.get("a"), s.workspace),
        b = await ownedRun(database, q.get("b"), s.workspace),
        sa = await database
          .collection("run_series")
          .find({ run: a._id, kind: "timeline" })
          .sort({ date: 1 })
          .limit(5000)
          .toArray(),
        sb = await database
          .collection("run_series")
          .find({ run: b._id, kind: "timeline" })
          .sort({ date: 1 })
          .limit(5000)
          .toArray(),
        byDate = new Map(sb.map((r) => [r.date, r]));
      const first = sa.find((r) => {
        const other = byDate.get(r.date);
        return (
          !other ||
          r.pointHash !== other.pointHash ||
          (r.ic === null) !== (other.ic === null) ||
          Math.abs((r.nav ?? 0) - (other.nav ?? 0)) > 1e-8 ||
          Math.abs((r.ic ?? 0) - (other.ic ?? 0)) > 1e-12
        );
      });
      return json({
        a: a._id,
        b: b._id,
        configDiff: Object.keys(a.config)
          .filter((k) => a.config[k] !== b.config[k])
          .map((k) => ({ key: k, a: a.config[k], b: b.config[k] })),
        universeA: a.universe,
        universeB: b.universe,
        engineA: a.engine,
        engineB: b.engine,
        codeA: a.code,
        codeB: b.code,
        codeDiff: Array.from({
          length: Math.max(
            a.code.split("\n").length,
            b.code.split("\n").length,
          ),
        })
          .map((_, i) => ({
            line: i + 1,
            a: a.code.split("\n")[i] ?? "",
            b: b.code.split("\n")[i] ?? "",
          }))
          .filter((x) => x.a !== x.b),
        sameSnapshot: a.datasetVersion === b.datasetVersion,
        metricsA: a.metrics,
        metricsB: b.metrics,
        firstDifferentDate:
          first?.date ||
          sb.find((r) => !sa.some((x) => x.date === r.date))?.date ||
          null,
        tolerance:
          "NAV 1e-8; IC 1e-12; exact per-date score/account-point hash",
      });
    }
    throw httpError("Unknown operation or method.", 404);
  } catch (e) {
    const status = e.status || (e.name === "DslError" ? 400 : 500);
    return json(
      {
        error:
          status === 500
            ? "Service failed. Your saved research is preserved; retry is available."
            : e.message,
        line: e.line,
        column: e.column,
      },
      status,
      headers,
    );
  }
}
export const GET = handle;
export const POST = handle;
export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Cache-Control": "no-store",
    },
  });
}
