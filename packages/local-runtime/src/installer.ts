import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  validateAsset,
  type AssistantAsset,
  type AssistantRelease,
} from "./release.js";
export {
  validateAsset,
  type AssistantAsset,
  type AssistantRelease,
} from "./release.js";
export function validateArchiveListing(listing: string, directory: string) {
  const entries = listing.trim().split(/\r?\n/);
  if (!entries.length || entries.length > 100_000)
    throw new Error("Invalid assistant archive");
  for (const entry of entries) {
    const path = entry.replace(/\/$/, "");
    if (
      (path !== directory && !path.startsWith(`${directory}/`)) ||
      path.includes("\\") ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Unsafe assistant archive path");
  }
}
const execute = promisify(execFile);
const maxDownload = 350 * 1024 * 1024;
export async function downloadAssistant(
  asset: AssistantAsset,
  fetcher: typeof fetch = fetch,
): Promise<Buffer> {
  const response = await fetcher(asset.url, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body)
    throw new Error("助手下载失败，请检查网络后重试");
  if (Number(response.headers.get("content-length")) > maxDownload)
    throw new Error("Assistant download too large");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxDownload) throw new Error("Assistant download too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const data = Buffer.concat(chunks);
  if (createHash("sha256").update(data).digest("hex") !== asset.sha256)
    throw new Error("助手安装包校验失败，未执行安装");
  return data;
}
/** Called only by a native host. Release URLs and hashes are embedded at plugin build time. */
export class AssistantInstaller {
  private pending: Promise<void> | undefined;
  constructor(
    private readonly directory: string,
    private readonly release: AssistantRelease,
    private readonly progress: (message: string) => void = () => undefined,
  ) {}
  ensureInstalled(): Promise<void> {
    this.pending ??= this.install().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async install() {
    try {
      await access(join(this.directory, "runtime-install.json"));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const asset = validateAsset(this.release, process.platform, process.arch);
    this.progress("正在下载本地助手…");
    const data = await downloadAssistant(asset);
    const work = await mkdtemp(join(tmpdir(), "lingo-assistant-download-"));
    const archive = join(work, "assistant.tar.gz");
    const options = {
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    };
    try {
      await writeFile(archive, data, { mode: 0o600 });
      const { stdout } = await execute("tar", ["-tzf", archive], options);
      validateArchiveListing(stdout, asset.directory);
      const verbose = await execute("tar", ["-tvzf", archive], options);
      if (
        verbose.stdout
          .trim()
          .split(/\r?\n/)
          .some((line) => !/^[d-]/.test(line))
      )
        throw new Error(
          "Links and special files are forbidden in assistant archives",
        );
      this.progress("正在安装本地助手…");
      await execute("tar", ["-xzf", archive, "-C", work], options);
      const payload = join(work, asset.directory);
      await execute(
        join(
          payload,
          "runtime",
          process.platform === "win32" ? "node.exe" : "node",
        ),
        [join(payload, "install.mjs")],
        {
          ...options,
          cwd: payload,
          env: {
            ...process.env,
            NODE_OPTIONS: "",
            LINGO_SOFA_HOME: this.directory,
          },
        },
      );
      this.progress("本地助手已安装");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}
