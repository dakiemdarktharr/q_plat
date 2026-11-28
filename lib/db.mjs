import { MongoClient } from "mongodb";
import { EJSON } from "bson";
import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
export function hash(value) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}
const connections = new Map();
const indexes = new Map();
let relayPrivateKey;
const DATA_COLLECTIONS = new Set(["bars", "dataset_versions", "datasets"]);
const RELAY_COLLECTION_METHODS = new Set([
  "bulkWrite",
  "countDocuments",
  "createIndex",
  "deleteMany",
  "deleteOne",
  "findOne",
  "findOneAndUpdate",
  "insertOne",
  "updateMany",
  "updateOne",
]);
const RELAY_FIND_BATCH_SIZE = 4000;
const RELAY_RESULT_BATCH_SIZE = 64;

async function relayCall(request) {
  const base = process.env.MONGODB_RELAY_URL?.replace(/\/+$/, "");
  const encodedKey = process.env.MONGODB_RELAY_PRIVATE_KEY;
  if (!base || !encodedKey)
    throw Object.assign(new Error("MongoDB relay is not configured."), {
      status: 503,
    });
  if (!relayPrivateKey)
    relayPrivateKey = createPrivateKey({
      key: Buffer.from(encodedKey, "base64"),
      format: "der",
      type: "pkcs8",
    });
  const body = EJSON.stringify(request, { relaxed: false });
  const digest = createHash("sha256").update(body).digest("hex");
  for (let attempt = 0; attempt < 6; attempt++) {
    const timestamp = String(Date.now()),
      nonce = randomUUID(),
      message = `${timestamp}.${nonce}.${digest}`,
      response = await fetch(`${base}/rpc`, {
        method: "POST",
        headers: {
          "x-qtpatuti-timestamp": timestamp,
          "x-qtpatuti-nonce": nonce,
          "x-qtpatuti-signature": sign(
            null,
            Buffer.from(message),
            relayPrivateKey,
          ).toString("base64url"),
          "content-type": "application/ejson",
        },
        body,
        cache: "no-store",
      });
    const text = await response.text();
    let envelope;
    try {
      envelope = EJSON.parse(text);
    } catch {
      throw new Error(
        `MongoDB relay returned an invalid response (${response.status}).`,
      );
    }
    if (response.ok && envelope?.ok === true) return envelope.result;
    if (
      response.status === 429 &&
      envelope?.error === "Relay is at capacity." &&
      attempt < 5
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, 25 * 2 ** attempt + Math.random() * 25),
      );
      continue;
    }
    const error = new Error(
      envelope?.error || `MongoDB relay failed (${response.status}).`,
    );
    if (Number.isInteger(envelope?.status)) error.status = envelope.status;
    throw error;
  }
  throw new Error("MongoDB relay retry limit reached.");
}

function relayCursor(databaseName, collectionName, filter, options) {
  const state = {
    sort: undefined,
    limit: undefined,
    skip: undefined,
    projection: undefined,
  };
  const cursor = {
    sort(value) {
      state.sort = value;
      return this;
    },
    limit(value) {
      state.limit = value;
      return this;
    },
    skip(value) {
      state.skip = value;
      return this;
    },
    project(value) {
      state.projection = value;
      return this;
    },
    async toArray() {
      const rows = [];
      let offset = state.skip || 0;
      let batchSize =
        collectionName === "result_chunks"
          ? RELAY_RESULT_BATCH_SIZE
          : RELAY_FIND_BATCH_SIZE;
      const requested = state.limit > 0 ? state.limit : Infinity;
      while (rows.length < requested) {
        const limit = Math.min(batchSize, requested - rows.length);
        let page;
        try {
          page = await relayCall({
            database: databaseName,
            collection: collectionName,
            operation: "find",
            filter: filter ?? {},
            options: options ?? {},
            ...state,
            skip: offset,
            limit,
          });
        } catch (error) {
          if (error.status !== 413 || limit <= 1) throw error;
          batchSize = Math.max(1, Math.floor(limit / 2));
          continue;
        }
        rows.push(...page);
        offset += page.length;
        if (page.length < limit) break;
      }
      return rows;
    },
  };
  return cursor;
}

function relayDatabase(databaseName) {
  return {
    databaseName,
    command(command) {
      if (
        command?.ping !== 1 ||
        Object.keys(command).some((key) => key !== "ping")
      )
        throw new Error("The MongoDB relay only supports the ping command.");
      return relayCall({
        database: databaseName,
        collection: "workspaces",
        operation: "ping",
        args: [],
      });
    },
    collection(name) {
      if (typeof name !== "string" || !/^[a-z_][a-z0-9_]{0,63}$/i.test(name))
        throw new Error("Invalid MongoDB collection name.");
      return new Proxy(
        {},
        {
          get(_target, method) {
            if (method === "find")
              return (filter, options) =>
                relayCursor(databaseName, name, filter, options);
            if (!RELAY_COLLECTION_METHODS.has(method)) return undefined;
            return (...args) =>
              relayCall({
                database: databaseName,
                collection: name,
                operation: method,
                args,
              });
          },
        },
      );
    },
  };
}

