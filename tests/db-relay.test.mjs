import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { EJSON } from "bson";
import { bulkUpsert, db } from "../lib/db.mjs";

const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const envKeys = ["MONGODB_RELAY_URL", "MONGODB_RELAY_PRIVATE_KEY", "MONGODB_URI"];
const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.MONGODB_RELAY_URL = "https://relay.example.test";
process.env.MONGODB_RELAY_PRIVATE_KEY = privateKey;
delete process.env.MONGODB_URI;
const originalFetch = globalThis.fetch;
let captured;
let capturedRequests = [];
let pagedRows = null;
globalThis.fetch = async (url, options) => {
  captured = { url: String(url), options, request: EJSON.parse(options.body) };
  capturedRequests.push(captured.request);
  const timestamp = options.headers["x-qtpatuti-timestamp"];
  const nonce = options.headers["x-qtpatuti-nonce"];
  const signature = options.headers["x-qtpatuti-signature"];
  const digest = createHash("sha256").update(options.body).digest("hex");
  assert.ok(verify(null, Buffer.from(`${timestamp}.${nonce}.${digest}`), keys.publicKey, Buffer.from(signature, "base64url")));
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
