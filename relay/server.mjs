import { createHash, createPublicKey, verify } from "node:crypto";
import { createServer } from "node:http";
import { MongoClient } from "mongodb";
import { EJSON } from "bson";
import { pathToFileURL } from "node:url";

const COLLECTIONS = new Set([
  "api_tokens",
  "bars",
  "datasets",
  "dataset_ingest_plans",
  "dataset_versions",
  "edge_versions",
  "edges",
  "jobs",
  "ledger_events",
  "rate_limits",
  "result_chunks",
  "run_series",
  "runs",
  "sessions",
  "verification",
  "workspaces",
]);
const SHARD_HOSTS = [
  "qplatresults01.xui2vfx.mongodb.net",
  "qplatresults02.f5cdfhi.mongodb.net",
];
const CORE_METADATA_COLLECTIONS = [
  "api_tokens",
  "dataset_ingest_plans",
  "edge_versions",
  "edges",
  "jobs",
  "ledger_events",
  "rate_limits",
  "relay_usage",
  "run_series",
  "runs",
  "sessions",
  "verification",
  "workspaces",
];
const OPERATIONS = new Set([
  "bulkWrite",
  "countDocuments",
  "createIndex",
  "deleteMany",
  "deleteOne",
  "findOne",
  "findOneAndUpdate",
  "insertOne",
  "ping",
  "updateMany",
  "updateOne",
]);
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_MONTHLY_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_ACTIVE_REQUESTS = 8;
const SIGNATURE_TTL_MS = 60_000;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function errorDiagnostic(error) {
  const name = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error?.name || "")
    ? error.name
    : "Error";
  const code = ["string", "number"].includes(typeof error?.code)
    ? String(error.code)
    : "";
  const codeName = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error?.codeName || "")
    ? error.codeName
    : "";
  const message = String(error?.message || "");
  const kind = /bad auth|authentication failed/i.test(message)
    ? "authentication"
    : /not authorized|unauthorized/i.test(message)
      ? "authorization"
      : undefined;
  return {
    name,
    ...(code && /^[A-Za-z0-9_-]{1,40}$/.test(code) ? { code } : {}),
    ...(codeName ? { codeName } : {}),
    ...(kind ? { kind } : {}),
  };
}

function verifyRequest(publicKey, headers, body, seenNonces, now = Date.now()) {
  const timestamp = headers["x-qtpatuti-timestamp"];
  const nonce = headers["x-qtpatuti-nonce"];
  const signature = headers["x-qtpatuti-signature"];
  if (!publicKey || !/^\d{13}$/.test(timestamp || "") || !/^[0-9a-f-]{36}$/i.test(nonce || "") || typeof signature !== "string")
    return false;
  if (Math.abs(now - Number(timestamp)) > SIGNATURE_TTL_MS || seenNonces.has(nonce)) return false;
  const digest = createHash("sha256").update(body).digest("hex");
  const message = `${timestamp}.${nonce}.${digest}`;
  try {
    const valid = verify(null, Buffer.from(message), publicKey, Buffer.from(signature, "base64url"));
    if (valid) seenNonces.set(nonce, now + SIGNATURE_TTL_MS);
    return valid;
  } catch {
    return false;
  }
}

