import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve, isAbsolute, dirname } from "node:path";
import { compareVersions } from "../../packages/local-runtime/src/updates.js";

export interface WindowsBundle {
  version: string;
  platform: "win32-x64";
  assistantDirectory: string;
  files: Record<string, string>;
}
export async function verifyBundle(
  payload: string,
  includeAssistant = true,
): Promise<WindowsBundle> {
  const bundle = JSON.parse(
    await readFile(join(payload, "windows-bundle.json"), "utf8"),
  ) as WindowsBundle;
  compareVersions(bundle.version, bundle.version);
  if (
    bundle.platform !== "win32-x64" ||
    bundle.assistantDirectory !==
      `lingo-sofa-assistant-${bundle.version}-win32-x64`
  )
    throw new Error("Invalid Windows bundle");
  const required = [
    "vencord/package.json",
    "vencord/dist/patcher.js",
    "VencordInstallerCli.exe",
    "install.js",
    `${bundle.assistantDirectory}/install.mjs`,
    `${bundle.assistantDirectory}/runtime/node.exe`,
  ];
  if (!bundle.files || required.some((name) => !bundle.files[name]))
    throw new Error("Incomplete Windows bundle");
  const hostPackage = JSON.parse(
    await readFile(join(payload, "vencord/package.json"), "utf8"),
  );
  if (hostPackage.type !== "commonjs")
    throw new Error("Vencord must have an explicit CommonJS package boundary");
  // Check ancestors as well: a parent junction must not redirect reads or copies.
  async function walk(directory: string, prefix = ""): Promise<string[]> {
    const paths: string[] = [];
    for (const entry of await readdir(directory)) {
      const path = prefix + entry;
      const info = await lstat(join(directory, entry));
      if (info.isSymbolicLink())
        throw new Error("Links are forbidden in Windows bundles");
      if (info.isDirectory())
        paths.push(...(await walk(join(directory, entry), path + "/")));
      else if (info.isFile()) paths.push(path);
      else throw new Error("Special file in Windows bundle");
    }
    return paths;
  }
  const actual = new Set(await walk(payload));
  actual.delete("windows-bundle.json");
  const files = Object.entries(bundle.files).filter(
    ([path]) =>
      includeAssistant || !path.startsWith(`${bundle.assistantDirectory}/`),
  );
  if (actual.size !== files.length)
    throw new Error("Unexpected Windows bundle files");
  for (const [path, digest] of files) {
    if (
      isAbsolute(path) ||
      path.includes("\\") ||
      path.includes(":") ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      !actual.has(path) ||
      !/^[a-f0-9]{64}$/.test(digest)
    )
      throw new Error("Unsafe Windows bundle manifest");
    if (
      createHash("sha256")
        .update(await readFile(join(payload, path)))
        .digest("hex") !== digest
    )
      throw new Error(`Windows bundle checksum failed: ${path}`);
  }
  return bundle;
}
export async function discordResources(target: string): Promise<string> {
  const entries = (await readdir(target, { withFileTypes: true }))
    .filter(
      (entry) => entry.isDirectory() && /^app-\d+(?:\.\d+)+$/.test(entry.name),
    )
    // Match the pinned upstream installer's selection exactly.
    .map((entry) => join(target, entry.name, "resources"))
    .sort()
    .reverse();
  for (const path of entries) {
    try {
      await access(join(path, "app.asar"));
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(
    "找不到有效的 Discord 安装，请选择包含 app-* 的 Discord 目录",
  );
}
export type RunInstaller = (
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<void>;

/** Called only from the packaged bootstrap, after all connected clients have exited. */
export async function installWindowsBundle(options: {
  payload: string;
  home: string;
  target: string;
  settings: string;
  run: RunInstaller;
}) {
  const { payload, home, target, settings, run } = options;
  const bundle = await verifyBundle(payload);
  const resources = await discordResources(target);
  await mkdir(home, { recursive: true });
  const lock = join(home, ".windows-install-lock");
  await mkdir(lock); // A second installer must never share snapshots or switch pointers.
  const statePath = join(home, "windows-install.json");
  const versionDirectory = join(home, "windows", `v${bundle.version}`);
  const env = { ...process.env, NODE_OPTIONS: "", LINGO_SOFA_HOME: home };
  const backups = new Map<string, Buffer | undefined>();
  async function snapshot(path: string) {
    try {
      backups.set(path, await readFile(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      backups.set(path, undefined);
    }
  }
  let changed = false;
  try {
    try {
      const old = JSON.parse(await readFile(statePath, "utf8")) as {
        version: string;
        target: string;
      };
      if (compareVersions(bundle.version, old.version) < 0)
        throw new Error("不能安装更旧版本");
      if (resolve(old.target).toLowerCase() !== resolve(target).toLowerCase())
        throw new Error(
          "此助手已绑定另一份 Discord，请先使用原安装目标完成更新",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const path of [
      statePath,
      settings,
      join(home, "runtime-install.json"),
      join(home, "config.json"),
      join(home, "lingo-sofa-native-host.exe"),
      join(resources, "app.asar"),
      join(resources, "_app.asar"),
    ])
      await snapshot(path);
    // Immutable version directories remain available for recovery. Never overwrite a running host.
    try {
      await access(versionDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const staging = join(home, "windows", `.staging-${process.pid}`);
      await mkdir(dirname(staging), { recursive: true });
      try {
        await cp(payload, staging, {
          recursive: true,
          errorOnExist: true,
          force: false,
          // The assistant installs its own immutable snapshot; do not keep a second runtime copy.
          filter: (source) =>
            resolve(source) !== resolve(payload, bundle.assistantDirectory),
        });
        await verifyBundle(staging, false);
        await rename(staging, versionDirectory);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
    const installed = await verifyBundle(versionDirectory, false);
    if (JSON.stringify(installed) !== JSON.stringify(bundle))
      throw new Error("同版本安装内容不同，请发布新版本");
    changed = true;
    const assistant = join(payload, bundle.assistantDirectory);
    await run(
      join(assistant, "runtime/node.exe"),
      [join(assistant, "install.mjs")],
      env,
    );
    await run(
      join(versionDirectory, "VencordInstallerCli.exe"),
      ["-install", "-location", target],
      {
        ...env,
        VENCORD_DEV_INSTALL: "1",
        VENCORD_USER_DATA_DIR: join(versionDirectory, "vencord"),
      },
    );
    // Upstream has error paths that exit successfully: verify the resulting patch too.
    await access(join(resources, "_app.asar"));
    if (
      !(await readFile(join(resources, "app.asar"))).includes(
        Buffer.from(
          JSON.stringify(
            join(versionDirectory, "vencord", "dist", "patcher.js"),
          ),
        ),
      )
    )
      throw new Error("Vencord 安装结果未通过检查");
    const previousSettings = backups.get(settings);
    const value = previousSettings
      ? JSON.parse(previousSettings.toString())
      : {};
    value.plugins ??= {};
    value.plugins.LingoSofa ??= { enabled: true };
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify(value, null, 2) + "\n");
    const descriptor = JSON.parse(
      await readFile(join(home, "runtime-install.json"), "utf8"),
    );
    if (descriptor.version !== bundle.version)
      throw new Error("助手版本验证失败");
    await writeFile(
      `${statePath}.tmp`,
      JSON.stringify(
        {
          version: bundle.version,
          target,
          previousVersion: backups.get(statePath)
            ? JSON.parse(backups.get(statePath)!.toString()).version
            : null,
          host: join(versionDirectory, "vencord"),
        },
        null,
        2,
      ) + "\n",
    );
    await rename(`${statePath}.tmp`, statePath);
  } catch (error) {
    if (changed) {
      const failures: unknown[] = [];
      for (const [path, data] of backups) {
        try {
          if (data === undefined) await rm(path, { force: true });
          else {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, data);
          }
        } catch (restoreError) {
          failures.push(restoreError);
        }
      }
      if (failures.length)
        throw new AggregateError(
          [error, ...failures],
          "安装失败，部分恢复操作失败，请保留日志并重新运行安装器",
          { cause: error },
        );
    }
    throw error;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
