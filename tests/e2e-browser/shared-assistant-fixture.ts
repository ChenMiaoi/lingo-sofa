import { test, type Worker, type BrowserContext } from "@playwright/test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createBridge } from "../../apps/pi-bridge/src/server.js";
import { bridgeConfigSchema } from "../../apps/pi-bridge/src/config.js";

type Envelope = {
  transportId: string;
  payload: {
    operation?: string;
    request?: unknown;
    update?: unknown;
    migration?: unknown;
  };
  portId: number;
};
type TestGlobal = typeof globalThis & {
  chrome: typeof import("wxt/browser").browser;
  browser?: typeof import("wxt/browser").browser;
  testConnectNative?: typeof import("wxt/browser").browser.runtime.connectNative;
  nativeFixture: {
    active: boolean;
    pending: Envelope[];
    respond: (portId: number, response: unknown) => void;
  };
};
function installTestNative() {
  const root = globalThis as TestGlobal;
  if (root.nativeFixture) return;
  const listeners = new Map<number, ((value: unknown) => void)[]>();
  let sequence = 0;
  root.nativeFixture = {
    active: false,
    pending: [],
    respond: (portId, response) => {
      listeners.get(portId)?.forEach((listener) => listener(response));
    },
  };
  root.testConnectNative = ((name: string) => {
    if (!root.nativeFixture.active)
      throw new Error("Test assistant is offline");
    const portId = ++sequence;
    const messages: ((value: unknown) => void)[] = [];
    const disconnects: (() => void)[] = [];
    listeners.set(portId, messages);
    return {
      name,
      onMessage: {
        addListener: (listener: (value: unknown) => void) =>
          messages.push(listener),
      },
      onDisconnect: {
        addListener: (listener: () => void) => disconnects.push(listener),
      },
      postMessage: (envelope: Omit<Envelope, "portId">) =>
        root.nativeFixture.pending.push({ ...envelope, portId }),
      disconnect: () => {
        listeners.delete(portId);
        disconnects.forEach((listener) => listener());
      },
    };
  }) as unknown as typeof root.chrome.runtime.connectNative;
}
const cleanups: (() => Promise<void>)[] = [];
test.afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

/** Replace only the connection factory in a temporary extension copy, before it starts. */
export async function prepareTestExtension(extension: string) {
  const manifest = JSON.parse(
    await readFile(join(extension, "manifest.json"), "utf8"),
  );
  const path = join(extension, manifest.background.service_worker);
  const source = await readFile(path, "utf8");
  if (source.includes("globalThis.testConnectNative(")) return;
  const pattern = /\b[\w$]+\.runtime\.connectNative\(/g;
  if ([...source.matchAll(pattern)].length !== 1)
    throw new Error("Expected one native connection factory");
  await writeFile(
    path,
    `(${installTestNative.toString()})();\n${source.replace(pattern, "globalThis.testConnectNative(")}`,
  );
}

/** Real shared service and credentials; only the native stdio relay is substituted. */
export async function connectTestAssistant(
  worker: Worker,
  context?: BrowserContext,
) {
  const home = await mkdtemp(join(tmpdir(), "lingo-shared-browser-test-"));
  const id = new URL(worker.url()).host;
  const config = bridgeConfigSchema.parse({
    allowedExtensions: [id],
    settings: { persistUsage: true },
  });
  const token = "test-native-token".padEnd(64, "a");
  const instanceId = crypto.randomUUID();
  const bridge = createBridge(
    config,
    "",
    token,
    Date.now() + 24 * 60 * 60_000,
    home,
  );
  await new Promise<void>((done) => bridge.server.listen(0, "127.0.0.1", done));
  config.port = (bridge.server.address() as AddressInfo).port;
  const post = async (
    route: string,
    body: unknown,
    origin = `chrome-extension://${id}`,
  ) =>
    fetch(`http://127.0.0.1:${config.port}${route}`, {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  let closing = false,
    rejectImport = false,
    available = true;
  let catalogGate: { promise: Promise<void>; resolve: () => void } | undefined;
  const requests = new Set<Promise<void>>();
  const pumps: Promise<void>[] = [];
  const attachments = new WeakMap<Worker, Promise<void>>();
  async function respond(target: Worker, envelope: Envelope) {
    const request = envelope.payload;
    let payload: unknown;
    if (!available)
      payload = { ok: false, error: "Shared test assistant unavailable" };
    else if (request.operation === "runtime-status")
      payload = { version: 1, instanceId, clients: 1, appVersion: "0.1.12" };
    else if (request.operation === "import-accounts" && rejectImport) {
      rejectImport = false;
      payload = { ok: false, error: "Fixture migration failure" };
    } else {
      if (request.operation === "provider") await catalogGate?.promise;
      const route =
        request.operation === "provider"
          ? "/v1/provider"
          : request.operation === "provider-update"
            ? "/v1/provider/update"
            : request.operation === "oauth"
              ? "/v1/oauth"
              : request.operation === "import-accounts"
                ? "/v1/accounts/import"
                : request.operation === "balance"
                  ? "/v1/balance"
                  : "/v1/request";
      payload = await (
        await post(
          route,
          request.operation === "provider-update"
            ? request.update
            : request.operation === "import-accounts"
              ? request.migration
              : request.operation === "oauth"
                ? request.request
                : request.operation
                  ? {}
                  : request,
        )
      ).json();
    }
    await target
      .evaluate(
        ({ portId, response }) =>
          (globalThis as TestGlobal).nativeFixture.respond(portId, response),
        {
          portId: envelope.portId,
          response: { transportId: envelope.transportId, payload },
        },
      )
      .catch(() => undefined);
  }
  async function pump(target: Worker) {
    while (!closing) {
      let pending: Envelope[];
      try {
        pending = await target.evaluate(() =>
          (globalThis as TestGlobal).nativeFixture.pending.splice(0),
        );
      } catch {
        return;
      } // Closing or replacing a worker ends its disposable relay.
      for (const envelope of pending) {
        const task = respond(target, envelope);
        requests.add(task);
        void task.then(
          () => requests.delete(task),
          () => requests.delete(task),
        );
      }
      await delay(20);
    }
  }
  function attach(target: Worker, force = false) {
    if (force) attachments.delete(target);
    let task = attachments.get(target);
    if (!task) {
      task = attachWorker(target);
      attachments.set(target, task);
    }
    return task;
  }
  async function attachWorker(target: Worker) {
    await target.evaluate(installTestNative);
    await target.evaluate(() => {
      (globalThis as TestGlobal).nativeFixture.active = true;
    });
    pumps.push(pump(target));
  }
  const restarted = (target: Worker) => {
    void attach(target).catch(() => undefined);
  };
  cleanups.push(async () => {
    context?.off("serviceworker", restarted);
    closing = true;
    catalogGate?.resolve();
    await Promise.allSettled(pumps);
    bridge.server.closeAllConnections();
    await Promise.allSettled([...requests]);
    await new Promise<void>((done) => bridge.server.close(() => done()));
    await rm(home, { recursive: true, force: true });
  });
  await attach(worker);
  context?.on("serviceworker", restarted);
  return {
    attach,
    post,
    home,
    config,
    holdProviderCatalog: () => {
      if (catalogGate) throw new Error("Provider catalog is already held");
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      const held = (catalogGate = { promise, resolve });
      return () => {
        if (catalogGate === held) catalogGate = undefined;
        held.resolve();
      };
    },
    failNextImport: () => {
      rejectImport = true;
    },
    disconnect: () => {
      available = false;
    },
  };
}