async function readBody(req) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > MAX_REQUEST_BYTES) throw Object.assign(new Error("Request too large."), { status: 413 });
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_REQUEST_BYTES)
      throw Object.assign(new Error("Request too large."), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function mongoTarget(database, collection, env) {
  if (!["q_plat", "q_plat_test"].includes(database))
    throw Object.assign(new Error("Database is not allowed."), { status: 403 });
  if (!COLLECTIONS.has(collection))
    throw Object.assign(new Error("Collection is not allowed."), { status: 403 });
  const uri = env.MONGODB_DATA_URI || env.MONGODB_CORE_URI;
  if (!uri) throw Object.assign(new Error("Atlas URI is not configured."), { status: 503 });
  return { uri, database };
}

function resultShard(run) {
  if (typeof run !== "string" || !run)
    throw Object.assign(new Error("A run ID is required for result storage."), { status: 400 });
  return Number.parseInt(createHash("sha256").update(run).digest("hex").at(-1), 16) & 1;
}

function barVersion(request) {
  if (request.operation === "find") return request.filter?.version;
  if (request.operation === "findOne") return request.args?.[0]?.version;
  if (request.operation === "bulkWrite") {
    const operation = request.args?.[0]?.[0];
    return operation?.updateOne?.filter?.version || operation?.replaceOne?.filter?.version || operation?.deleteOne?.filter?.version;
  }
  return request.args?.[0]?.version;
}

function resultRun(request) {
  if (request.operation === "find") return request.filter?.run;
  if (request.operation === "findOne") return request.args?.[0]?.run;
  if (request.operation === "bulkWrite") {
    const operation = request.args?.[0]?.[0];
    return operation?.updateOne?.filter?.run || operation?.replaceOne?.filter?.run || operation?.deleteOne?.filter?.run;
  }
  return request.args?.[0]?.run;
}

function checkedShardUri(uri, shard) {
  if (typeof uri !== "string")
    throw Object.assign(new Error("Result storage is not configured."), { status: 503 });
  let host = "";
  try { host = new URL(uri).hostname.toLowerCase(); } catch {}
  if (host !== SHARD_HOSTS[shard])
    throw Object.assign(new Error("Result storage target is not allowed."), { status: 403 });
  return uri;
}

export function createRelayServer({ env = process.env, Client = MongoClient } = {}) {
  const clients = new Map();
  const seenNonces = new Map();
  const publicKey = env.MONGODB_RELAY_PUBLIC_KEY
    ? createPublicKey({ key: Buffer.from(env.MONGODB_RELAY_PUBLIC_KEY, "base64"), format: "der", type: "spki" })
    : null;
  let activeRequests = 0;
  let usageQueue = Promise.resolve();

  async function clientFor(uri) {
    let connection = clients.get(uri);
    if (!connection) {
      const client = new Client(uri, {
        maxPoolSize: 8,
        minPoolSize: 0,
        serverSelectionTimeoutMS: 8000,
        connectTimeoutMS: 8000,
        maxIdleTimeMS: 60000,
      });
      connection = client.connect().catch((error) => {
        clients.delete(uri);
        throw error;
      });
      clients.set(uri, connection);
    }
    return connection;
  }

  async function usedThisMonth(coreClient) {
    const month = new Date().toISOString().slice(0, 7);
    const doc = await coreClient.db("q_plat").collection("relay_usage").findOne({ _id: month });
    return { month, bytes: Number(doc?.bytes || 0) };
  }

  function countUsage(coreClient, month, bytes) {
    usageQueue = usageQueue.then(() =>
      coreClient
        .db("q_plat")
        .collection("relay_usage")
        .updateOne({ _id: month }, { $inc: { bytes }, $set: { updatedAt: new Date() } }, { upsert: true }),
    );
    return usageQueue;
  }

  async function copyCoreMetadata(database, quota) {
    const sourceUri = env.MONGODB_CORE_URI;
    const targetUri = env.MONGODB_DATA_URI || env.MONGODB_CORE_URI;
    if (!sourceUri || !targetUri || sourceUri === targetUri)
      throw Object.assign(new Error("Atlas archive and active targets are not configured."), { status: 503 });
    const source = (await clientFor(sourceUri)).db(database);
    const target = (await clientFor(targetUri)).db(database);
    const copied = {};
    let bytes = 0;
    const snapshots = new Map();
    for (const name of CORE_METADATA_COLLECTIONS) {
      const docs = await source.collection(name).find({}).toArray();
      snapshots.set(name, docs);
      copied[name] = docs.length;
      bytes += docs.reduce((total, doc) => total + Buffer.byteLength(EJSON.stringify(doc, { relaxed: false })), 0);
    }
    const relayBytes = Math.max(0, bytes * 2);
    if (quota.used + relayBytes >= MAX_MONTHLY_BYTES)
      throw Object.assign(new Error("Monthly free relay budget reached."), { status: 429 });
    for (const name of CORE_METADATA_COLLECTIONS) {
      const docs = snapshots.get(name);
      if (!docs?.length) continue;
      if (name === "relay_usage") {
        await target.collection(name).bulkWrite(docs.map((doc) => ({
          updateOne: {
            filter: { _id: doc._id },
            update: { $max: { bytes: Number(doc.bytes || 0) }, $set: { updatedAt: doc.updatedAt || new Date() } },
            upsert: true,
          },
        })), { ordered: false });
      } else {
        await target.collection(name).bulkWrite(docs.map((doc) => ({
          replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
        })), { ordered: false });
      }
    }
    await countUsage(quota.coreClient, quota.month, relayBytes);
    return { copied, bytes };
  }

  async function ensureResultIndexes(uri, database) {
    const collection = (await clientFor(uri)).db(database).collection("result_chunks");
    await collection.createIndex({ run: 1, kind: 1, asset: 1, bucket: 1 }, { unique: true });
    await collection.createIndex({ run: 1, kind: 1, startDate: 1, endDate: 1 });
  }

  async function migrateResultBatch(request, quota) {
    const sourceUri = env.MONGODB_CORE_URI;
    if (!sourceUri)
      throw Object.assign(new Error("Atlas archive is not configured."), { status: 503 });
    const args = request.args?.[0] || {};
    const batchSize = Math.max(1, Math.min(128, Number(args.batchSize) || 128));
    const targetUris = request.targetUris;
    if (!Array.isArray(targetUris) || targetUris.length !== 2)
      throw Object.assign(new Error("Both result targets are required."), { status: 503 });
    const uris = targetUris.map((uri, shard) => checkedShardUri(uri, shard));
    const source = (await clientFor(sourceUri)).db(request.database).collection("result_chunks");
    const query = args.cursor ? { _id: { $gt: args.cursor } } : {};
    const records = await source.find(query).sort({ _id: 1 }).limit(batchSize).toArray();
    if (!records.length) return { copied: 0, bytes: 0, done: true, cursor: null };

    const chosen = [];
    let bytes = 0;
    for (const doc of records) {
      const size = Buffer.byteLength(EJSON.stringify(doc, { relaxed: false }));
      if (chosen.length && bytes + size > 8 * 1024 * 1024) break;
      chosen.push(doc);
      bytes += size;
    }
    const byShard = [[], []];
    for (const doc of chosen) byShard[resultShard(doc.run)].push(doc);
    const relayBytes = Math.max(0, bytes * 2);
    if (quota.used + relayBytes >= MAX_MONTHLY_BYTES)
      throw Object.assign(new Error("Monthly free relay budget reached."), { status: 429 });
    for (let shard = 0; shard < byShard.length; shard++) {
      const docs = byShard[shard];
      if (!docs.length) continue;
      await ensureResultIndexes(uris[shard], request.database);
      const collection = (await clientFor(uris[shard])).db(request.database).collection("result_chunks");
      await collection.bulkWrite(docs.map((doc) => ({
        replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
      })), { ordered: false });
      const ids = docs.map((doc) => doc._id);
      const stored = await collection.find({ _id: { $in: ids } }, {
        projection: { _id: 1, run: 1, kind: 1, asset: 1, bucket: 1, count: 1, checksum: 1 },
      }).toArray();
      const checks = new Map(stored.map((doc) => [String(doc._id), doc]));
      if (stored.length !== docs.length || docs.some((doc) => {
        const got = checks.get(String(doc._id));
        return !got || got.run !== doc.run || got.kind !== doc.kind || got.asset !== doc.asset ||
          got.bucket !== doc.bucket || got.count !== doc.count || got.checksum !== doc.checksum;
      }))
        throw Object.assign(new Error("Result batch readback did not match its source."), { status: 500 });
    }
    await countUsage(quota.coreClient, quota.month, relayBytes);
    return {
      copied: chosen.length,
      bytes,
      done: chosen.length === records.length && records.length < batchSize,
      cursor: chosen.at(-1)._id,
    };
  }

  async function runOperation(request, quota) {
    const { database, collection: collectionName, operation } = request;
    if (operation === "migrateCoreMetadata") return copyCoreMetadata(database, quota);
    if (operation === "migrateResultBatch") return migrateResultBatch(request, quota);
    if (collectionName === "result_chunks" && operation === "createIndex") {
      if (!Array.isArray(request.targetUris) || request.targetUris.length !== 2)
        throw Object.assign(new Error("Both result targets are required."), { status: 503 });
      const uris = request.targetUris.map((uri, shard) => checkedShardUri(uri, shard));
      return Promise.all(uris.map(async (uri) =>
        (await clientFor(uri)).db(database).collection(collectionName).createIndex(...request.args),
      ));
    }
    if (collectionName === "bars" && operation === "createIndex") {
      if (!Array.isArray(request.targetUris) || request.targetUris.length !== 2)
        throw Object.assign(new Error("Both dataset shards are required."), { status: 503 });
      const dataUri = env.MONGODB_DATA_URI || env.MONGODB_CORE_URI;
      if (!dataUri)
        throw Object.assign(new Error("Active dataset storage is not configured."), { status: 503 });
      const uris = [dataUri, ...request.targetUris.map((uri, shard) => checkedShardUri(uri, shard))];
      return Promise.all(uris.map(async (uri) =>
        (await clientFor(uri)).db(database).collection(collectionName).createIndex(...request.args),
      ));
    }
    let uri;
    if (collectionName === "result_chunks") {
      const shard = resultShard(resultRun(request));
      uri = checkedShardUri(request.targetUri, shard);
    } else if (collectionName === "bars" && /^qt70[ab]-/.test(barVersion(request) || "")) {
      const version = barVersion(request);
      const shard = version.startsWith("qt70a-") ? 0 : 1;
      uri = checkedShardUri(request.targetUri, shard);
    } else ({ uri } = mongoTarget(database, collectionName, env));
    const selected = await clientFor(uri);
    const collection = selected.db(database).collection(collectionName);
    if (operation === "ping") return selected.db(database).command({ ping: 1 });
    if (operation === "find") {
      let cursor = collection.find(request.filter || {}, request.options || {});
      if (request.sort) cursor = cursor.sort(request.sort);
      if (Number.isInteger(request.skip) && request.skip > 0) cursor = cursor.skip(request.skip);
      if (Number.isInteger(request.limit) && request.limit > 0) cursor = cursor.limit(request.limit);
      if (request.projection) cursor = cursor.project(request.projection);
      return cursor.toArray();
    }
    if (!OPERATIONS.has(operation))
      throw Object.assign(new Error("MongoDB operation is not allowed."), { status: 403 });
    if (!Array.isArray(request.args))
      throw Object.assign(new Error("MongoDB operation arguments are invalid."), { status: 400 });
    return collection[operation](...request.args);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") {
      if (url.searchParams.get("deep") !== "1")
        return json(res, 200, { ok: true });
      try {
        const { uri: coreUri } = mongoTarget("q_plat", "workspaces", env);
        const core = (await clientFor(coreUri)).db("q_plat");
        await core.command({ ping: 1 });
        await core.collection("relay_usage").findOne({ _id: "health-check" });
        const { uri: dataUri } = mongoTarget("q_plat", "bars", env);
        if (dataUri !== coreUri) {
          const data = (await clientFor(dataUri)).db("q_plat");
          await data.command({ ping: 1 });
          await data.collection("bars").findOne({}, { projection: { _id: 1 } });
        }
        return json(res, 200, { ok: true, core: "connected", data: "connected" });
      } catch (error) {
        return json(res, 503, { ok: false, ...errorDiagnostic(error) });
      }
    }
    if (req.method !== "POST" || req.url !== "/rpc")
      return json(res, 404, { ok: false, error: "Not found." });
    if (activeRequests >= MAX_ACTIVE_REQUESTS)
      return json(res, 429, { ok: false, error: "Relay is at capacity." });

    activeRequests += 1;
    let stage = "usage";
    let request;
    try {
      const input = await readBody(req);
      const now = Date.now();
      for (const [nonce, expiresAt] of seenNonces)
        if (expiresAt <= now) seenNonces.delete(nonce);
      if (!verifyRequest(publicKey, req.headers, input, seenNonces, now))
        throw Object.assign(new Error("Unauthorized."), { status: 401 });
      try {
        request = EJSON.parse(input);
      } catch {
        throw Object.assign(new Error("Invalid EJSON request."), { status: 400 });
      }
      mongoTarget(request.database, request.collection, env);
      const { uri: coreUri } = mongoTarget("q_plat", "workspaces", env);
      const coreClient = await clientFor(coreUri);
      const { month, bytes: used } = await usedThisMonth(coreClient);
      if (used >= MAX_MONTHLY_BYTES)
        throw Object.assign(new Error("Monthly free relay budget reached."), { status: 429 });

      stage = "operation";
      const result = await runOperation(request, { coreClient, month, used });
      const output = EJSON.stringify({ ok: true, result }, { relaxed: false });
      const approximateBytes = 2 * (Buffer.byteLength(input) + Buffer.byteLength(output)) + 8192;
      if (used + approximateBytes >= MAX_MONTHLY_BYTES) {
        await countUsage(coreClient, month, Math.max(0, MAX_MONTHLY_BYTES - used));
        throw Object.assign(new Error("Monthly free relay budget reached."), { status: 429 });
      }
      await countUsage(coreClient, month, approximateBytes);
      if (Buffer.byteLength(output) > MAX_RESPONSE_BYTES)
        throw Object.assign(new Error("MongoDB response is too large."), { status: 413 });
      res.writeHead(200, {
        "content-type": "application/ejson; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(output),
        "x-content-type-options": "nosniff",
      });
      res.end(output);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      const safeDetail =
        request?.operation === "ping" ||
        (request?.operation === "findOne" &&
          request.collection === "workspaces" &&
          request.args?.[0]?._id === "__health_probe__") ||
        (request?.operation === "createIndex" &&
          ["bars", "datasets", "dataset_versions"].includes(request.collection));
      json(res, status, {
        ok: false,
        error: error?.message || "MongoDB relay failed.",
        diagnostic: {
          ...errorDiagnostic(error),
          stage,
          ...(safeDetail
            ? {
                detail: String(error?.message || "")
                  .replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, "[redacted-uri]")
                  .replace(/\b(password|pwd|token|secret|signature)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
                  .replace(/\s+/g, " ")
                  .slice(0, 180),
              }
            : {}),
          ...(typeof request?.operation === "string" &&
          /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(request.operation)
            ? { operation: request.operation }
            : {}),
          ...(stage === "operation" ? { collection: request?.collection } : { collection: "relay_usage" }),
        },
      });
    } finally {
      activeRequests -= 1;
    }
  });
  return { server, close: async () => Promise.all([...clients.values()].map(async (promise) => (await promise).close())) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.MONGODB_RELAY_PUBLIC_KEY || !process.env.MONGODB_CORE_URI || !process.env.MONGODB_DATA_URI) {
    throw new Error("MONGODB_RELAY_PUBLIC_KEY, MONGODB_CORE_URI, and MONGODB_DATA_URI are required.");
  }
  const { server } = createRelayServer();
  const port = Number(process.env.PORT || 10000);
  server.listen(port, "0.0.0.0", () => process.stdout.write(`MongoDB relay listening on ${port}\n`));
}
