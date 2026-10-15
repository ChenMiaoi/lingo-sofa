import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { once } from "node:events";

const root = resolve(import.meta.dirname, "..");
const version = JSON.parse(
  await readFile(join(root, "apps/pi-bridge/package.json"), "utf8"),
).version;
const archive = resolve(
  process.argv[2] ??
    join(
      root,
      `apps/pi-bridge/dist/installers/lingo-sofa-assistant-${version}-${process.platform}-${process.arch}.tar.gz`,
    ),
);
if (!archive.endsWith(".tar.gz"))
  throw new Error("Pass the assistant archive to verify");
const work = await mkdtemp(join(tmpdir(), "lingo-assistant-smoke-"));
let child;
let exited;
try {
  // This command verifies locally built artifacts, never untrusted remote archives.
  const listing = execFileSync("tar", ["-tzf", archive], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .trim()
    .split(/\r?\n/);
  const directory = listing[0].split("/")[0];
  if (
    !/^lingo-sofa-assistant-[\w.-]+$/.test(directory) ||
    listing.some(
      (path) =>
        !path.startsWith(`${directory}/`) ||
        path.includes("..") ||
        path.includes("\\"),
    )
  )
    throw new Error("Invalid assistant paths");
  execFileSync("tar", ["-xzf", archive, "-C", work]);
  const payload = join(work, directory);
  const home = join(work, "home");
  const node = process.platform === "win32" ? "node.exe" : "node";
  execFileSync(join(payload, "runtime", node), [join(payload, "install.mjs")], {
    cwd: work,
    env: { ...process.env, LINGO_SOFA_HOME: home },
    stdio: "pipe",
  });
  const installation = JSON.parse(
    await readFile(join(home, "runtime-install.json"), "utf8"),
  );
  if (
    !installation.executable.startsWith(home) ||
    !installation.entrypoint.startsWith(home)
  )
    throw new Error("Installation depends on external source or runtime");
  // Delete the extracted installer: launch must use only the installed snapshot.
  await rm(payload, { recursive: true, force: true });
  const socket = createServer();
  await new Promise((done) => socket.listen(0, "127.0.0.1", done));
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  const configPath = join(home, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.port = port;
  config.allowedExtensions = ["a".repeat(32)];
  await writeFile(configPath, JSON.stringify(config));
  let stderr = "";
  child = spawn(
    installation.executable,
    [installation.entrypoint, "--service"],
    {
      cwd: home,
      env: { ...process.env, NODE_OPTIONS: "", LINGO_SOFA_HOME: home },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });
  exited = once(child, "exit");
  let connection;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null)
      throw new Error(`Installed assistant exited: ${stderr}`);
    try {
      connection = JSON.parse(
        await readFile(join(home, "runtime-connection.json"), "utf8"),
      );
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(100);
  }
  if (!connection)
    throw new Error(`Installed assistant did not start: ${stderr}`);
  async function post(origin, route, body) {
    const response = await globalThis.fetch(
      `http://127.0.0.1:${port}${route}`,
      {
        method: "POST",
        headers: {
          Origin: origin,
          Authorization: `Bearer ${connection.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: globalThis.AbortSignal.timeout(5000),
      },
    );
    if (!response.ok)
      throw new Error(
        `Installed assistant rejected ${route}: ${response.status}`,
      );
    return response.json();
  }
  const discord = "https://discord.com";
  const browser = `chrome-extension://${"a".repeat(32)}`;
  for (const [origin, id] of [
    [discord, randomUUID()],
    [browser, randomUUID()],
  ]) {
    const status = await post(origin, "/v1/runtime/status", {});
    if (status.instanceId !== connection.instanceId)
      throw new Error("Clients did not share an assistant instance");
    await post(origin, "/v1/runtime/lease", { id, action: "renew" });
    await post(origin, "/v1/provider", {});
  }
  const status = await post(discord, "/v1/runtime/status", {});
  if (status.clients !== 2)
    throw new Error("Both client leases must remain active");
  console.log(
    "Verified installed bundled Node and Bridge without source or extracted installer; browser and Discord origins share one authenticated service. No model requests sent.",
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await exited;
  }
  await rm(work, { recursive: true, force: true });
}
