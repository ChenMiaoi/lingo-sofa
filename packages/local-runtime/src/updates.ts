import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { downloadAssistant } from "./installer.js";
import { assistantDownloads } from "./release.js";

export const latestReleaseUrl =
  "https://api.github.com/repos/ChenMiaoi/lingo-sofa/releases/latest";
export async function waitForInstallerReady(path: string, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      try {
        const status = JSON.parse(await readFile(path, "utf8")) as {
          ready?: boolean;
          error?: string;
        };
        if (status.error) throw new Error(status.error);
        if (status.ready === true) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await delay(250);
    }
    throw new Error("安装准备超时，Discord 保持打开；请检查安装器后重试。");
  } finally {
    await rm(path, { force: true });
  }
}
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
      throw new Error("Invalid release version");
    return value.split(".").map(BigInt);
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return 1;
    if (a[i]! < b[i]!) return -1;
  }
  return 0;
}
export interface WindowsUpdate {
  version: string;
  url: string;
  sha256: string;
}
type LaunchInstaller = (
  path: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<void>;
async function launchInstaller(
  path: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  const child = spawn(path, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    env,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}
/** GitHub's asset digest is required; a filename alone never authorizes execution. */
export function parseWindowsUpdate(
  value: unknown,
  current: string,
): WindowsUpdate | null {
  const release = value as {
    tag_name?: string;
    draft?: boolean;
    prerelease?: boolean;
    assets?: { name: string; browser_download_url: string; digest?: string }[];
  };
  if (
    !release ||
    typeof release.tag_name !== "string" ||
    !release.tag_name.startsWith("v")
  )
    throw new Error("Invalid GitHub release");
  const version = release.tag_name.slice(1);
  if (
    compareVersions(version, current) <= 0 ||
    release.draft ||
    release.prerelease
  )
    return null;
  const name = `LingoSofa-Setup-${version}-win32-x64.exe`;
  const asset = release.assets?.find((entry) => entry.name === name);
  if (!asset) return null;
  if (
    asset.browser_download_url !==
      `${assistantDownloads}/download/v${version}/${name}` ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "")
  )
    throw new Error("Release installer URL or checksum is invalid");
  return {
    version,
    url: asset.browser_download_url,
    sha256: asset.digest!.slice(7),
  };
}

/** Owned by the native host, never accepts URLs, paths or commands from renderer IPC. */
export class WindowsUpdater {
  private available: WindowsUpdate | null = null;
  private staged: WindowsUpdate | null = null;
  private pending: Promise<unknown> | undefined;
  constructor(
    private readonly directory: string,
    private readonly version: string,
    private readonly startInstaller: LaunchInstaller = launchInstaller,
  ) {}
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.pending) throw new Error("更新操作正在进行");
    const pending = work();
    this.pending = pending;
    try {
      return await pending;
    } finally {
      this.pending = undefined;
    }
  }
  async check() {
    return this.exclusive(async () => {
      if (process.platform !== "win32" || process.arch !== "x64")
        throw new Error("一体化更新目前仅支持 Windows x64");
      const response = await fetch(latestReleaseUrl, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error("无法检查 Release，请稍后重试");
      this.available = parseWindowsUpdate(await response.json(), this.version);
      this.staged = null;
      return this.available ? { version: this.available.version } : null;
    });
  }
  async download() {
    return this.exclusive(async () => {
      const update = this.available;
      if (!update) throw new Error("请先检查更新");
      this.staged = null;
      const data = await downloadAssistant({ ...update, directory: "unused" });
      const directory = join(this.directory, "updates", update.version);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "Setup.exe.tmp"), data, { mode: 0o600 });
      await rename(
        join(directory, "Setup.exe.tmp"),
        join(directory, "Setup.exe"),
      );
      this.staged = update;
      return { version: update.version };
    });
  }
  async launch() {
    return this.exclusive(async () => {
      const update = this.staged;
      if (!update) throw new Error("请先下载更新");
      const path = join(this.directory, "updates", update.version, "Setup.exe");
      if (
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex") !== update.sha256
      )
        throw new Error("更新文件校验失败，请重新下载");
      let args: string[] = [];
      try {
        const installation = JSON.parse(
          await readFile(join(this.directory, "windows-install.json"), "utf8"),
        ) as { target: string };
        if (
          typeof installation.target !== "string" ||
          /["\r\n]/.test(installation.target)
        )
          throw new Error("Invalid installed Discord directory");
        args = [
          "/SILENT",
          "/NORESTART",
          "/RESTARTDISCORD=1",
          `/DISCORDDIR=${installation.target}`,
        ];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const readyFile = join(
        this.directory,
        "updates",
        update.version,
        `ready-${randomUUID()}.json`,
      );
      await this.startInstaller(path, args, {
        ...process.env,
        LINGO_SOFA_HOME: this.directory,
        NODE_OPTIONS: "",
        LINGO_SOFA_UPDATE_READY: readyFile,
      });
      this.staged = null;
      return readyFile;
    });
  }
}
