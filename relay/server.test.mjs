import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { EJSON } from "bson";
import { createRelayServer } from "./server.mjs";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
function signedRequest(request, nonce = randomUUID()) {
  const body = EJSON.stringify(request, { relaxed: false });
  const timestamp = String(Date.now());
  const digest = createHash("sha256").update(body).digest("hex");
  const message = `${timestamp}.${nonce}.${digest}`;
  const signature = sign(null, Buffer.from(message), keys.privateKey).toString("base64url");
  return {
    body,
    headers: {
      "x-qtpatuti-timestamp": timestamp,
      "x-qtpatuti-nonce": nonce,
      "x-qtpatuti-signature": signature,
      "content-type": "application/ejson",
    },
  };
}

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
      command: async ({ ping }) => ({ ok: ping === 1 ? 1 : 0 }),
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
    MONGODB_RELAY_PUBLIC_KEY: publicKey,
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

test("RPC allows a signed health ping through the core database only", async () => {
  const signed = signedRequest({
    database: "q_plat",
    collection: "workspaces",
    operation: "ping",
    args: [],
  });
  const response = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: signed.headers,
    body: signed.body,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(EJSON.parse(await response.text()).result, { ok: 1 });
});

test("RPC requires a fresh signature from the Vercel private key", async () => {
  const response = await fetch(`${base}/rpc`, { method: "POST", body: "{}" });
  assert.equal(response.status, 401);
});

test("RPC limits databases before opening a MongoDB connection", async () => {
  const before = clients.length;
  const signed = signedRequest({
    database: "other",
    collection: "jobs",
    operation: "countDocuments",
    args: [{}],
  });
  const response = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: signed.headers,
    body: signed.body,
  });
  assert.equal(response.status, 403);
  assert.equal(clients.length, before);
});

test("RPC routes market bars to the data cluster and metadata to the core cluster", async () => {
  const request = (collection) =>
    {
      const signed = signedRequest({
        database: "q_plat",
        collection,
        operation: "countDocuments",
        args: [{}],
      });
      return fetch(`${base}/rpc`, { method: "POST", headers: signed.headers, body: signed.body });
    };
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
  const signed = signedRequest({
    database: "q_plat",
    collection: "jobs",
    operation: "countDocuments",
    args: [{}],
  });
  const response = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: signed.headers,
    body: signed.body,
  });
  assert.equal(response.status, 429);
  assert.equal(mongoReadCount, before);
  storedUsage = 0;
});

test("RPC rejects a replayed signed request", async () => {
  const signed = signedRequest({
    database: "q_plat",
    collection: "jobs",
    operation: "countDocuments",
    args: [{}],
  });
  const send = () =>
    fetch(`${base}/rpc`, { method: "POST", headers: signed.headers, body: signed.body });
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 401);
});
