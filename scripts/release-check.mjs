// Scalar-only release evidence. Never requests a market-data window.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const base = "https://q-plat.vercel.app",
  repo = "dakiemdarktharr/q_plat";
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (process.argv.includes("--wait")) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const current = await fetch(base + "/api?op=health", { cache: "no-store" })
      .then((r) => r.json())
      .catch(() => ({}));
    if (current.commit === commit) break;
    if (attempt === 59)
      throw new Error(
        "Production did not deploy the expected commit within five minutes.",
      );
    await new Promise((r) => setTimeout(r, 5000));
  }
}
const digest = (s) => createHash("sha256").update(s).digest("hex");
const [home, download, healthResponse, repository, catalog] = await Promise.all(
  [
    fetch(base),
    fetch(base + "/download"),
    fetch(base + "/api?op=health"),
    fetch("https://api.github.com/repos/" + repo),
    fetch(base + "/api?op=catalog"),
  ],
);
for (const r of [home, download, healthResponse, repository, catalog])
  assert.equal(r.status, 200);
const health = await healthResponse.json(),
  meta = await repository.json(),
  sources = await catalog.json();
assert.equal(meta.name, "q_plat");
assert.equal(meta.private, false);
assert.equal(meta.owner.login, "dakiemdarktharr");
assert.equal(health.commit, commit);
assert.equal(health.database, "connected");
assert.match(
  download.headers.get("content-disposition"),
  /attachment.*index.html/,
);
assert.match(catalog.headers.get("cache-control"), /no-store/);
const source = await readFile("index.html", "utf8"),
  remote = await fetch(
    meta.contents_url.replace("{+path}", "index.html") + "?ref=" + commit,
    { headers: { Accept: "application/vnd.github.raw+json" } },
  );
assert.equal(remote.status, 200);
const hashes = [
  source,
  await home.text(),
  await download.text(),
  await remote.text(),
].map(digest);
assert.ok(hashes.every((h) => h === hashes[0]));
assert.equal(health.artifactHash, hashes[0]);
const secret =
  /(?:mongodb(?:\+srv)?:\/\/[^\s'"<>]+:[^\s'"<>]+@|gh[pousr]_[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .trim()
  .split(/\r?\n/);
assert.ok(
  !files.some((f) => /\.(csv|parquet|jsonl|sqlite|har|webm|png|zip)$/.test(f)),
);
let scanned = 0;
for (const revision of execFileSync("git", ["rev-list", "--all"], {
  encoding: "utf8",
})
  .trim()
  .split(/\r?\n/)) {
  const tree = execFileSync("git", ["ls-tree", "-r", "--name-only", revision], {
    encoding: "utf8",
  })
    .trim()
    .split(/\r?\n/);
  for (const file of tree) {
    const text = execFileSync("git", ["show", revision + ":" + file], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(
      secret.test(text),
      false,
      "Credential pattern detected; release blocked.",
    );
    scanned++;
  }
}
console.log(
  JSON.stringify(
    {
      status: "pass",
      time: new Date().toISOString(),
      commit,
      deployment: health.deployment,
      engine: health.engine,
      htmlSHA256: hashes[0],
      publicRepository: meta.full_name,
      downloadAttachment: true,
      noStore: true,
      historyBlobsScanned: scanned,
      snapshots: sources.versions.map((v) => ({
        id: v._id,
        count: v.count,
        checksum: v.checksum,
      })),
    },
    null,
    2,
  ),
);
