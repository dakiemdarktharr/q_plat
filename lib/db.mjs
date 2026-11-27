import { MongoClient } from "mongodb";
import { createHash } from "node:crypto";
export function hash(value) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}
let connection;
const indexes = new Map();
export async function db(databaseName = process.env.MONGODB_DB || "q_plat") {
  if (!process.env.MONGODB_URI)
    throw Object.assign(new Error("MongoDB Atlas is not configured."), {
      status: 503,
    });
  if (!connection) {
    const client = new MongoClient(process.env.MONGODB_URI, {
      maxPoolSize: 8,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      maxIdleTimeMS: 60000,
    });
    connection = client.connect().catch((e) => {
      connection = null;
      throw e;
    });
  }
  const client = await connection;
  return client.db(databaseName);
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
export async function bulkUpsert(collection, rows, keys) {
  for (let i = 0; i < rows.length; i += 400)
    await collection.bulkWrite(
      rows.slice(i, i + 400).map((row) => ({
        updateOne: {
          filter: Object.fromEntries(keys.map((k) => [k, row[k]])),
          update: { $set: row },
          upsert: true,
        },
      })),
      { ordered: false },
    );
}
