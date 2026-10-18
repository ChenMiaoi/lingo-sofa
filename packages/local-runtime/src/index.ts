import { readFile } from "node:fs/promises";
import { isAbsolute, join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export const RUNTIME_LOCK_STALE_MS = 5_000;
export interface RuntimeConnection {
  version: 1;
  instanceId: string;
  port: number;
  token: string;
}
function parseConnection(value: unknown): RuntimeConnection {
  const data = value as Partial<RuntimeConnection> | null;
  if (
    !data ||
    data.version !== 1 ||
    typeof data.instanceId !== "string" ||
    !/^[\da-f-]{36}$/.test(data.instanceId) ||
    !Number.isInteger(data.port) ||
    data.port! < 1024 ||
    data.port! > 65535 ||
    typeof data.token !== "string" ||
    !/^[\da-f]{64}$/.test(data.token)
  )
    throw new Error("Invalid local runtime descriptor");
  return data as RuntimeConnection;
}
export async function runtimePost(
  connection: RuntimeConnection,
  origin: string,
  route: string,
  body: unknown,
) {
  return fetch(`http://127.0.0.1:${connection.port}${route}`, {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
  });
}
export async function discoverRuntime(
  directory: string,
  origin: string,
): Promise<RuntimeConnection | null> {
  try {
    const connection = parseConnection(
      JSON.parse(
        await readFile(join(directory, "runtime-connection.json"), "utf8"),
      ) as unknown,
    );
    const response = await runtimePost(
      connection,
      origin,
      "/v1/runtime/status",
      {},
    );
    const status = (await response.json()) as {
      version?: unknown;
      instanceId?: unknown;
    };
    return response.ok &&
      status.version === 1 &&
      status.instanceId === connection.instanceId
      ? connection
      : null;
  } catch {
    return null;
  }
}
/** Only the fixed, locally installed entry point may be launched; never renderer input. */
export async function ensureRuntime(
  directory: string,
  origin: string,
): Promise<RuntimeConnection> {
  const running = await discoverRuntime(directory, origin);
  if (running) return running;
  let installation: { executable: string; entrypoint: string };
  try {
    installation = JSON.parse(
      await readFile(join(directory, "runtime-install.json"), "utf8"),
    ) as typeof installation;
    if (
      !isAbsolute(installation.executable) ||
      !isAbsolute(installation.entrypoint)
    )
      throw new Error("Invalid installation");
  } catch {
    throw new Error("请先安装 LingoSofa 本地助手");
  }
  let launchError = false;
  let exited = false;
  let retryAt = 0;
  const launch = () => {
    exited = false;
    retryAt = Date.now() + RUNTIME_LOCK_STALE_MS + 1_000;
    const child = spawn(
      installation.executable,
      [installation.entrypoint, "--service"],
      {
        detached: true,
        cwd: dirname(installation.entrypoint),
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, LINGO_SOFA_HOME: directory },
      },
    );
    child.once("error", () => {
      launchError = true;
    });
    child.once("exit", () => {
      exited = true;
    });
    child.unref();
  };
  launch();
  // First Windows launch may scan the dependency snapshot before the service can bind.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !launchError) {
    await delay(100);
    const connection = await discoverRuntime(directory, origin);
    if (connection) return connection;
    // A crashed owner can leave a lease lock briefly. Retry only the fixed service
    // executable after that lock expires; model requests are never replayed here.
    if (exited && Date.now() >= retryAt) launch();
  }
  throw new Error("本地助手启动失败，请检查安装、版本或端口占用");
}
/** Shared by the browser relay and Discord native layer. No model requests are retried. */
export class RuntimeClient {
  private id = randomUUID();
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<RuntimeConnection> | undefined;
  private cached: RuntimeConnection | undefined;
  private checkedAt = 0;
  private active = false;
  constructor(
    private readonly directory: string,
    private readonly origin: string,
  ) {}
  start(): Promise<RuntimeConnection> {
    if (!this.active) {
      this.id = randomUUID();
      this.pending = undefined;
      this.cached = undefined;
    }
    this.active = true;
    this.timer ??= setInterval(() => {
      void this.connection(true).catch(() => undefined);
    }, 15_000);
    this.timer.unref();
    return this.connection();
  }
  connection(refresh = false): Promise<RuntimeConnection> {
    if (!this.active) return this.start();
    if (!refresh && this.cached && Date.now() - this.checkedAt < 10_000)
      return Promise.resolve(this.cached);
    if (this.pending) return this.pending;
    const pending = this.acquire().finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }
  private async acquire() {
    const id = this.id;
    const connection = await ensureRuntime(this.directory, this.origin);
    if (!this.active || this.id !== id)
      throw new Error("Local runtime client stopped");
    const response = await runtimePost(
      connection,
      this.origin,
      "/v1/runtime/lease",
      { id, action: "renew" },
    );
    if (!response.ok) throw new Error("Local runtime connection rejected");
    if (!this.active || this.id !== id)
      throw new Error("Local runtime client stopped");
    this.cached = connection;
    this.checkedAt = Date.now();
    return connection;
  }
  async stop() {
    const id = this.id;
    this.active = false;
    clearInterval(this.timer);
    this.timer = undefined;
    this.cached = undefined;
    await this.pending?.catch(() => undefined);
    if (this.id === id) this.cached = undefined;
    // Discovery does not launch a service during shutdown.
    const connection = await discoverRuntime(this.directory, this.origin);
    if (connection)
      await runtimePost(connection, this.origin, "/v1/runtime/lease", {
        id,
        action: "release",
      }).catch(() => undefined);
  }
}
