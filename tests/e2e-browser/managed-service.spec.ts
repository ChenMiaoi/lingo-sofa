import { test, expect, chromium } from "@playwright/test";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  copyFile,
  cp,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RuntimeClient, runtimePost } from "@lingo-sofa/local-runtime";
import { bridgeConfigSchema } from "../../apps/pi-bridge/src/config.js";
const binary = resolve(
  `apps/pi-bridge/dist/lingo-sofa-native-host${process.platform === "win32" ? ".exe" : ""}`,
);
// Windows registration uses HKCU, which this profile-isolated test does not modify.
test.skip(
  process.platform === "win32" || !existsSync(binary),
  "Requires packaged host and profile-local registration",
);
test("auto-starts shared service from MV3 and keeps Discord connected after browser releases its lease", async () => {
  test.setTimeout(90_000); // Includes copying the complete local runtime dependency snapshot.
  const directory = await mkdtemp(join(tmpdir(), "lingo-managed-browser-"));
  const home = join(directory, "home");
  const profile = join(directory, "profile");
  const extension = join(directory, "extension");
  await mkdir(home);
  await cp(resolve("apps/browser-extension/.output/chrome-mv3"), extension, {
    recursive: true,
  });
  // Pre-register before the first browser startup, as the production installer does.
  const publicKey = generateKeyPairSync("rsa", {
    modulusLength: 1024,
  }).publicKey.export({ type: "spki", format: "der" });
  const id = createHash("sha256")
    .update(publicKey)
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (c) =>
      String.fromCharCode(97 + Number.parseInt(c, 16)),
    );
  const manifest = JSON.parse(
    await readFile(join(extension, "manifest.json"), "utf8"),
  );
  manifest.key = publicKey.toString("base64");
  await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
  const socket = createServer();
  await new Promise<void>((done) => socket.listen(0, "127.0.0.1", done));
  const port = (socket.address() as AddressInfo).port;
  await new Promise<void>((done) => socket.close(() => done()));
  await writeFile(
    join(home, "config.json"),
    JSON.stringify(
      bridgeConfigSchema.parse({
        port,
        allowedExtensions: [id],
        settings: { persistUsage: true },
      }),
    ),
  );
  await test.step("install private runtime", async () => {
    execFileSync(process.execPath, ["install-runtime.mjs", id], {
      cwd: resolve("apps/pi-bridge"),
      env: { ...process.env, LINGO_SOFA_HOME: home },
    });
  });
  const localBinary = join(home, "lingo-sofa-native-host");
  await copyFile(binary, localBinary);
  await mkdir(join(profile, "NativeMessagingHosts"), { recursive: true });
  await writeFile(
    join(profile, "NativeMessagingHosts/com.lingosofa.bridge.json"),
    JSON.stringify({
      name: "com.lingosofa.bridge",
      description: "Isolated LingoSofa test",
      path: localBinary,
      type: "stdio",
      allowed_origins: [`chrome-extension://${id}/`],
    }),
  );
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    env: { ...process.env, LINGO_SOFA_HOME: home },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  const desktop = new RuntimeClient(home, "https://discord.com");
  let pid: number | undefined;
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    expect(new URL(worker.url()).host).toBe(id);
    const options = await context.newPage();
    await test.step("open local Provider page", async () => {
      await options.goto(`chrome-extension://${id}/options.html`);
    });
    await expect(options.getByLabel("翻译模型", { exact: true })).toHaveValue(
      "current:deepseek-flash",
      { timeout: 15000 },
    );
    const state = await test.step("read shared usage", async () =>
      options.evaluate(async () =>
        (
          globalThis as typeof globalThis & {
            chrome: typeof import("wxt/browser").browser;
          }
        ).chrome.runtime.sendMessage({ action: "state" }),
      ));
    expect(state.settings.mode).toBe("bridge");
    expect(state.bridgeError).toBeUndefined();
    const running = JSON.parse(
      await readFile(join(home, "runtime-connection.json"), "utf8"),
    );
    pid = running.pid;
    const connection =
      await test.step("connect Discord native client", async () =>
        desktop.start());
    expect(connection.instanceId).toBe(running.instanceId);
    const provider = await runtimePost(
      connection,
      "https://discord.com",
      "/v1/provider",
      {},
    );
    expect(await provider.json()).toMatchObject({
      model: { provider: "deepseek" },
      keyConfigured: false,
    });
    await options.evaluate(async (settings) => {
      await (
        globalThis as typeof globalThis & {
          chrome: typeof import("wxt/browser").browser;
        }
      ).chrome.runtime.sendMessage({
        action: "save",
        settings: { ...settings, mode: "direct" },
      });
    }, state.settings);
    await expect
      .poll(
        async () =>
          (
            await (
              await runtimePost(
                connection,
                "https://discord.com",
                "/v1/runtime/status",
                {},
              )
            ).json()
          ).clients,
        { timeout: 50_000 },
      )
      .toBe(1);
    expect(
      (await runtimePost(connection, "https://discord.com", "/v1/provider", {}))
        .status,
    ).toBe(200);
    await desktop.stop();
    if (process.platform !== "win32")
      expect(
        (await stat(join(home, "runtime-connection.json"))).mode & 0o777,
      ).toBe(0o600);
  } finally {
    await desktop.stop();
    // Even a failed browser assertion must clean up the daemon it started.
    try {
      pid ??= JSON.parse(
        await readFile(join(home, "runtime-connection.json"), "utf8"),
      ).pid;
    } catch {
      /* Not started. */
    }
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* Already exited. */
      }
    }
    await expect
      .poll(
        async () =>
          readFile(join(home, "runtime-connection.json")).then(
            () => false,
            () => true,
          ),
        { timeout: 5_000 },
      )
      .toBe(true);
    await context.close();
    await rm(directory, { recursive: true, force: true });
  }
});
