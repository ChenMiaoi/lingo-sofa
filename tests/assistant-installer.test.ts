import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  cp,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { BROWSER_EXTENSION_ID } from "@lingo-sofa/protocol";
import {
  AssistantInstaller,
  downloadAssistant,
  validateArchiveListing,
  validateAsset,
  type AssistantRelease,
} from "@lingo-sofa/local-runtime/installer";
const execute = promisify(execFile);
const version = "0.1.0";
const key = `${process.platform}-${process.arch}`;
const directory = `lingo-sofa-assistant-${version}-${key}`;
function release(data = Buffer.from("fixture")): AssistantRelease {
  return {
    version,
    assets: {
      [key]: {
        directory,
        url: `https://github.com/ChenMiaoi/lingo-sofa/releases/download/v${version}/${directory}.tar.gz`,
        sha256: createHash("sha256").update(data).digest("hex"),
      },
    },
  };
}
it("requires a matching version/platform and a pinned official release asset", () => {
  expect(
    validateAsset(release(), process.platform, process.arch).directory,
  ).toBe(directory);
  expect(() => validateAsset(release(), "unknown", "cpu")).toThrow("安装包");
  for (const field of ["url", "sha256", "directory"] as const) {
    const value = release();
    value.assets[key]![field] = "untrusted";
    expect(() => validateAsset(value, process.platform, process.arch)).toThrow(
      "安装包",
    );
  }
});
it.each([
  "../outside",
  `${directory}/../outside`,
  `${directory}/a/../../outside`,
  `/tmp/${directory}/file`,
  `${directory}\\evil`,
  `${directory}/./file`,
  `${directory}//file`,
  `${directory}-other/file`,
])("rejects archive path %s", (path) => {
  expect(() => validateArchiveListing(path, directory)).toThrow("archive");
});
it("validates normal archive paths and rejects downloads with altered bytes or HTTP failures", async () => {
  validateArchiveListing(
    `${directory}/\n${directory}/runtime/node\n`,
    directory,
  );
  const asset = validateAsset(release(), process.platform, process.arch);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("fixture"))
    .mockResolvedValueOnce(new Response("tampered"))
    .mockResolvedValueOnce(new Response("missing", { status: 404 }));
  expect((await downloadAssistant(asset, fetcher)).toString()).toBe("fixture");
  await expect(downloadAssistant(asset, fetcher)).rejects.toThrow("校验");
  await expect(downloadAssistant(asset, fetcher)).rejects.toThrow("下载失败");
});
it("reuses an existing installation without downloading or overwriting it", async () => {
  const home = await mkdtemp(join(tmpdir(), "lingo-existing-"));
  try {
    await writeFile(join(home, "runtime-install.json"), "existing descriptor");
    await new AssistantInstaller(home, {
      version,
      assets: {},
    }).ensureInstalled();
    expect(await readFile(join(home, "runtime-install.json"), "utf8")).toBe(
      "existing descriptor",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
it("installs with a private bundled runtime, preserves user data, merges browser authorization and refuses an active upgrade", async () => {
  const work = await mkdtemp(join(tmpdir(), "lingo-installer-test-"));
  const payload = join(work, directory);
  const home = join(work, "home");
  const userHome = join(work, "user");
  const runtime = join(payload, "runtime");
  await mkdir(runtime, { recursive: true });
  await mkdir(home);
  await mkdir(userHome);
  try {
    await build({
      entryPoints: [resolve("apps/pi-bridge/src/config.ts")],
      outfile: join(runtime, "config.js"),
      platform: "node",
      format: "esm",
      bundle: true,
    });
    await writeFile(join(runtime, "package.json"), '{"type":"module"}');
    const preload = join(work, "isolate.mjs");
    const registryLog = join(work, "registry.jsonl");
    await writeFile(
      preload,
      `import os from 'node:os'; import cp from 'node:child_process'; import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; os.homedir = () => process.env.TEST_USER_HOME; cp.execFileSync = (file, args) => {if(file !== 'reg')throw Error('Unexpected process in installer fixture');fs.appendFileSync(process.env.TEST_REGISTRY_LOG, JSON.stringify([file,args])+'\\n');}; syncBuiltinESMExports();`,
    );
    // Automatic installation clears NODE_OPTIONS. Load isolation from the fixture itself.
    await writeFile(
      join(payload, "install.mjs"),
      `await import(${JSON.stringify(pathToFileURL(preload).href)});\n${await readFile(resolve("apps/pi-bridge/installer.mjs"), "utf8")}`,
    );
    for (const file of [
      "authorization-entry.mjs",
      "authorize-browser.mjs",
      "native-registration.mjs",
    ])
      await cp(resolve("apps/pi-bridge", file), join(payload, file));
    const nodeName = process.platform === "win32" ? "node.exe" : "node";
    await cp(process.execPath, join(runtime, nodeName));
    const nativeName = `lingo-sofa-native-host${process.platform === "win32" ? ".exe" : ""}`;
    await writeFile(join(payload, nativeName), "fixture native host");
    await writeFile(
      join(runtime, "index.js"),
      'console.log("fixture runtime")',
    );
    const hash = async (path: string) =>
      createHash("sha256")
        .update(await readFile(join(payload, path)))
        .digest("hex");
    const files = Object.fromEntries(
      await Promise.all(
        [
          "install.mjs",
          "authorization-entry.mjs",
          "authorize-browser.mjs",
          "native-registration.mjs",
          "runtime/config.js",
          "runtime/index.js",
          "runtime/package.json",
          `runtime/${nodeName}`,
          nativeName,
        ].map(async (path) => [path, await hash(path)]),
      ),
    );
    await writeFile(
      join(payload, "bundle.json"),
      JSON.stringify({
        version,
        platform: process.platform,
        arch: process.arch,
        files,
      }),
    );
    const archive = join(work, "assistant.tar.gz");
    await execute("tar", ["-czf", archive, "-C", work, directory]);
    const archiveBytes = await readFile(archive);
    const download = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(archiveBytes));
    vi.stubGlobal("fetch", download);
    vi.stubEnv("TEST_USER_HOME", join(work, "automatic-user"));
    vi.stubEnv("TEST_REGISTRY_LOG", registryLog);
    const automaticHome = join(work, "automatic");
    const progress: string[] = [];
    const automatic = new AssistantInstaller(
      automaticHome,
      release(archiveBytes),
      (value) => progress.push(value),
    );
    await Promise.all([
      automatic.ensureInstalled(),
      automatic.ensureInstalled(),
    ]);
    expect(download).toHaveBeenCalledTimes(1);
    expect(progress).toEqual([
      "正在下载本地助手…",
      "正在安装本地助手…",
      "本地助手已安装",
    ]);
    expect(
      JSON.parse(
        await readFile(join(automaticHome, "runtime-install.json"), "utf8"),
      ).executable,
    ).toContain(automaticHome);
    if (process.platform === "win32") {
      const calls = (await readFile(registryLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls).toEqual(
        ["Google\\Chrome", "Microsoft\\Edge"].map((browser) => [
          "reg",
          [
            "ADD",
            `HKCU\\Software\\${browser}\\NativeMessagingHosts\\com.lingosofa.bridge`,
            "/ve",
            "/t",
            "REG_SZ",
            "/d",
            join(automaticHome, "native/com.lingosofa.bridge.json"),
            "/f",
          ],
        ]),
      );
    }
    vi.unstubAllGlobals();
    const env = {
      ...process.env,
      HOME: userHome,
      USERPROFILE: userHome,
      LINGO_SOFA_HOME: home,
      TEST_USER_HOME: userHome,
    };
    const install = (...ids: string[]) =>
      execute(process.execPath, [join(payload, "install.mjs"), ...ids], {
        env,
      });
    // No browser ID is needed for the Discord-first flow.
    await install();
    expect(
      JSON.parse(await readFile(join(home, "config.json"), "utf8"))
        .allowedExtensions,
    ).toEqual([BROWSER_EXTENSION_ID]);
    const installed = JSON.parse(
      await readFile(join(home, "runtime-install.json"), "utf8"),
    );
    expect(installed.executable).toContain(home);
    expect(installed.executable).not.toBe(process.execPath);
    expect(
      (await execute(installed.executable, ["--version"])).stdout.trim(),
    ).toBe(process.version);
    await writeFile(join(home, "accounts.json"), '{"private":"preserved"}');
    await writeFile(join(home, "usage.json"), '[{"usage":null}]');
    await install("a".repeat(32));
    await install("b".repeat(32));
    const config = JSON.parse(
      await readFile(join(home, "config.json"), "utf8"),
    );
    expect(config.allowedExtensions).toEqual([
      BROWSER_EXTENSION_ID,
      "a".repeat(32),
      "b".repeat(32),
    ]);
    expect(config.settings.persistUsage).toBe(true);
    expect(await readFile(join(home, "accounts.json"), "utf8")).toBe(
      '{"private":"preserved"}',
    );
    expect(await readFile(join(home, "usage.json"), "utf8")).toBe(
      '[{"usage":null}]',
    );
    if (process.platform !== "win32")
      expect(
        (await stat(join(home, "runtime-install.json"))).mode & 0o777,
      ).toBe(0o600);
    const registration =
      process.platform === "win32"
        ? join(home, "native/com.lingosofa.bridge.json")
        : process.platform === "darwin"
          ? join(
              userHome,
              "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.lingosofa.bridge.json",
            )
          : join(
              userHome,
              ".config/google-chrome/NativeMessagingHosts/com.lingosofa.bridge.json",
            );
    const originalRegistration = await readFile(registration, "utf8");
    expect(JSON.parse(originalRegistration).allowed_origins).toEqual(
      config.allowedExtensions.map((id: string) => `chrome-extension://${id}/`),
    );
    await writeFile(
      registration,
      JSON.stringify({ name: "com.lingosofa.bridge", path: "/foreign/host" }),
    );
    await expect(install()).rejects.toThrow("different Native Host");
    expect(JSON.parse(await readFile(registration, "utf8")).path).toBe(
      "/foreign/host",
    );
    await writeFile(registration, originalRegistration);
    await writeFile(
      join(home, "runtime-connection.json"),
      JSON.stringify({ pid: process.pid }),
    );
    await expect(install()).rejects.toThrow("关闭浏览器");
    expect(
      JSON.parse(await readFile(join(home, "runtime-install.json"), "utf8"))
        .executable,
    ).toBe(installed.executable);
    await rm(join(home, "runtime-connection.json"));
    await writeFile(join(runtime, "index.js"), "altered");
    await expect(install()).rejects.toThrow("integrity");
    await expect(install("invalid-id")).rejects.toThrow("Invalid extension ID");
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(work, { recursive: true, force: true });
  }
}, 30_000);
