import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

export async function requireDesktopDependencies(
  manifest = resolve(import.meta.dirname, "../apps/desktop/package.json"),
) {
  const { dependencies } = JSON.parse(await readFile(manifest, "utf8")) as {
    dependencies: Record<string, string>;
  };
  const require = createRequire(manifest);
  const missing = Object.keys(dependencies).filter((name) => {
    try {
      require.resolve(name);
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length)
    throw new Error(
      `Desktop dependencies are missing: ${missing.join(", ")}. Run bun install --frozen-lockfile in the repository root, then retry.`,
    );
}

function launch(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  ipc = false,
) {
  const child = spawn(command[0]!, command.slice(1), {
    cwd,
    env,
    // Unix cleanup targets process groups. Windows uses taskkill and the job
    // guard; detaching there can create an unwanted console window.
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(process.stdout, { end: false });
  child.stderr?.pipe(process.stderr, { end: false });
  return child;
}

function exited(child: ChildProcess) {
  return new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
}

async function stop(child: ChildProcess) {
  if (!child.pid) return;
  const running = child.exitCode === null && child.signalCode === null;
  const finished = running ? exited(child) : Promise.resolve();
  if (process.platform === "win32") {
    if (!running) return;
    // Killing the CLI alone leaves Cargo, WebView2 or Vite descendants behind.
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        {
          windowsHide: true,
          stdio: "ignore",
        },
      );
      killer.once("error", () => {
        child.kill();
        resolve();
      });
      killer.once("exit", () => resolve());
    });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  await finished;
}

export async function runDevelopment(options: {
  server: string[];
  app: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}) {
  let interrupt!: () => void;
  const interrupted = new Promise<void>((resolve) => {
    interrupt = resolve;
  });
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const server = launch(options.server, options.cwd, options.env, true);
  const serverExited = exited(server);
  let app: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = new Promise<true>((resolve, reject) => {
      server.on("message", (message) => {
        if (message === "lingo-sofa:dev-ready") resolve(true);
      });
      timer = setTimeout(
        () => reject(new Error("Development server startup timed out.")),
        options.startupTimeoutMs ?? 30_000,
      );
    });
    const serverFailed = serverExited.then((code) => {
      throw new Error(
        `Development server exited (${code}). See its output above.`,
      );
    });
    if (!(await Promise.race([ready, serverFailed, interrupted]))) return;
    clearTimeout(timer);
    app = launch(options.app, options.cwd, options.env);
    await Promise.race([
      exited(app).then((code) => {
        if (code !== 0)
          throw new Error(`Desktop application exited (${code}).`);
      }),
      serverFailed,
      interrupted,
    ]);
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (app) await stop(app);
    await stop(server);
  }
}

// Node handles Windows console signals; Bun can terminate before JS cleanup runs.
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const options = JSON.parse(process.argv[2]!);
  await runDevelopment({ ...options, env: process.env });
}
