import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { hash } from "./db.mjs";
export const httpError = (message, status = 400) =>
  Object.assign(new Error(message), { status });
export function safeEqual(a, b) {
  const x = Buffer.from(a || ""),
    y = Buffer.from(b || "");
  return x.length === y.length && timingSafeEqual(x, y);
}
export function owner(request) {
  return (
    !!process.env.OWNER_KEY &&
    safeEqual(request.headers.get("x-owner-key"), process.env.OWNER_KEY)
  );
}
export async function session(request, database, required = true) {
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const token = /^Bearer (qtp_[A-Za-z0-9_-]{43})$/.exec(authorization)?.[1];
    const record = token
      ? await database.collection("api_tokens").findOne({
          _id: hash(token),
          expiresAt: { $gt: new Date() },
          revokedAt: null,
        })
      : null;
    if (!record)
      throw httpError("API token is invalid, expired or revoked.", 401);
    return {
      workspace: record.workspace,
      name: record.workspaceName,
      auth: "token",
      scope: record.scope,
    };
  }
  const raw = (request.headers.get("cookie") || "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("q_session="))
    ?.slice(10);
  const s = raw
    ? await database
        .collection("sessions")
        .findOne({ _id: hash(raw), expiresAt: { $gt: new Date() } })
    : null;
  if (!s && required) throw httpError("Open a private workspace first.", 401);
  return s;
}
export function authorizeOperation(s, op, method) {
  if (s.auth !== "token") return;
  const reads = [
    "session",
    "edges",
    "runs",
    "report",
    "runWindow",
    "cross",
    "detail",
    "compare",
    "jobs",
  ];
  const writes = ["validate", "edges", "run", "retry", "cancel"];
  if (method === "GET" && reads.includes(op)) return;
  if (s.scope === "research" && method === "POST" && writes.includes(op))
    return;
  throw httpError("This token does not permit this operation.", 403);
}
export async function issueToken(database, s, body) {
  if (s.auth === "token" || s.guest)
    throw httpError("Sign in to a named workspace to manage AI access.", 403);
  if (!["read", "research"].includes(body.scope))
    throw httpError("Choose read or research scope.");
  const label = String(body.label || "AI client")
    .trim()
    .slice(0, 80);
  const active = await database
    .collection("api_tokens")
    .countDocuments({
      workspace: s.workspace,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    });
  if (active >= 10)
    throw httpError(
      "Revoke an existing token before creating another (limit 10).",
      429,
    );
  const token = "qtp_" + randomBytes(32).toString("base64url");
  const record = {
    _id: hash(token),
    id: randomBytes(12).toString("hex"),
    workspace: s.workspace,
    workspaceName: s.name,
    label,
    scope: body.scope,
    prefix: token.slice(0, 10),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 86400000),
    revokedAt: null,
  };
  await database.collection("api_tokens").insertOne(record);
  return {
    token,
    id: record.id,
    expiresAt: record.expiresAt,
    scope: record.scope,
  };
}
export async function guestSession(database) {
  const token = randomBytes(32).toString("hex"),
    workspace = randomBytes(16).toString("hex"),
    name = "guest_" + workspace.slice(0, 12);
  await database
    .collection("workspaces")
    .insertOne({
      _id: workspace,
      name,
      guest: true,
      createdAt: new Date().toISOString(),
    });
  await database
    .collection("sessions")
    .insertOne({
      _id: hash(token),
      workspace,
      name,
      guest: true,
      expiresAt: new Date(Date.now() + 86400000),
    });
  return {
    workspace,
    name,
    guest: true,
    cookie: `q_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`,
  };
}
export async function login(database, body, create = false, existing = null) {
  const name = String(body.name || "")
      .trim()
      .toLowerCase(),
    password = String(body.password || "");
  if (
    !/^[a-z0-9_-]{3,48}$/.test(name) ||
    password.length < 12 ||
    password.length > 256
  )
    throw httpError(
      "Workspace: 3–48 letters/numbers/_/-. Passphrase: 12–256 characters.",
    );
  let w = await database.collection("workspaces").findOne({ name });
  if (create) {
    if (w) throw httpError("Workspace name is already in use.", 409);
    const salt = randomBytes(16).toString("hex");
    w = {
      _id: existing?.guest
        ? existing.workspace
        : randomBytes(16).toString("hex"),
      name,
      salt,
      passwordHash: scryptSync(password, salt, 32).toString("hex"),
      createdAt: new Date().toISOString(),
    };
    if (existing?.guest) {
      await database
        .collection("workspaces")
        .replaceOne({ _id: existing.workspace, guest: true }, w);
      await database
        .collection("sessions")
        .deleteMany({ workspace: existing.workspace });
    } else await database.collection("workspaces").insertOne(w);
  } else if (
    !w ||
    w.guest ||
    !safeEqual(w.passwordHash, scryptSync(password, w.salt, 32).toString("hex"))
  )
    throw httpError("Invalid workspace or passphrase.", 401);
  const token = randomBytes(32).toString("hex"),
    expiresAt = new Date(Date.now() + 30 * 86400000);
  await database
    .collection("sessions")
    .insertOne({ _id: hash(token), workspace: w._id, name: w.name, expiresAt });
  return {
    workspace: w._id,
    name: w.name,
    cookie: `q_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`,
  };
}
export async function rateLimit(database, key, limit = 30) {
  const minute = Math.floor(Date.now() / 60000),
    id = hash(key) + ":" + minute;
  const r = await database.collection("rate_limits").findOneAndUpdate(
    { _id: id },
    {
      $inc: { count: 1 },
      $setOnInsert: { expiresAt: new Date((minute + 2) * 60000) },
    },
    { upsert: true, returnDocument: "after" },
  );
  if (r.count > limit)
    throw httpError("Rate limit reached. Try again in one minute.", 429);
}
export function sameOrigin(request) {
  const origin = request.headers.get("origin");
  const allowed = process.env.APP_ORIGIN || new URL(request.url).origin;
  if (origin && origin !== allowed)
    throw httpError("Cross-origin writes are not allowed.", 403);
}
