import { it, expect } from "vitest";
import {
  MessageTranslations,
  messageContextMatches,
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
it("binds selected questions to their original message, account and channel", () => {
  const selected = { ...message, content: "ell", sourceContent: "Hello" };
  expect(messageContextMatches(selected, message)).toBe(true);
  for (const current of [
    { ...message, content: "Updated" },
    { ...message, account: "another" },
    { ...message, channel: "another" },
    { ...message, content: undefined },
  ])
    expect(messageContextMatches(selected, current)).toBe(false);
  expect(selected.content).toBe("ell");
});
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
it("waits for sent messages and keeps translations through metadata-only updates", async () => {
  let calls = 0;
  const store = new MessageTranslations({
    request: async (_scope, request) => {
      if (request.kind !== "translate") return { ok: true };
      calls++;
      return {
        ok: true,
        results: request.units.map((unit) => ({
          id: unit.id,
          revision: unit.revision,
          text: "译文",
        })),
      };
    },
  });
  store.translate(
    { ...message, id: "temporary", deliveryState: "SENDING" },
    "中文",
    true,
  );
  await wait();
  expect(calls).toBe(0);
  store.translate({ ...message, deliveryState: "SENT" }, "中文", true);
  await wait();
  store.update({
    account: message.account,
    channel: message.channel,
    id: message.id,
  });
  store.update(message);
  store.translate(message, "中文", true);
  await wait();
  expect(calls).toBe(1);
  expect(store.get(message)?.text).toBe("译文");
  store.update({ ...message, content: "Edited" });
  expect(store.get(message)).toBeUndefined();
  store.clear();
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

it("pauses only one channel, retains completed translations, and restores original-only views without new requests", async () => {
  const scope = "discord:account:channel";
  let calls = 0;
  let cancels = 0;
  const pending: {
    request: Extract<Request, { kind: "translate" }>;
    resolve: (reply: Reply) => void;
  }[] = [];
  const store = new MessageTranslations({
    request: async (_scope, request) => {
      if (request.kind === "cancel") {
        cancels++;
        return { ok: true };
      }
      if (request.kind !== "translate") return { ok: true };
      calls++;
      return new Promise<Reply>((resolve) =>
        pending.push({ request, resolve }),
      );
    },
  });
  let changes = 0;
  const unsubscribe = store.subscribeScope(scope, () => {
    changes++;
  });
  store.translate(message, "中文", true);
  await wait();
  pending[0]!.resolve({
    ok: true,
    results: [
      {
        id: message.id,
        revision: pending[0]!.request.requestId,
        text: "已完成",
      },
    ],
  });
  await wait();
  store.translate({ ...message, id: "two" }, "中文", true);
  store.translate({ ...message, channel: "other", id: "three" }, "中文", true);
  await wait();
  store.setOriginalOnly(scope, true);
  expect(store.isOriginalOnly(scope)).toBe(true);
  expect(store.get(message)?.text).toBe("已完成");
  expect(cancels).toBe(1);
  store.translate({ ...message, id: "four" }, "中文", true);
  expect(calls).toBe(3);
  pending[1]!.resolve({
    ok: true,
    results: [
      { id: "two", revision: pending[1]!.request.requestId, text: "过期" },
    ],
  });
  pending[2]!.resolve({
    ok: true,
    results: [
      {
        id: "three",
        revision: pending[2]!.request.requestId,
        text: "另一个频道",
      },
    ],
  });
  await wait();
  expect(store.get({ ...message, id: "two" })).toBeUndefined();
  expect(store.get({ ...message, channel: "other", id: "three" })?.text).toBe(
    "另一个频道",
  );
  store.setOriginalOnly(scope, false);
  store.translate(message, "中文");
  expect(calls).toBe(3);
  expect(changes).toBeGreaterThan(0);
  const beforeUnsubscribe = changes;
  unsubscribe();
  store.setOriginalOnly(scope, true);
  expect(changes).toBe(beforeUnsubscribe);
  store.clear();
});

it("translates message prose without sending fenced code blocks and skips code-only messages", async () => {
  const captured: Extract<Request, { kind: "translate" }>[] = [];
  const store = new MessageTranslations({
    request: async (_scope, request) => {
      if (request.kind !== "translate") return { ok: true };
      captured.push(request);
      return {
        ok: true,
        results: request.units.map((unit) => ({
          id: unit.id,
          revision: unit.revision,
          text: "译文",
        })),
      };
    },
  });
  store.translate(
    {
      ...message,
      content:
        "Keep the fix.\n```cpp\n#pragma clang optimize on\n```\nReview `fetch()`.",
    },
    "中文",
  );
  await wait();
  expect(captured[0]!.units[0]!.text).toBe(
    "Keep the fix.\n\nReview `fetch()`.",
  );
  expect(captured[0]!.units[0]!.text).not.toContain("#pragma");
  store.translate(
    { ...message, id: "code", content: "```js\nconst key = 'private';\n```" },
    "中文",
  );
  await wait();
  store.translate(
    { ...message, id: "inline-code", content: "``fetch(`x`)``" },
    "中文",
  );
  store.translate(
    { ...message, id: "tilde-code", content: "~~~~js\nprivateKey();\n~~~~" },
    "中文",
  );
  store.translate(
    {
      ...message,
      id: "tilde-prose",
      content: "Review this.\n~~~js\nprivateKey();\n~~~\nThanks.",
    },
    "中文",
  );
  await wait();
  expect(captured).toHaveLength(2);
  expect(captured[1]!.units[0]!.text).toBe("Review this.\n\nThanks.");
  store.clear();
});

it("replaces translations when the language changes and discards late results from the previous language", async () => {
  const pending: {
    request: Extract<Request, { kind: "translate" }>;
    resolve: (reply: Reply) => void;
  }[] = [];
  const store = new MessageTranslations({
    request: async (_scope, request) => {
      if (request.kind !== "translate") return { ok: true };
      return new Promise<Reply>((resolve) =>
        pending.push({ request, resolve }),
      );
    },
  });
  store.translate(message, "简体中文", true);
  await wait();
  store.pause("discord:account:channel");
  store.translate(message, "日本語", true);
  await wait();
  const finish = (index: number, text: string) =>
    pending[index]!.resolve({
      ok: true,
      results: [
        {
          id: message.id,
          revision: pending[index]!.request.units[0]!.revision,
          text,
        },
      ],
    });
  finish(1, "こんにちは");
  await wait();
  finish(0, "你好");
  await wait();
  expect(store.get(message)?.language).toBe("日本語");
  expect(store.get(message)?.text).toBe("こんにちは");
  expect(
    pending.map(({ request }) => request.units[0]?.targetLanguage),
  ).toEqual(["简体中文", "日本語"]);
  store.clear();
});
it("cancels active work and blocks manual and automatic requests while reading is off", async () => {
  const calls: Request[] = [];
  let resolve!: (reply: Reply) => void;
  const store = new MessageTranslations({
    request: async (_scope, request) => {
      calls.push(request);
      if (request.kind === "cancel") return { ok: true };
      return new Promise<Reply>((done) => {
        resolve = done;
      });
    },
  });
  store.translate(message, "中文");
  await wait();
  store.setEnabled(false);
  store.translate(message, "中文");
  store.translate(message, "中文", true);
  expect(calls.map((call) => call.kind)).toEqual(["translate", "cancel"]);
  expect(store.get(message)).toBeUndefined();
  resolve({
    ok: true,
    results: [{ id: "one", revision: "stale", text: "迟到结果" }],
  });
  await wait();
  expect(store.get(message)).toBeUndefined();
  store.setEnabled(true);
  store.translate(message, "中文");
  await wait();
  expect(calls.map((call) => call.kind)).toEqual([
    "translate",
    "cancel",
    "translate",
  ]);
  store.setEnabled(false);
  resolve({ ok: false, error: "cancelled" });
});
