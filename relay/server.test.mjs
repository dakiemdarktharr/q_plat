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
let blockAtlasReads = false;
let atlasReadGate = null;
let atlasReadsReached = 0;
let releaseEightAtlasReads;
let failingUri = null;
let failingReadUri = null;
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
      command: async ({ ping }) => {
        if (this.uri === failingUri)
          throw Object.assign(new Error("Atlas unavailable"), { code: "ETIMEDOUT" });
        return { ok: ping === 1 ? 1 : 0 };
      },
      collection: (collection) => ({
        findOne: async () => {
          if (this.uri === failingReadUri)
            throw Object.assign(new Error("bad auth: Authentication failed."), { code: 8000 });
          return collection === "relay_usage"
            ? { bytes: storedUsage }
            : { name, collection };
        },
        updateOne: async (_filter, update) => {
          if (collection === "relay_usage") storedUsage += update.$inc.bytes;
          return { acknowledged: true };
        },
        countDocuments: async () => {
          mongoReadCount += 1;
          if (blockAtlasReads) {
            atlasReadsReached++;
            if (atlasReadsReached === 8) releaseEightAtlasReads?.();
            await atlasReadGate;
          }
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

test("deep health endpoint pings both Atlas clusters", async () => {
  const response = await fetch(`${base}/healthz?deep=1`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    core: "connected",
    data: "connected",
  });
});

test("deep health endpoint checks read access and classifies auth failures", async () => {
  failingReadUri = "mongodb://core.invalid";
  try {
    const response = await fetch(`${base}/healthz?deep=1`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      ok: false,
      name: "Error",
      code: "8000",
      kind: "authentication",
    });
  } finally {
    failingReadUri = null;
  }
});

test("RPC diagnostics identify relay usage reads without exposing messages", async () => {
  failingReadUri = "mongodb://core.invalid";
  try {
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
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.diagnostic.stage, "usage");
    assert.equal(body.diagnostic.collection, "relay_usage");
    assert.equal(body.diagnostic.code, "8000");
    assert.equal(body.diagnostic.kind, "authentication");
    assert.equal("Atlas unavailable" in body, false);
  } finally {
    failingReadUri = null;
  }
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
  const plans = await request("dataset_ingest_plans");
  assert.equal(plans.status, 200);
  assert.equal(EJSON.parse(await plans.text()).result, 7);
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

test("RPC serves eight concurrent Atlas operations and rejects the ninth", async () => {
  let releaseReads;
  const gate = new Promise((resolve) => (releaseReads = resolve));
  let resolveEight;
  const eightReads = new Promise((resolve) => (resolveEight = resolve));
  atlasReadGate = gate;
  atlasReadsReached = 0;
  releaseEightAtlasReads = resolveEight;
  blockAtlasReads = true;
  const send = () => {
    const signed = signedRequest({
      database: "q_plat",
      collection: "jobs",
      operation: "countDocuments",
      args: [{}],
    });
    return fetch(`${base}/rpc`, {
      method: "POST",
      headers: signed.headers,
      body: signed.body,
    });
  };
  const firstEight = Array.from({ length: 8 }, send);
  try {
    await Promise.race([
      eightReads,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Eight reads did not enter Atlas.")), 5000),
      ),
    ]);
    const overflow = await send();
    assert.equal(overflow.status, 429);
    assert.equal((await overflow.json()).error, "Relay is at capacity.");
  } finally {
    blockAtlasReads = false;
    releaseReads();
    atlasReadGate = null;
    releaseEightAtlasReads = null;
  }
  const responses = await Promise.all(firstEight);
  assert.equal(responses.filter((response) => response.status === 200).length, 8);
});
