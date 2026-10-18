import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { createStageTimer } from "./stage-timer.mjs";

const timing = createStageTimer("verify-assistant");
timing.start("prepare verification");
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
  timing.start("validate archive listing");
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
  timing.start("extract archive");
  execFileSync("tar", ["-xzf", archive, "-C", work]);
  const payload = join(work, directory);
  const home = join(work, "home");
  const user = join(work, "user");
  const preload = join(work, "isolate-registration.mjs");
  await writeFile(
    preload,
    `import os from 'node:os'; import cp from 'node:child_process'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; os.homedir=()=>process.env.TEST_USER_HOME; cp.execFileSync=(file,args)=>{if(file!=='reg')throw Error('Unexpected installer process');fs.appendFileSync(process.env.TEST_REGISTRY_LOG,JSON.stringify([file,args])+'\\n');}; syncBuiltinESMExports();`,
  );
  const node = process.platform === "win32" ? "node.exe" : "node";
  timing.start("install bundled assistant");
  execFileSync(join(payload, "runtime", node), [join(payload, "install.mjs")], {
    cwd: work,
    env: {
      ...process.env,
      LINGO_SOFA_HOME: home,
      TEST_USER_HOME: user,
      TEST_REGISTRY_LOG: join(work, "registry.jsonl"),
      NODE_OPTIONS: `--import="${pathToFileURL(preload).href}"`,
    },
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
  const { BROWSER_EXTENSION_ID } = await import(
    pathToFileURL(join(dirname(installation.entrypoint), "config.js")).href
  );
  const initialConfig = JSON.parse(
    await readFile(join(home, "config.json"), "utf8"),
  );
  if (
    !BROWSER_EXTENSION_ID ||
    !initialConfig.allowedExtensions.includes(BROWSER_EXTENSION_ID)
  )
    throw new Error(
      "Official browser extension was not authorized during installation",
    );
  const registration =
    process.platform === "win32"
      ? join(home, "native/com.lingosofa.bridge.json")
      : process.platform === "darwin"
        ? join(
            user,
            "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.lingosofa.bridge.json",
          )
        : join(
            user,
            ".config/google-chrome/NativeMessagingHosts/com.lingosofa.bridge.json",
          );
  if (
    !JSON.parse(await readFile(registration, "utf8")).allowed_origins.includes(
      `chrome-extension://${BROWSER_EXTENSION_ID}/`,
    )
  )
    throw new Error("Native host does not authorize the official extension");
  // Delete the extracted installer: launch must use only the installed snapshot.
  timing.start("remove extracted installer");
  await rm(payload, { recursive: true, force: true });
  timing.start("verify installed authorization entry");
  const authorization = spawn(
    installation.executable,
    [
      join(dirname(installation.entrypoint), "authorize-browser.mjs"),
      "invalid-id",
    ],
    {
      env: { ...process.env, NODE_OPTIONS: "", LINGO_SOFA_HOME: home },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let authorizationError = "";
  authorization.stderr.on("data", (data) => {
    authorizationError += data.toString();
  });
  const [authorizationCode] = await once(authorization, "exit");
  if (
    authorizationCode !== 1 ||
    !authorizationError.includes("Invalid extension ID")
  )
    throw new Error("Installed browser authorization entry is not usable");
  timing.start("start installed service");
  const socket = createServer();
  await new Promise((done) => socket.listen(0, "127.0.0.1", done));
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  const configPath = join(home, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.port = port;
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
  timing.start("verify shared service protocol");
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
  const browser = `chrome-extension://${BROWSER_EXTENSION_ID}`;
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
  timing.start("stop installed service");
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await exited;
  }
  timing.start("remove verification files");
  try {
    await rm(work, { recursive: true, force: true });
  } finally {
    timing.finish();
  }
}
