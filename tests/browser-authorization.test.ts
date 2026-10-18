import { expect, it } from "vitest";
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { assistantAuthorizationCommand } from "../apps/browser-extension/src/assistant-command";
import { BROWSER_EXTENSION_ID } from "@lingo-sofa/protocol";

const execute = promisify(execFile);
const id = "a".repeat(32);

it("generates platform commands with the extension ID and rejects shell input", () => {
  for (const platform of ["win", "mac", "linux"] as const) {
    const command = assistantAuthorizationCommand(platform, id);
    expect(command).toContain(id);
    expect(command).toContain("LINGO_SOFA_HOME");
    expect(command).not.toMatch(/https:|npm|curl/);
    expect(() => assistantAuthorizationCommand(platform, "'; exit 1")).toThrow(
      "Invalid extension ID",
    );
  }
});

it("authorizes an installed runtime without its installer, preserves data while the runtime is active and rejects conflicting installs", async () => {
  const work = await mkdtemp(join(tmpdir(), "lingo authorization ' "));
  const home = join(work, "assistant");
  const runtime = join(home, "runtime");
  const user = join(work, "user");
  await mkdir(runtime, { recursive: true });
  await mkdir(user);
  try {
    await build({
      entryPoints: [resolve("apps/pi-bridge/src/config.ts")],
      outfile: join(runtime, "config.js"),
      platform: "node",
      format: "esm",
      bundle: true,
    });
    await writeFile(join(runtime, "package.json"), '{"type":"module"}');
    for (const file of ["authorize-browser.mjs", "native-registration.mjs"])
      await cp(resolve("apps/pi-bridge", file), join(runtime, file));
    const binary = join(
      home,
      `lingo-sofa-native-host${process.platform === "win32" ? ".exe" : ""}`,
    );
    await writeFile(binary, "existing native host");
    const descriptor = JSON.stringify({
      executable: process.execPath,
      entrypoint: join(runtime, "index.js"),
    });
    await writeFile(join(home, "runtime-install.json"), descriptor);
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        allowedExtensions: ["b".repeat(32)],
        settings: { mode: "bridge", persistUsage: true },
      }),
    );
    await writeFile(join(home, "accounts.json"), "private accounts");
    await writeFile(join(home, "usage.json"), "existing usage");
    // Isolate all user registration paths and record registry writes instead of changing this computer.
    const preload = join(work, "isolate.mjs");
    await writeFile(
      preload,
      `import os from 'node:os'; import cp from 'node:child_process'; import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; os.homedir = () => process.env.TEST_USER_HOME; cp.execFileSync = (file, args) => fs.appendFileSync(process.env.TEST_REGISTRY_LOG, JSON.stringify([file,args])+'\\n'); syncBuiltinESMExports();`,
    );
    const env = {
      ...process.env,
      LINGO_SOFA_HOME: home,
      TEST_USER_HOME: user,
      TEST_REGISTRY_LOG: join(work, "registry.jsonl"),
    };
    const authorize = (...ids: string[]) =>
      execute(
        process.execPath,
        [
          "--import",
          pathToFileURL(preload).href,
          join(runtime, "authorize-browser.mjs"),
          ...ids,
        ],
        { env },
      );
    await authorize(id);
    await authorize(id);
    const config = JSON.parse(
      await readFile(join(home, "config.json"), "utf8"),
    );
    expect(config.allowedExtensions).toEqual(["b".repeat(32), id]);
    expect(config.settings.persistUsage).toBe(true);
    expect(await readFile(join(home, "accounts.json"), "utf8")).toBe(
      "private accounts",
    );
    expect(await readFile(join(home, "usage.json"), "utf8")).toBe(
      "existing usage",
    );
    expect(await readFile(join(home, "runtime-install.json"), "utf8")).toBe(
      descriptor,
    );
    expect(await readFile(binary, "utf8")).toBe("existing native host");
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
    expect(
      JSON.parse(await readFile(registration, "utf8")).allowed_origins,
    ).toContain(`chrome-extension://${id}/`);
    if (process.platform === "win32") {
      const calls = (await readFile(join(work, "registry.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls).toHaveLength(4);
      expect(calls[0][1][1]).toContain("HKCU\\Software\\Google\\Chrome");
      expect(calls[1][1][1]).toContain("HKCU\\Software\\Microsoft\\Edge");
      // Execute the actual copied PowerShell command using the installed descriptor.
      await execute(
        "powershell.exe",
        ["-NoProfile", "-Command", assistantAuthorizationCommand("win", id)],
        {
          env: {
            ...env,
            NODE_OPTIONS: `--import="${pathToFileURL(preload).href}"`,
          },
        },
      );
    }
    if (process.platform !== "win32") {
      await cp(process.execPath, join(runtime, "node"));
      const installerUrl = pathToFileURL(
        resolve("apps/pi-bridge/authorization-entry.mjs"),
      ).href;
      await execute(process.execPath, [
        "--input-type=module",
        "--eval",
        `const { installBrowserAuthorization } = await import(${JSON.stringify(installerUrl)}); await installBrowserAuthorization(${JSON.stringify(home)}, ${JSON.stringify(runtime)});`,
      ]);
      await execute("sh", [join(home, "Authorize.command"), id], {
        env: {
          ...env,
          NODE_OPTIONS: `--import="${pathToFileURL(preload).href}"`,
        },
      });
    }
    await writeFile(
      join(home, "runtime-connection.json"),
      JSON.stringify({ pid: process.pid }),
    );
    await authorize("c".repeat(32));
    expect(
      JSON.parse(await readFile(join(home, "config.json"), "utf8"))
        .allowedExtensions,
    ).toEqual(["b".repeat(32), id, "c".repeat(32)]);
    expect(
      JSON.parse(await readFile(join(home, "runtime-connection.json"), "utf8"))
        .pid,
    ).toBe(process.pid);
    await authorize();
    await authorize();
    expect(
      JSON.parse(await readFile(join(home, "config.json"), "utf8"))
        .allowedExtensions,
    ).toEqual(["b".repeat(32), id, "c".repeat(32), BROWSER_EXTENSION_ID]);
    expect(
      JSON.parse(await readFile(registration, "utf8")).allowed_origins,
    ).toContain(`chrome-extension://${BROWSER_EXTENSION_ID}/`);
    const authorized = await readFile(join(home, "config.json"), "utf8");
    await rm(join(home, "runtime-connection.json"));
    await writeFile(
      registration,
      JSON.stringify({ name: "com.lingosofa.bridge", path: "/other/host" }),
    );
    await expect(authorize("d".repeat(32))).rejects.toThrow(
      "different Native Host",
    );
    expect(await readFile(join(home, "config.json"), "utf8")).toBe(authorized);
    await expect(authorize("invalid-id")).rejects.toThrow(
      "Invalid extension ID",
    );
    await rm(join(home, "runtime-install.json"));
    await expect(authorize(id)).rejects.toThrow("ENOENT");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}, 30_000);
