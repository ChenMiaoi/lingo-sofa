import {
  access,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { bridgeConfigSchema } from "./runtime/config.js";

const source = import.meta.dirname;
const home = resolve(
  process.env.LINGO_SOFA_HOME ?? join(homedir(), ".config/lingo-sofa"),
);
const metadata = JSON.parse(
  await readFile(join(source, "bundle.json"), "utf8"),
);
if (
  metadata.platform !== process.platform ||
  metadata.arch !== process.arch ||
  process.versions.node.split(".")[0] !== "24"
)
  throw new Error(
    "This assistant package does not match this computer / Node 24 runtime",
  );
const extensions = process.argv.slice(2);
if (extensions.includes("--interactive")) {
  extensions.splice(extensions.indexOf("--interactive"), 1);
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (
      await prompt.question(
        "浏览器扩展 ID（从 LingoSofa 设置页复制；仅 Discord 使用可直接回车）：",
      )
    ).trim();
    if (answer) extensions.push(answer);
  } finally {
    prompt.close();
  }
}
if (extensions.some((id) => !/^[a-p]{32}$/.test(id)))
  throw new Error("Invalid extension ID");
// Reject incomplete or altered payloads before changing the user's installation.
for (const [path, hash] of Object.entries(metadata.files)) {
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    !/^[a-f0-9]{64}$/.test(hash)
  )
    throw new Error("Invalid package manifest");
  if (
    createHash("sha256")
      .update(await readFile(join(source, path)))
      .digest("hex") !== hash
  )
    throw new Error(`Package integrity check failed: ${path}`);
}
await mkdir(home, { recursive: true, mode: 0o700 });
const lock = join(home, ".installer-lock");
try {
  await mkdir(lock);
} catch {
  throw new Error(
    "Another assistant installation is in progress. If it crashed, remove .installer-lock in the assistant directory and retry.",
  );
}
let temporary;
try {
  let config;
  try {
    config = bridgeConfigSchema.parse(
      JSON.parse(await readFile(join(home, "config.json"), "utf8")),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    config = bridgeConfigSchema.parse({
      settings: { mode: "bridge", persistUsage: true },
    });
  }
  config.allowedExtensions = [
    ...new Set([...config.allowedExtensions, ...extensions]),
  ];
  config = bridgeConfigSchema.parse(config);
  const binaryName = `lingo-sofa-native-host${process.platform === "win32" ? ".exe" : ""}`;
  const binary = join(home, binaryName);
  const name = "com.lingosofa.bridge";
  const browserDirectories =
    process.platform === "darwin"
      ? ["Google/Chrome", "Google/ChromeForTesting", "Microsoft Edge"].map(
          (browser) =>
            join(
              homedir(),
              "Library/Application Support",
              browser,
              "NativeMessagingHosts",
            ),
        )
      : process.platform === "win32"
        ? [join(home, "native")]
        : [
            "google-chrome",
            "google-chrome-for-testing",
            "chromium",
            "microsoft-edge",
          ].map((browser) =>
            join(homedir(), ".config", browser, "NativeMessagingHosts"),
          );
  if (config.allowedExtensions.length) {
    for (const directory of browserDirectories) {
      try {
        const existing = JSON.parse(
          await readFile(join(directory, `${name}.json`), "utf8"),
        );
        if (existing.path !== binary || existing.name !== name)
          throw new Error(
            "A different Native Host registration already exists; it was not overwritten",
          );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  try {
    const active = JSON.parse(
      await readFile(join(home, "runtime-connection.json"), "utf8"),
    );
    if (Number.isInteger(active.pid)) {
      try {
        process.kill(active.pid, 0);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
        active.pid = null;
      }
      if (active.pid)
        throw new Error(
          "请关闭浏览器与 Discord，等待本地助手退出后重新安装；配置和用量会保留。",
        );
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const runtimeName = `assistant-${createHash("sha256").update(JSON.stringify(metadata)).digest("hex").slice(0, 20)}`;
  const destination = join(home, runtimeName);
  try {
    await access(destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    temporary = join(home, `.install-${process.pid}`);
    await mkdir(temporary, { mode: 0o700 });
    await cp(join(source, "runtime"), temporary, {
      recursive: true,
      dereference: true,
    });
    await rename(temporary, destination);
    temporary = undefined;
  }
  const executable = join(
    destination,
    process.platform === "win32" ? "node.exe" : "node",
  );
  if (!(await stat(executable)).isFile())
    throw new Error("Bundled runtime is missing");
  await cp(join(source, binaryName), `${binary}.tmp`);
  await rename(`${binary}.tmp`, binary);
  async function save(path, value) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(`${path}.tmp`, path);
  }
  await save(join(home, "config.json"), config);
  await save(join(home, "runtime-install.json"), {
    executable,
    entrypoint: join(destination, "index.js"),
    version: metadata.version,
  });
  if (config.allowedExtensions.length) {
    for (const directory of browserDirectories) {
      const path = join(directory, `${name}.json`);
      await save(path, {
        name,
        description: "LingoSofa Native Messaging Bridge",
        path: binary,
        type: "stdio",
        allowed_origins: config.allowedExtensions.map(
          (id) => `chrome-extension://${id}/`,
        ),
      });
      if (process.platform === "win32")
        for (const browser of ["Google\\Chrome", "Microsoft\\Edge"])
          execFileSync("reg", [
            "ADD",
            `HKCU\\Software\\${browser}\\NativeMessagingHosts\\${name}`,
            "/ve",
            "/t",
            "REG_SZ",
            "/d",
            path,
            "/f",
          ]);
    }
  }
  console.log(
    "LingoSofa 本地助手安装完成。重新打开浏览器或 Discord 即可自动连接；两端共用此安装与模型配置。",
  );
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
  await rm(lock, { recursive: true, force: true });
}