async function clientFor(uri) {
  if (!uri)
    throw Object.assign(new Error("MongoDB Atlas is not configured."), {
      status: 503,
    });
  let connection = connections.get(uri);
  if (!connection) {
    const client = new MongoClient(uri, {
      maxPoolSize: 8,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      maxIdleTimeMS: 60000,
    });
    connection = client.connect().catch((e) => {
      connections.delete(uri);
      throw e;
    });
    connections.set(uri, connection);
  }
  return connection;
}

export async function db(databaseName = process.env.MONGODB_DB || "q_plat") {
  if (process.env.MONGODB_RELAY_URL || process.env.MONGODB_RELAY_PRIVATE_KEY) {
    if (
      !process.env.MONGODB_RELAY_URL ||
      !process.env.MONGODB_RELAY_PRIVATE_KEY
    )
      throw Object.assign(new Error("MongoDB relay is not configured."), {
        status: 503,
      });
    return relayDatabase(databaseName);
  }
  if (
    !process.env.MONGODB_URI &&
    !process.env.MONGODB_CORE_URI &&
    !process.env.MONGODB_DATA_URI
  )
    throw Object.assign(new Error("MongoDB Atlas is not configured."), {
      status: 503,
    });
  const primaryUri =
    process.env.MONGODB_CORE_URI ||
    process.env.MONGODB_URI ||
    process.env.MONGODB_DATA_URI;
  const primary = await clientFor(primaryUri);
  const database = primary.db(databaseName);
  if (
    !process.env.MONGODB_DATA_URI ||
    process.env.MONGODB_DATA_URI === primaryUri
  )
    return database;
  const secondary = await clientFor(process.env.MONGODB_DATA_URI);
  return new Proxy(database, {
    get(target, property) {
      if (property === "collection")
        return (name, options) =>
          DATA_COLLECTIONS.has(name)
            ? secondary.db(databaseName).collection(name, options)
            : target.collection(name, options);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
export async function schema(database) {
  if (indexes.has(database.databaseName))
    return indexes.get(database.databaseName);
  const indexing = (async () => {
    const specs = {
      bars: [
        [{ version: 1, asset: 1, date: 1 }, { unique: true }],
        [{ version: 1, date: 1, asset: 1 }, {}],
      ],
      dataset_versions: [[{ dataset: 1, status: 1, createdAt: -1 }, {}]],
      edge_versions: [
        [{ workspace: 1, edge: 1, version: 1 }, { unique: true }],
      ],
      edges: [[{ workspace: 1, updatedAt: -1 }, {}]],
      runs: [
        [{ workspace: 1, createdAt: -1 }, {}],
        [{ workspace: 1, runHash: 1 }, {}],
      ],
      run_series: [[{ run: 1, kind: 1, date: 1, asset: 1 }, { unique: true }]],
      ledger_events: [[{ run: 1, event: 1 }, { unique: true }]],
      result_chunks: [
        [{ run: 1, kind: 1, asset: 1, bucket: 1 }, { unique: true }],
        [{ run: 1, kind: 1, startDate: 1, endDate: 1 }, {}],
      ],
      jobs: [
        [{ workspace: 1, createdAt: -1 }, {}],
        [
          { workspace: 1, slot: 1 },
          {
            unique: true,
            partialFilterExpression: {
              slot: { $exists: true },
              status: { $in: ["queued", "running", "retrying", "committing"] },
            },
          },
        ],
      ],
      sessions: [[{ expiresAt: 1 }, { expireAfterSeconds: 0 }]],
      api_tokens: [
        [{ workspace: 1, createdAt: -1 }, {}],
        [{ id: 1 }, { unique: true }],
        [{ expiresAt: 1 }, { expireAfterSeconds: 0 }],
      ],
      rate_limits: [[{ expiresAt: 1 }, { expireAfterSeconds: 0 }]],
      workspaces: [[{ name: 1 }, { unique: true }]],
    };
    for (const [name, items] of Object.entries(specs))
      for (const [key, opts] of items)
        await database.collection(name).createIndex(key, opts);
    return true;
  })().catch((e) => {
    indexes.delete(database.databaseName);
    throw e;
  });
  indexes.set(database.databaseName, indexing);
  return indexing;
}
export async function bulkUpsert(collection, rows, keys, batchSize = 400) {
  for (let i = 0; i < rows.length; i += batchSize)
    await collection.bulkWrite(
      rows.slice(i, i + batchSize).map((row) => ({
        updateOne: {
          filter: Object.fromEntries(keys.map((k) => [k, row[k]])),
          update: { $set: row },
          upsert: true,
        },
      })),
      { ordered: false },
    );
}
