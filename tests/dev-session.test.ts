import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  runDevelopment,
  requireDesktopDependencies,
} from "../scripts/dev-session";
import { root, cleanEnv } from "../scripts/process";

const fixture = join(root, "tests/fixtures/dev-process.ts");
async function expectStopped(pidFile: string) {
  const pid = Number(await readFile(pidFile, "utf8"));
  // A killed process group may briefly retain a child until the OS reaps it.
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`Development child ${pid} survived session cleanup.`);
}
async function temporaryDirectory() {
  await mkdir(join(root, ".cache"), { recursive: true });
  return mkdtemp(join(root, ".cache/dev session 中文-"));
}

test("missing desktop dependencies fail before launch with an actionable install command", async () => {
  const directory = await temporaryDirectory();
  try {
    const manifest = join(directory, "package.json");
    await writeFile(
      manifest,
      JSON.stringify({
        dependencies: { "lingo-sofa-missing-test-dependency": "1.0.0" },
      }),
    );
    await expect(requireDesktopDependencies(manifest)).rejects.toThrow(
      "bun install --frozen-lockfile",
    );
    await requireDesktopDependencies();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed or stalled frontend startup never launches the desktop application", async () => {
  const directory = await temporaryDirectory();
  try {
    for (const mode of ["startup-fail", "stall"]) {
      const log = join(directory, `${mode}.log`);
      await expect(
        runDevelopment({
          server: ["node", fixture, mode],
          app: ["node", fixture, "app", log],
          cwd: directory,
          env: cleanEnv(),
          startupTimeoutMs: mode === "stall" ? 500 : 5000,
        }),
      ).rejects.toThrow(
        mode === "stall" ? "timed out" : "Development server exited (7)",
      );
      expect(await Bun.file(log).exists()).toBe(false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test.skipIf(process.platform !== "win32")(
  "Windows reaps the entire dev tree even when its supervisor is forcibly terminated",
  async () => {
    const directory = await temporaryDirectory();
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const build = Bun.spawn(
        [
          "cargo",
          "build",
          "--locked",
          "-p",
          "lingo-sofa-omp-client",
          "--example",
          "dev-session",
        ],
        {
          cwd: root,
          env: cleanEnv(),
          stdout: "inherit",
          stderr: "inherit",
        },
      );
      expect(await build.exited).toBe(0);
      const log = join(directory, "guard.log");
      const pidFile = join(directory, "guard.pid");
      child = Bun.spawn(
        [
          join(root, "target/debug/examples/dev-session.exe"),
          "node",
          fixture,
          "server",
          log,
          pidFile,
        ],
        {
          cwd: directory,
          env: cleanEnv(),
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      for (
        let attempt = 0;
        attempt < 200 && !(await Bun.file(pidFile).exists());
        attempt++
      )
        await Bun.sleep(25);
      expect(await Bun.file(pidFile).exists()).toBe(true);
      child.kill();
      await child.exited;
      await expectStopped(pidFile);
      await expectStopped(`${pidFile}.parent`);
    } finally {
      child?.kill();
      if (child) await child.exited;
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  },
  180_000,
);

test("desktop launch waits for its own frontend and exiting cleans up the frontend process tree", async () => {
  const directory = await temporaryDirectory();
  try {
    const log = join(directory, "session.log");
    const pidFile = join(directory, "child.pid");
    await runDevelopment({
      server: ["node", fixture, "server", log, pidFile],
      app: ["node", fixture, "app", log],
      cwd: directory,
      env: cleanEnv(),
    });
    expect(await readFile(log, "utf8")).toBe("ready\napp\n");
    await expectStopped(pidFile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test("frontend failure stops a running desktop tree and desktop failure stops its frontend tree", async () => {
  const directory = await temporaryDirectory();
  try {
    for (const serverFails of [true, false]) {
      const log = join(directory, `failure-${serverFails}.log`);
      const pidFile = join(directory, `failure-${serverFails}.pid`);
      await expect(
        runDevelopment({
          server: [
            "node",
            fixture,
            serverFails ? "crashing-server" : "server",
            log,
            pidFile,
          ],
          app: [
            "node",
            fixture,
            serverFails ? "waiting-app" : "app-fail",
            log,
            pidFile,
          ],
          cwd: directory,
          env: cleanEnv(),
        }),
      ).rejects.toThrow(
        serverFails
          ? "Development server exited (8)"
          : "Desktop application exited (9)",
      );
      await expectStopped(pidFile);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
