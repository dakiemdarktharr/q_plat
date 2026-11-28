import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { EJSON } from "bson";
import { bulkUpsert, db, migrateAtlasOperation } from "../lib/db.mjs";

const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const envKeys = ["MONGODB_RELAY_URL", "MONGODB_RELAY_PRIVATE_KEY", "MONGODB_URI", "MONGODB_SHARD_URI_A", "MONGODB_SHARD_URI_B"];
const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.MONGODB_RELAY_URL = "https://relay.example.test";
process.env.MONGODB_RELAY_PRIVATE_KEY = privateKey;
process.env.MONGODB_SHARD_URI_A = "mongodb+srv://user:pass@qplatresults01.xui2vfx.mongodb.net";
process.env.MONGODB_SHARD_URI_B = "mongodb+srv://user:pass@qplatresults02.f5cdfhi.mongodb.net";
delete process.env.MONGODB_URI;
const originalFetch = globalThis.fetch;
let captured;
let capturedRequests = [];
let pagedRows = null;
let responseTooLargeAbove = null;
let capacityResponsesRemaining = 0;
globalThis.fetch = async (url, options) => {
  captured = { url: String(url), options, request: EJSON.parse(options.body) };
  capturedRequests.push({
    ...captured.request,
    nonce: options.headers["x-qtpatuti-nonce"],
  });
  const timestamp = options.headers["x-qtpatuti-timestamp"];
  const nonce = options.headers["x-qtpatuti-nonce"];
  const signature = options.headers["x-qtpatuti-signature"];
  const digest = createHash("sha256").update(options.body).digest("hex");
  assert.ok(verify(null, Buffer.from(`${timestamp}.${nonce}.${digest}`), keys.publicKey, Buffer.from(signature, "base64url")));
  if (
    responseTooLargeAbove &&
    captured.request.collection === "result_chunks" &&
    captured.request.limit > responseTooLargeAbove
  )
    return new Response(
      EJSON.stringify(
        { ok: false, error: "MongoDB response is too large.", status: 413 },
        { relaxed: false },
      ),
      { status: 413, headers: { "content-type": "application/ejson" } },
    );
  if (capacityResponsesRemaining > 0) {
    capacityResponsesRemaining--;
    return new Response(
      EJSON.stringify(
        { ok: false, error: "Relay is at capacity." },
        { relaxed: false },
      ),
      { status: 429, headers: { "content-type": "application/ejson" } },
    );
  }
  const result =
    captured.request.operation === "countDocuments"
      ? 0
      : captured.request.operation === "ping"
        ? { ok: 1 }
        : pagedRows
          ? pagedRows.slice(
              captured.request.skip || 0,
              (captured.request.skip || 0) + captured.request.limit,
            )
          : [{ date: new Date("2021-01-04T00:00:00Z"), close: 12.5 }];
  return new Response(
    EJSON.stringify({ ok: true, result }, { relaxed: false }),
    { status: 200, headers: { "content-type": "application/ejson" } },
  );
};

