import { expect, it, vi, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersions,
  parseWindowsUpdate,
  WindowsUpdater,
  latestReleaseUrl,
} from "../packages/local-runtime/src/updates.js";

afterEach(() => vi.unstubAllGlobals());
function release(data = Buffer.from("installer")) {
  return {
    tag_name: "v0.2.0",
    draft: false,
    prerelease: false,
    assets: [
      {
        name: "LingoSofa-Setup-0.2.0-win32-x64.exe",
        browser_download_url:
          "https://github.com/ChenMiaoi/lingo-sofa/releases/download/v0.2.0/LingoSofa-Setup-0.2.0-win32-x64.exe",
        digest: `sha256:${createHash("sha256").update(data).digest("hex")}`,
      },
    ],
  };
}
it("compares release components numerically and rejects ambiguous versions", () => {
  expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
  expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  expect(compareVersions("0.1.0", "1.0.0")).toBe(-1);
  for (const value of ["1.0", "01.0.0", "1.0.0-rc.1", "1.0.0\n", "../1.0.0"])
    expect(() => compareVersions(value, "0.1.0")).toThrow();
});
it("offers only newer stable releases with the exact installer and GitHub digest", () => {
  expect(parseWindowsUpdate(release(), "0.1.0")?.version).toBe("0.2.0");
  expect(parseWindowsUpdate(release(), "0.2.0")).toBeNull();
  expect(
    parseWindowsUpdate({ ...release(), prerelease: true }, "0.1.0"),
  ).toBeNull();
  expect(parseWindowsUpdate({ ...release(), draft: true }, "0.1.0")).toBeNull();
  expect(parseWindowsUpdate({ ...release(), assets: [] }, "0.1.0")).toBeNull();
  for (const change of [
    { digest: undefined },
    { digest: "sha256:bad" },
    { browser_download_url: "https://evil.example/Setup.exe" },
  ]) {
    const value = release();
    Object.assign(value.assets[0]!, change);
    expect(() => parseWindowsUpdate(value, "0.1.0")).toThrow("checksum");
  }
});
it.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "stages only verified bytes, blocks overlap and rechecks files before execution",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "lingo-update-test-"));
    const data = Buffer.from("test installer, never executed");
    const fetcher = vi.fn(async (url: string) =>
      url === latestReleaseUrl
        ? Response.json(release(data))
        : new Response(data),
    );
    vi.stubGlobal("fetch", fetcher);
    const launch = vi.fn(async () => undefined);
    const updater = new WindowsUpdater(home, "0.1.0", launch);
    try {
      await expect(updater.download()).rejects.toThrow("先检查");
      const check = updater.check();
      await expect(updater.check()).rejects.toThrow("进行");
      expect(await check).toEqual({ version: "0.2.0" });
      await updater.download();
      const path = join(home, "updates/0.2.0/Setup.exe");
      expect(await readFile(path)).toEqual(data);
      await writeFile(
        join(home, "windows-install.json"),
        JSON.stringify({ target: "C:\\DiscordCanary" }),
      );
      await updater.launch();
      expect(launch).toHaveBeenCalledWith(
        path,
        [
          "/SILENT",
          "/NORESTART",
          "/RESTARTDISCORD=1",
          "/DISCORDDIR=C:\\DiscordCanary",
        ],
        expect.objectContaining({ LINGO_SOFA_HOME: home, NODE_OPTIONS: "" }),
      );
      await expect(updater.launch()).rejects.toThrow("先下载");
      await updater.download();
      await writeFile(path, "tampered");
      await expect(updater.launch()).rejects.toThrow("校验失败");
      fetcher.mockImplementation(async () => new Response("tampered"));
      await expect(updater.download()).rejects.toThrow("校验失败");
      await expect(updater.launch()).rejects.toThrow("先下载");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
