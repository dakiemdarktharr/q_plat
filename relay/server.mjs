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
const DATA_COLLECTIONS = new Set(["bars", "datasets", "dataset_versions"]);
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
  const uri = DATA_COLLECTIONS.has(collection)
    ? env.MONGODB_DATA_URI || env.MONGODB_CORE_URI
    : env.MONGODB_CORE_URI || env.MONGODB_DATA_URI;
  if (!uri) throw Object.assign(new Error("Atlas URI is not configured."), { status: 503 });
  return { uri, database };
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

  async function runOperation(request) {
    const { database, collection: collectionName, operation } = request;
    const { uri } = mongoTarget(database, collectionName, env);
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
    if (req.method === "GET" && req.url === "/healthz")
      return json(res, 200, { ok: true });
    if (req.method !== "POST" || req.url !== "/rpc")
      return json(res, 404, { ok: false, error: "Not found." });
    if (activeRequests >= MAX_ACTIVE_REQUESTS)
      return json(res, 429, { ok: false, error: "Relay is at capacity." });

    activeRequests += 1;
    try {
      const input = await readBody(req);
      const now = Date.now();
      for (const [nonce, expiresAt] of seenNonces)
        if (expiresAt <= now) seenNonces.delete(nonce);
      if (!verifyRequest(publicKey, req.headers, input, seenNonces, now))
        throw Object.assign(new Error("Unauthorized."), { status: 401 });
      let request;
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

      const result = await runOperation(request);
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
      json(res, status, { ok: false, error: error?.message || "MongoDB relay failed." });
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
