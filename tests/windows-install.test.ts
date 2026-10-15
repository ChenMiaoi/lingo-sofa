import { expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  verifyBundle,
  installWindowsBundle,
  type RunInstaller,
} from "../scripts/windows/install.js";

async function fixture(version = "0.2.0") {
  const root = await mkdtemp(join(tmpdir(), "lingo-windows-test-"));
  const payload = join(root, "payload");
  const home = join(root, "home");
  const target = join(root, "Discord");
  const settings = join(root, "settings/settings.json");
  const resources = join(target, "app-1.0.0/resources");
  await mkdir(resources, { recursive: true });
  await mkdir(home);
  await mkdir(payload);
  await writeFile(join(resources, "app.asar"), "original discord");
  const assistantDirectory = `lingo-sofa-assistant-${version}-win32-x64`;
  const files: Record<string, string> = {};
  for (const path of [
    "package.json",
    "vencord/package.json",
    "vencord/dist/patcher.js",
    "VencordInstallerCli.exe",
    "install.js",
    `${assistantDirectory}/install.mjs`,
    `${assistantDirectory}/runtime/node.exe`,
  ]) {
    const directory = path.split("/").slice(0, -1).join("/");
    await mkdir(join(payload, directory), { recursive: true });
    const contents =
      path === "vencord/package.json"
        ? '{"type":"commonjs"}'
        : path === "package.json"
          ? '{"type":"module"}'
          : path;
    await writeFile(join(payload, path), contents);
    files[path] = createHash("sha256").update(contents).digest("hex");
  }
  await writeFile(
    join(payload, "windows-bundle.json"),
    JSON.stringify({
      version,
      platform: "win32-x64",
      assistantDirectory,
      files,
    }),
  );
  const run: RunInstaller = async (executable, _args, env) => {
    if (executable.endsWith("node.exe")) {
      await writeFile(
        join(home, "runtime-install.json"),
        JSON.stringify({ version }),
      );
      await writeFile(join(home, "config.json"), "new runtime config");
    } else {
      await writeFile(join(resources, "_app.asar"), "original discord");
      await writeFile(
        join(resources, "app.asar"),
        `require(${JSON.stringify(join(env.VENCORD_USER_DATA_DIR!, "dist", "patcher.js"))})`,
      );
    }
  };
  return { root, payload, home, target, settings, resources, run };
}
it("installs both components, enables the plugin and retains accounts/history on upgrade", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.home, "accounts.json"), "private account fixture");
    await writeFile(
      join(f.home, "windows-install.json"),
      JSON.stringify({ version: "0.1.0", target: f.target }),
    );
    await installWindowsBundle(f);
    expect(
      JSON.parse(await readFile(join(f.home, "windows-install.json"), "utf8")),
    ).toMatchObject({
      version: "0.2.0",
      previousVersion: "0.1.0",
      target: f.target,
    });
    expect(await readFile(join(f.home, "accounts.json"), "utf8")).toBe(
      "private account fixture",
    );
    expect(
      JSON.parse(await readFile(f.settings, "utf8")).plugins.LingoSofa.enabled,
    ).toBe(true);
    // Reinstall preserves an explicitly disabled plugin and unrelated settings.
    await writeFile(
      f.settings,
      JSON.stringify({
        custom: "keep",
        plugins: { LingoSofa: { enabled: false } },
      }),
    );
    await installWindowsBundle(f);
    expect(JSON.parse(await readFile(f.settings, "utf8"))).toMatchObject({
      custom: "keep",
      plugins: { LingoSofa: { enabled: false } },
    });
    const probe = join(
      f.home,
      "windows/v0.2.0/vencord/dist/package-boundary.js",
    );
    await writeFile(
      probe,
      'module.exports = typeof require("node:path").join;',
    );
    expect(
      execFileSync(
        process.execPath,
        ["-e", `process.stdout.write(require(${JSON.stringify(probe)}))`],
        { encoding: "utf8" },
      ),
    ).toBe("function");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it("rejects an ESM Vencord host before changing Discord or the assistant", async () => {
  const f = await fixture();
  try {
    await writeFile(
      join(f.payload, "vencord/package.json"),
      '{"type":"module"}',
    );
    await expect(installWindowsBundle(f)).rejects.toThrow("CommonJS");
    expect(await readFile(join(f.resources, "app.asar"), "utf8")).toBe(
      "original discord",
    );
    expect(await readdir(f.home)).toEqual([]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it.each(["assistant", "host", "false-success"])(
  "restores the old runtime and Discord when %s fails",
  async (failure) => {
    const f = await fixture();
    try {
      await writeFile(join(f.home, "runtime-install.json"), "old runtime");
      await writeFile(join(f.home, "config.json"), "old config");
      await expect(
        installWindowsBundle({
          ...f,
          run: async (executable, args, env) => {
            if (
              failure === "false-success" &&
              executable.endsWith(".exe") &&
              !executable.endsWith("node.exe")
            )
              return;
            await f.run(executable, args, env);
            if ((failure === "assistant") === executable.endsWith("node.exe"))
              throw new Error("fixture failure");
          },
        }),
      ).rejects.toThrow();
      expect(await readFile(join(f.home, "runtime-install.json"), "utf8")).toBe(
        "old runtime",
      );
      expect(await readFile(join(f.home, "config.json"), "utf8")).toBe(
        "old config",
      );
      expect(await readFile(join(f.resources, "app.asar"), "utf8")).toBe(
        "original discord",
      );
      expect(await readdir(f.resources)).toEqual(["app.asar"]);
      expect(await readdir(f.home)).not.toContain(".windows-install-lock");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);
it("rejects altered files, unexpected files, downgrades and concurrent installers before mutation", async () => {
  const f = await fixture();
  try {
    await writeFile(
      join(f.home, "windows-install.json"),
      JSON.stringify({ version: "0.3.0", target: f.target }),
    );
    await expect(installWindowsBundle(f)).rejects.toThrow("更旧");
    await mkdir(join(f.home, ".windows-install-lock"));
    await expect(installWindowsBundle(f)).rejects.toThrow();
    await writeFile(join(f.payload, "vencord/dist/patcher.js"), "altered");
    await expect(verifyBundle(f.payload)).rejects.toThrow("checksum");
    await writeFile(join(f.payload, "extra.exe"), "extra");
    await expect(verifyBundle(f.payload)).rejects.toThrow("Unexpected");
    expect(await readFile(join(f.resources, "app.asar"), "utf8")).toBe(
      "original discord",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it("prepares immutable files before requesting client exit and snapshots the latest settings afterwards", async () => {
  const f = await fixture();
  let prepared = false;
  try {
    await installWindowsBundle({
      ...f,
      beforeInstall: async () => {
        expect(
          await readFile(
            join(f.home, "windows/v0.2.0/vencord/dist/patcher.js"),
            "utf8",
          ),
        ).toBe("vencord/dist/patcher.js");
        expect(await readFile(join(f.resources, "app.asar"), "utf8")).toBe(
          "original discord",
        );
        await mkdir(join(f.root, "settings/settings"), { recursive: true });
        await writeFile(
          f.settings,
          JSON.stringify({
            userChangedWhilePreparing: true,
            plugins: { LingoSofa: { enabled: false } },
          }),
        );
        prepared = true;
      },
      run: async (...args) => {
        expect(prepared).toBe(true);
        await f.run(...args);
      },
    });
    expect(JSON.parse(await readFile(f.settings, "utf8"))).toMatchObject({
      userChangedWhilePreparing: true,
      plugins: { LingoSofa: { enabled: false } },
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it("does not change the installed host or runtime when preparation is cancelled", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.home, "runtime-install.json"), "existing runtime");
    await expect(
      installWindowsBundle({
        ...f,
        beforeInstall: async () => {
          throw new Error("cancelled before exit");
        },
      }),
    ).rejects.toThrow("cancelled before exit");
    expect(await readFile(join(f.home, "runtime-install.json"), "utf8")).toBe(
      "existing runtime",
    );
    expect(await readFile(join(f.resources, "app.asar"), "utf8")).toBe(
      "original discord",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
