import { browser } from "wxt/browser";

export async function sendSettingsMessage(message: unknown) {
  const reply = await browser.runtime.sendMessage(message);
  if (reply?.ok === false) throw new Error(reply.error ?? "操作失败，请重试");
  return reply;
}
