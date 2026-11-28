// Operator-only scalar commands. The local key, if used, is Windows-DPAPI protected.
// No database credentials or datasets are fetched to the local machine.
import { spawnSync } from "node:child_process";
const base = process.env.BASE_URL || "https://q-plat.vercel.app";
let key = process.env.OWNER_KEY;
if (!key) {
  const childEnv = { ...process.env };
  for (const name of Object.keys(childEnv))
    if (name.toLowerCase() === "psmodulepath") delete childEnv[name];
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "$s=Get-Content -LiteralPath '.tools/owner-key.dpapi' | ConvertTo-SecureString; $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }",
    ],
    { encoding: "utf8", windowsHide: true, env: childEnv },
  );
  if (result.status !== 0) throw new Error("Owner credential unavailable.");
  key = result.stdout.trim();
}
const [op = "health", argument] = process.argv.slice(2);
if (
  !["health", "verify", "jobs", "import", "retry", "cancel", "probe", "migrate-atlas"].includes(
    op,
  )
)
  throw new Error("Unsupported scalar-only operator command.");
const write = ["verify", "import", "retry", "cancel", "probe", "migrate-atlas"].includes(op),
  body =
    op === "import"
      ? { dataset: argument }
      : op === "probe"
        ? { probe: argument }
        : argument
          ? { id: argument }
          : {};
async function call(operation, method, value) {
  const response = await fetch(base + "/api?op=" + operation, {
    method,
    cache: "no-store",
    headers: { "Content-Type": "application/json", "x-owner-key": key },
    body: method === "POST" ? JSON.stringify(value) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error("HTTP " + response.status + ": " + result.error);
  return result;
}

if (op === "migrate-atlas") {
  const metadata = await call(op, "POST", { phase: "metadata" });
  console.log(JSON.stringify({ phase: metadata.phase, copied: metadata.copied, bytes: metadata.bytes }));
  let cursor = null;
  let totalDocuments = 0;
  let totalBytes = 0;
  let done = false;
  while (!done) {
    const result = await call(op, "POST", { phase: "chunks", cursor });
    cursor = result.cursor;
    done = result.done;
    totalDocuments += result.copied;
    totalBytes += result.bytes;
    console.log(JSON.stringify({
      phase: result.phase,
      copied: totalDocuments,
      bytes: totalBytes,
      done,
    }));
  }
  process.exit(0);
}

const r = await fetch(base + "/api?op=" + op, {
  method: write ? "POST" : "GET",
  cache: "no-store",
  headers: { "Content-Type": "application/json", "x-owner-key": key },
  body: write ? JSON.stringify(body) : undefined,
});
const result = await r.json();
if (!r.ok) throw new Error("HTTP " + r.status + ": " + result.error);
if (op === "jobs")
  console.log(
    JSON.stringify(
      result.jobs.map((j) => ({
        id: j._id,
        type: j.type,
        dataset: j.dataset,
        status: j.status,
        progress: j.progress,
        summary: j.summary,
        error: j.error,
      })),
      null,
      2,
    ),
  );
else console.log(JSON.stringify(result, null, 2));
