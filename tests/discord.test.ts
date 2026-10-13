import { it, expect } from "vitest";
import {
  MessageTranslations,
  type MessageRef,
} from "../apps/discord-vencord/src/controller.js";
import type { Reply, Request } from "@lingo-sofa/protocol";
const wait = () => new Promise((resolve) => setTimeout(resolve, 10));
const message: MessageRef = {
  account: "account",
  channel: "channel",
  id: "one",
  content: "Hello",
};
it("retains translations across virtual unmounts without duplicate requests", async () => {
  let calls = 0;
  const store = new MessageTranslations({
    request: async (_scope, request) => {
      calls++;
      if (request.kind !== "translate") return { ok: true };
      return {
        ok: true,
        results: request.units.map((unit) => ({
          id: unit.id,
          revision: unit.revision,
          text: "你好",
        })),
      };
    },
  });
  const unsubscribe = store.subscribe(message, () => undefined);
  store.translate(message, "中文");
  await wait();
  unsubscribe();
  for (let index = 0; index < 100; index++) {
    const remove = store.subscribe(message, () => undefined);
    store.translate(message, "中文");
    remove();
  }
  expect(store.get(message)?.text).toBe("你好");
  expect(calls).toBe(1);
  expect(store.subscriberCount).toBe(0);
  store.translate({ ...message, channel: "other" }, "中文");
  await wait();
  expect(calls).toBe(2);
});
it("discards edited/deleted message results and cancels remote work", async () => {
  const pending: {
    request: Extract<Request, { kind: "translate" }>;
    resolve: (reply: Reply) => void;
  }[] = [];
  let cancels = 0;
  const store = new MessageTranslations({
    request: async (_scope, request) => {
      if (request.kind === "cancel") {
        cancels++;
        return { ok: true };
      }
      if (request.kind !== "translate") return { ok: true };
      return new Promise<Reply>((resolve) =>
        pending.push({ request, resolve }),
      );
    },
  });
  store.translate(message, "中文");
  await wait();
  const edited = { ...message, content: "Edited" };
  store.translate(edited, "中文");
  await wait();
  pending[0]!.resolve({
    ok: true,
    results: [
      { id: "one", revision: pending[0]!.request.requestId, text: "过期" },
    ],
  });
  pending[1]!.resolve({
    ok: true,
    results: [
      { id: "one", revision: pending[1]!.request.requestId, text: "更新" },
    ],
  });
  await wait();
  expect(store.get(edited)?.text).toBe("更新");
  expect(store.get(message)).toBeUndefined();
  expect(cancels).toBe(1);
  store.remove(edited);
  expect(store.get(edited)).toBeUndefined();
});