after(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

test("database relay pages large result sets below the response cap", async () => {
  capturedRequests = [];
  pagedRows = Array.from({ length: 8500 }, (_, id) => ({ id }));
  try {
    const rows = await (await db()).collection("bars").find({ version: "fixture" }).limit(8500).toArray();
    assert.equal(rows.length, 8500);
    assert.deepEqual(
      capturedRequests.map(({ skip, limit }) => [skip, limit]),
      [[0, 4000], [4000, 4000], [8000, 500]],
    );
  } finally {
    pagedRows = null;
  }
});

test("database relay learns a smaller page size for large result chunks", async () => {
  capturedRequests = [];
  pagedRows = Array.from({ length: 145 }, (_, id) => ({ id }));
  responseTooLargeAbove = 16;
  try {
    const rows = await (await db())
      .collection("result_chunks")
      .find({ run: "fixture" })
      .limit(145)
      .toArray();
    assert.equal(rows.length, 145);
    assert.match(capturedRequests[0].targetUri, /^mongodb\+srv:\/\/user:pass@qplatresults0[12]\.\w+\.mongodb\.net$/);
    assert.deepEqual(
      capturedRequests.slice(0, 3).map(({ skip, limit }) => [skip, limit]),
      [[0, 64], [0, 32], [0, 16]],
    );
    assert.equal(capturedRequests.at(-1).skip, 144);
  } finally {
    pagedRows = null;
    responseTooLargeAbove = null;
  }
});

test("result index requests carry both private Atlas targets for replica creation", async () => {
  capturedRequests = [];
  const database = await db();
  await database.collection("result_chunks").createIndex({ run: 1, kind: 1 });
  assert.equal(capturedRequests.length, 1);
  assert.deepEqual(captured.request.targetUris, [
    process.env.MONGODB_SHARD_URI_A,
    process.env.MONGODB_SHARD_URI_B,
  ]);
  assert.equal(captured.request.targetUri, undefined);
});

test("new quant panel bars route by declared data shard", async () => {
  capturedRequests = [];
  const database = await db();
  await database.collection("bars").find({ version: "qt70a-momentum-abc" }).limit(1).toArray();
  assert.equal(captured.request.targetUri, process.env.MONGODB_SHARD_URI_A);
  await database.collection("bars").find({ version: "qt70b-value-abc" }).limit(1).toArray();
  assert.equal(captured.request.targetUri, process.env.MONGODB_SHARD_URI_B);
  await database.collection("bars").find({ version: "uci-0353fe3533bfe8a0075e" }).limit(1).toArray();
  assert.equal(captured.request.targetUri, undefined);
});

test("bars index requests fan out to both quant panel shards", async () => {
  capturedRequests = [];
  const database = await db();
  await database.collection("bars").createIndex({ version: 1, date: 1 });
  assert.equal(captured.request.collection, "bars");
  assert.deepEqual(captured.request.targetUris, [
    process.env.MONGODB_SHARD_URI_A,
    process.env.MONGODB_SHARD_URI_B,
  ]);
});

test("Atlas migration RPC contains only shard targets and checkpoint arguments", async () => {
  capturedRequests = [];
  await migrateAtlasOperation("migrateResultBatch", { batchSize: 128 });
  assert.equal(captured.request.operation, "migrateResultBatch");
  assert.equal(captured.request.args[0].batchSize, 128);
  assert.deepEqual(captured.request.targetUris, [
    process.env.MONGODB_SHARD_URI_A,
    process.env.MONGODB_SHARD_URI_B,
  ]);
  assert.equal("documents" in captured.request, false);
});

test("database relay retries transient capacity errors with fresh signatures", async () => {
  capturedRequests = [];
  capacityResponsesRemaining = 2;
  try {
    const count = await (await db()).collection("jobs").countDocuments({});
    assert.equal(count, 0);
    assert.equal(capturedRequests.length, 3);
    assert.notEqual(capturedRequests[0].nonce, capturedRequests[1].nonce);
    assert.notEqual(capturedRequests[1].nonce, capturedRequests[2].nonce);
  } finally {
    capacityResponsesRemaining = 0;
  }
});

test("database relay preserves BSON dates and cursor clauses", async () => {
  const database = await db();
  const rows = await database
    .collection("bars")
    .find({ date: { $gte: new Date("2021-01-01T00:00:00Z") } }, { projection: { close: 1 } })
    .sort({ date: 1, asset: 1 })
    .limit(12)
    .toArray();
  assert.equal(captured.url, "https://relay.example.test/rpc");
  assert.equal(captured.options.headers["x-qtpatuti-signature"].length > 0, true);
  assert.equal(captured.request.collection, "bars");
  assert.equal(captured.request.limit, 12);
  assert.deepEqual(captured.request.sort, { date: 1, asset: 1 });
  assert.ok(captured.request.filter.date.$gte instanceof Date);
  assert.ok(rows[0].date instanceof Date);
  assert.equal(rows[0].close, 12.5);
});

test("database relay exposes only the supported collection operations", async () => {
  const database = await db();
  assert.equal(await database.collection("jobs").countDocuments({ status: "queued" }), 0);
  assert.equal(captured.request.operation, "countDocuments");
  assert.equal(database.collection("jobs").drop, undefined);
});

test("database relay routes the health ping to Atlas", async () => {
  const database = await db();
  assert.deepEqual(await database.command({ ping: 1 }), { ok: 1 });
  assert.equal(captured.request.operation, "ping");
  assert.equal(captured.request.collection, "workspaces");
  assert.throws(() => database.command({ dropDatabase: 1 }));
});

test("bulk writes use bounded configurable batches", async () => {
  const sizes = [];
  await bulkUpsert(
    {
      bulkWrite: async (operations) => sizes.push(operations.length),
    },
    Array.from({ length: 4500 }, (_, id) => ({ id, value: id })),
    ["id"],
    2000,
  );
  assert.deepEqual(sizes, [2000, 2000, 500]);
});
