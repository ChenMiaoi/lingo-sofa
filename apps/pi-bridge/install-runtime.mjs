import {
  mkdir,
  readFile,
  writeFile,
  rename,
  access,
  cp,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join, dirname, relative } from "node:path";
import { createHash } from "node:crypto";

const directory = resolve(
  process.env.LINGO_SOFA_HOME ?? join(homedir(), ".config/lingo-sofa"),
);
const builtEntry = resolve("dist/index.js");
await access(builtEntry);
await mkdir(directory, { recursive: true, mode: 0o700 });
try {
  const active = JSON.parse(
    await readFile(join(directory, "runtime-connection.json"), "utf8"),
  );
  if (Number.isInteger(active.pid)) {
    try {
      process.kill(active.pid, 0);
      throw new Error(
        "Close connected clients and wait for the assistant to exit before upgrading it",
      );
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const { bridgeConfigSchema } = await import("./dist/config.js");
let config;
try {
  config = bridgeConfigSchema.parse(
    JSON.parse(await readFile(join(directory, "config.json"), "utf8")),
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  config = bridgeConfigSchema.parse({
    settings: { mode: "bridge", persistUsage: true },
  });
}
const extension = process.argv[2];
if (extension) {
  if (!/^[a-p]{32}$/.test(extension)) throw new Error("Invalid extension ID");
  config.allowedExtensions = [
    ...new Set([...config.allowedExtensions, extension]),
  ];
  config = bridgeConfigSchema.parse(config);
}
// Install a private runtime snapshot: browser-launched helpers must not depend on an external source volume.
const root = resolve(import.meta.dirname, "../..");
const lockText = await readFile(join(root, "package-lock.json"), "utf8");
const lock = JSON.parse(lockText);
const digest = createHash("sha256")
  .update(await readFile(builtEntry))
  .update(lockText)
  .digest("hex")
  .slice(0, 16);
const runtimeDirectory = join(directory, `runtime-${digest}`);
let installed = true;
try {
  await access(join(runtimeDirectory, "index.js"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  installed = false;
}
if (!installed) {
  const temporary = await mkdtemp(join(directory, ".runtime-install-"));
  try {
    const pending = [
      "node_modules/@earendil-works/pi-coding-agent",
      "node_modules/@earendil-works/pi-ai",
      "node_modules/zod",
    ];
    const copied = new Set();
    while (pending.length) {
      const path = pending.pop();
      if (copied.has(path)) continue;
      copied.add(path);
      await cp(join(root, path), join(temporary, path), {
        recursive: true,
        dereference: true,
      });
      const pkg = JSON.parse(
        await readFile(join(root, path, "package.json"), "utf8"),
      );
      for (const name of Object.keys({
        ...pkg.dependencies,
        ...pkg.optionalDependencies,
      })) {
        let current = join(root, path);
        let dependency;
        while (
          current === root ||
          current.startsWith(root + "/") ||
          current.startsWith(root + "\\")
        ) {
          const candidate = relative(
            root,
            join(current, "node_modules", name),
          ).replaceAll("\\", "/");
          if (lock.packages[candidate]) {
            dependency = candidate;
            break;
          }
          if (current === root) break;
          current = dirname(current);
        }
        if (!dependency) {
          if (name in (pkg.optionalDependencies ?? {})) continue;
          throw new Error(`Missing runtime dependency: ${name}`);
        }
        try {
          await access(join(root, dependency));
        } catch (error) {
          if (
            name in (pkg.optionalDependencies ?? {}) &&
            error.code === "ENOENT"
          )
            continue;
          throw error;
        }
        pending.push(dependency);
      }
    }
    await writeFile(
      join(temporary, "package.json"),
      JSON.stringify({ type: "module", private: true }),
    );
    await cp(builtEntry, join(temporary, "index.js"));
    await rename(temporary, runtimeDirectory);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
for (const [name, value] of [
  ["config.json", config],
  [
    "runtime-install.json",
    {
      executable: process.execPath,
      entrypoint: join(runtimeDirectory, "index.js"),
    },
  ],
]) {
  await writeFile(
    join(directory, `${name}.tmp`),
    JSON.stringify(value, null, 2) + "\n",
    { mode: 0o600 },
  );
  await rename(join(directory, `${name}.tmp`), join(directory, name));
}
console.log(
  "Installed LingoSofa local runtime and dependencies. Clients start it automatically; no manual pairing is required.",
);
