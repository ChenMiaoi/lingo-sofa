import { homedir } from "node:os";
import { RuntimeClient } from "@lingo-sofa/local-runtime";
import {
  AssistantInstaller,
  type AssistantRelease,
} from "@lingo-sofa/local-runtime/installer";
declare const LINGO_SOFA_ASSISTANT_RELEASE: AssistantRelease;
const directory =
  process.env.LINGO_SOFA_HOME ?? `${homedir()}/.config/lingo-sofa`;
let message = "尚未连接本地助手";
let enabled = false;
let pending: Promise<{ ok: boolean; error?: string }> | undefined;
const installer = new AssistantInstaller(
  directory,
  typeof LINGO_SOFA_ASSISTANT_RELEASE === "undefined"
    ? { version: "0.1.0", assets: {} }
    : LINGO_SOFA_ASSISTANT_RELEASE,
  (value) => {
    message = value;
  },
);
export async function installationStatus(event: unknown) {
  void event;
  return { message, busy: Boolean(pending) };
}

// Native IPC exposes only our connection; provider keys and Discord credentials stay private.
const runtime = new RuntimeClient(
  process.env.LINGO_SOFA_HOME ?? `${homedir()}/.config/lingo-sofa`,
  "https://discord.com",
);
export async function start(event: unknown) {
  void event;
  enabled = true;
  pending ??= (async () => {
    try {
      await installer.ensureInstalled();
      if (!enabled) return { ok: false, error: "插件已停用" };
      message = "正在连接本地助手…";
      await runtime.start();
      message = "已连接共享本地助手";
      return { ok: true };
    } catch (error) {
      message =
        error instanceof Error ? error.message : "本地助手安装或启动失败";
      return { ok: false, error: message };
    }
  })().finally(() => {
    pending = undefined;
  });
  return pending;
}
export async function stop(event: unknown) {
  void event;
  enabled = false;
  await runtime.stop();
}
export async function connection(event: unknown) {
  void event;
  if (!enabled || pending) return null;
  try {
    const { port, token } = await runtime.connection();
    return { port, token };
  } catch {
    return null;
  }
}
