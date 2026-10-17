import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, cp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { createHash, generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Settings } from "@lingo-sofa/protocol";

test.skip(
  process.platform === "win32",
  "Requires profile-local native registration",
);
test("registers profile startup and bootstraps native with reading disabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lingo-profile-startup-"));
  const extension = join(directory, "extension");
  const profile = join(directory, "profile");
  const marker = join(directory, "native-starts");
  const host = join(directory, "startup-host.mjs");
  await cp(resolve("apps/browser-extension/.output/chrome-mv3"), extension, {
    recursive: true,
  });
  const key = generateKeyPairSync("rsa", {
    modulusLength: 1024,
  }).publicKey.export({ type: "spki", format: "der" });
  const id = createHash("sha256")
    .update(key)
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (c) =>
      String.fromCharCode(97 + Number.parseInt(c, 16)),
    );
  const manifest = JSON.parse(
    await readFile(join(extension, "manifest.json"), "utf8"),
  );
  manifest.key = key.toString("base64");
  await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
  // An immediately exiting native probe avoids CDP's persistent-port shutdown
  // limitation. It cannot connect to the user's service or send model requests.
  await writeFile(
    host,
    `#!${process.execPath}\nimport {appendFileSync} from "node:fs";appendFileSync(${JSON.stringify(marker)}, "started\\n");\n`,
    { mode: 0o700 },
  );
  await mkdir(join(profile, "NativeMessagingHosts"), { recursive: true });
  await writeFile(
    join(profile, "NativeMessagingHosts/com.lingosofa.bridge.json"),
    JSON.stringify({
      name: "com.lingosofa.bridge",
      description: "Startup probe",
      path: host,
      type: "stdio",
      allowed_origins: [`chrome-extension://${id}/`],
    }),
  );
  let context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    // Command-line installs wake a worker independently of onStartup. Verify
    // Chrome retained a startup subscription, which ordinary profiles require.
    expect(
      await worker.evaluate(() =>
        (
          globalThis as typeof globalThis & {
            chrome: typeof import("wxt/browser").browser;
          }
        ).chrome.runtime.onStartup.hasListeners(),
      ),
    ).toBe(true);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/popup.html`);
    // Wait for initialization before changing modes, so migration cannot
    // overwrite the explicit shared-assistant setting.
    const settings = await page.evaluate(async () => {
      const api = (
        globalThis as typeof globalThis & {
          chrome: typeof import("wxt/browser").browser;
        }
      ).chrome;
      const state = await api.runtime.sendMessage({
        action: "state",
        localOnly: true,
      });
      return state.settings as Settings;
    });
    expect(settings.mode).toBe("direct");
    expect(await readFile(marker, "utf8").catch(() => "")).toBe("");
    await worker.evaluate(
      (settings) =>
        (
          globalThis as typeof globalThis & {
            chrome: typeof import("wxt/browser").browser;
          }
        ).chrome.storage.local.set({
          readingEnabled: false,
          settings: { ...settings, mode: "bridge" },
        }),
      settings,
    );
    await page.close();
    await expect
      .poll(async () => readFile(marker, "utf8").catch(() => ""))
      .toContain("started");
    await context.close();
    await rm(marker, { force: true });
    // Command-line unpacked extensions require the same path on every launch.
    // Reuse the profile and never open an extension page to wake the worker.
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    });
    await expect
      .poll(async () => readFile(marker, "utf8").catch(() => ""), {
        timeout: 10000,
      })
      .toContain("started");
  } finally {
    await context.close();
    await rm(directory, { recursive: true, force: true });
  }
});
