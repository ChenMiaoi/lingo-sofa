import { homedir } from "node:os";
import { RuntimeClient } from "@lingo-sofa/local-runtime";

// Native IPC exposes only our connection; provider keys and Discord credentials stay private.
const runtime = new RuntimeClient(
  process.env.LINGO_SOFA_HOME ?? `${homedir()}/.config/lingo-sofa`,
  "https://discord.com",
);
export async function start(event: unknown) {
  void event;
  try {
    await runtime.start();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
export async function stop(event: unknown) {
  void event;
  await runtime.stop();
}
export async function connection(event: unknown) {
  void event;
  try {
    const { port, token } = await runtime.connection();
    return { port, token };
  } catch {
    return null;
  }
}
