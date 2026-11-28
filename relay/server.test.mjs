import assert from "node:assert/strict";
import { after, test } from "node:test";
import { EJSON } from "bson";
import { createRelayServer } from "./server.mjs";

const clients = [];
let storedUsage = 0;
let mongoReadCount = 0;
class FakeClient {
  constructor(uri) {
    this.uri = uri;
    this.closed = false;
    clients.push(this);
  }
  async connect() {
    return this;
  }
  db(name) {
    return {
      collection: (collection) => ({
        findOne: async () =>
          collection === "relay_usage" ? { bytes: storedUsage } : { name, collection },
        updateOne: async (_filter, update) => {
          if (collection === "relay_usage") storedUsage += update.$inc.bytes;
          return { acknowledged: true };
        },
        countDocuments: async () => {
          mongoReadCount += 1;
          return 7;
        },
      }),
    };
  }
  async close() {
    this.closed = true;
  }
}

const relay = createRelayServer({
  env: {
    MONGODB_RELAY_SECRET: "a-test-only-secret",
    MONGODB_CORE_URI: "mongodb://core.invalid",
    MONGODB_DATA_URI: "mongodb://data.invalid",
  },
  Client: FakeClient,
});
relay.server.listen(0, "127.0.0.1");
await new Promise((resolve) => relay.server.once("listening", resolve));
const base = `http://127.0.0.1:${relay.server.address().port}`;
after(async () => {
  await new Promise((resolve) => relay.server.close(resolve));
  await relay.close();
});

test("health endpoint does not expose Atlas configuration", async () => {
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("RPC requires the server-side secret", async () => {
  const response = await fetch(`${base}/rpc`, { method: "POST", body: "{}" });
  assert.equal(response.status, 401);
});

test("RPC limits databases before opening a MongoDB connection", async () => {
  const before = clients.length;
  const response = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: {
      authorization: "Bearer a-test-only-secret",
      "content-type": "application/ejson",
    },
    body: '{"database":"other","collection":"jobs","operation":"countDocuments","args":[{}]}',
  });
  assert.equal(response.status, 403);
  assert.equal(clients.length, before);
});

test("RPC routes market bars to the data cluster and metadata to the core cluster", async () => {
  const headers = {
    authorization: "Bearer a-test-only-secret",
    "content-type": "application/ejson",
  };
  const request = (collection) =>
    fetch(`${base}/rpc`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        database: "q_plat",
        collection,
        operation: "countDocuments",
        args: [{}],
      }),
    });
  const bars = await request("bars");
  const barsBody = EJSON.parse(await bars.text());
  assert.equal(bars.status, 200);
  assert.equal(barsBody.result, 7);
  const jobs = await request("jobs");
  assert.equal(jobs.status, 200);
  assert.equal(EJSON.parse(await jobs.text()).result, 7);
  assert.deepEqual(
    [...new Set(clients.map((client) => client.uri))].sort(),
    ["mongodb://core.invalid", "mongodb://data.invalid"],
  );
});

test("RPC stops before Atlas reads when the free monthly budget is reached", async () => {
  storedUsage = 10 * 1024 * 1024 * 1024;
  const before = mongoReadCount;
  const response = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: {
      authorization: "Bearer a-test-only-secret",
      "content-type": "application/ejson",
    },
    body: JSON.stringify({
      database: "q_plat",
      collection: "jobs",
      operation: "countDocuments",
      args: [{}],
    }),
  });
  assert.equal(response.status, 429);
  assert.equal(mongoReadCount, before);
  storedUsage = 0;
});
