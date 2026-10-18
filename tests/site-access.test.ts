import { beforeEach, expect, it, vi } from "vitest";
import type { Browser } from "wxt/browser";
const fake = vi.hoisted(() => ({
  origins: [] as string[],
  scripts: [] as { id: string; matches?: string[]; js?: string[] }[],
  contains: vi.fn<(permission: { origins: string[] }) => Promise<boolean>>(
    async () => false,
  ),
  request: vi.fn<(permission: { origins: string[] }) => Promise<boolean>>(
    async () => true,
  ),
  execute: vi.fn<(injection: unknown) => Promise<unknown[]>>(async () => []),
  send: vi.fn(),
}));
vi.mock("wxt/browser", () => ({
  browser: {
    runtime: { id: "fixture-extension" },
    permissions: {
      getAll: async () => ({ origins: fake.origins }),
      contains: fake.contains,
      request: fake.request,
    },
    tabs: {
      sendMessage: fake.send,
      query: async () => [
        { id: 1, url: "https://one.test/article" },
        { id: 2, url: "https://two.test/article" },
        { id: 3, url: "chrome://extensions" },
      ],
    },
    scripting: {
      getRegisteredContentScripts: async () => fake.scripts,
      unregisterContentScripts: async ({ ids }: { ids: string[] }) => {
        fake.scripts = fake.scripts.filter(
          (script) => !ids.includes(script.id),
        );
      },
      registerContentScripts: async (scripts: typeof fake.scripts) => {
        fake.scripts.push(...scripts);
      },
      updateContentScripts: async (scripts: typeof fake.scripts) => {
        for (const next of scripts)
          Object.assign(
            fake.scripts.find((script) => script.id === next.id)!,
            next,
          );
      },
      executeScript: fake.execute,
    },
  },
}));
import {
  automaticPermission,
  syncReadingAccess,
} from "../apps/browser-extension/src/site-access.js";
beforeEach(() => {
  fake.origins = [];
  fake.scripts = [];
  fake.execute.mockReset();
  fake.execute.mockResolvedValue([]);
  fake.send.mockReset();
  fake.send.mockRejectedValue(new Error("Receiving end does not exist"));
  fake.request.mockClear();
  fake.request.mockResolvedValue(true);
  fake.contains.mockImplementation(async (permission) =>
    fake.origins.includes(permission.origins[0]!),
  );
});
it("migrates automatic-only injection to a persistent launcher on authorized sites", async () => {
  fake.origins = ["https://one.test/*"];
  fake.scripts = [{ id: "lingo-sofa-auto", matches: ["https://one.test/*"] }];
  await syncReadingAccess();
  expect(fake.scripts).toEqual([
    expect.objectContaining({
      id: "lingo-sofa-reading",
      matches: ["https://one.test/*"],
      persistAcrossSessions: true,
    }),
  ]);
  expect(fake.execute.mock.calls[0]).toEqual([
    { target: { tabId: 1 }, files: ["/content-scripts/content.js"] },
  ]);
  fake.send.mockResolvedValue({ documentToken: "live-reader" });
  await syncReadingAccess();
  expect(fake.scripts).toHaveLength(1);
  expect(fake.execute).toHaveBeenCalledTimes(1);
  expect(fake.send).toHaveBeenCalledWith(
    1,
    { action: "context-token" },
    { frameId: 0 },
  );
  expect(fake.request).not.toHaveBeenCalled();
});
it("updates and removes launchers after permission changes without enabling automatic translation", async () => {
  fake.origins = ["https://one.test/*", "http://two.test/*"];
  await syncReadingAccess();
  fake.origins = ["https://one.test/*"];
  await syncReadingAccess();
  expect(fake.scripts[0]!.matches).toEqual(["https://one.test/*"]);
  fake.origins = [];
  await syncReadingAccess();
  expect(fake.scripts).toEqual([]);
});
it("requests missing automatic access in the click pipeline and rejects foreign messages", async () => {
  const sender = {
    id: "fixture-extension",
    frameId: 0,
    tab: { id: 1 },
    url: "https://one.test/article",
  } as Browser.runtime.MessageSender;
  const request = automaticPermission(
    { action: "page-auto", enabled: true },
    sender,
  );
  expect(fake.contains).toHaveBeenCalledWith({
    origins: ["https://one.test/*"],
  });
  expect(await request).toBe(true);
  expect(fake.request).toHaveBeenCalledWith({
    origins: ["https://one.test/*"],
  });
  const withoutTab = { ...sender };
  delete withoutTab.tab;
  for (const invalid of [
    { ...sender, frameId: 1 },
    { ...sender, id: "foreign" },
    { ...sender, url: "chrome://extensions" },
    withoutTab,
  ])
    expect(
      automaticPermission({ action: "page-auto", enabled: true }, invalid),
    ).toBeUndefined();
  expect(
    automaticPermission({ action: "page-auto", enabled: false }, sender),
  ).toBeUndefined();
  expect(fake.request).toHaveBeenCalledTimes(1);
  fake.request.mockRejectedValue(new Error("denied"));
  expect(
    await automaticPermission({ action: "page-auto", enabled: true }, sender),
  ).toBe(false);
});

it("does not repeat a permission request when the launcher already has site access", async () => {
  fake.origins = ["https://one.test/*"];
  expect(
    await automaticPermission({ action: "page-auto", enabled: true }, {
      id: "fixture-extension",
      frameId: 0,
      tab: { id: 1 },
      url: "https://one.test/article",
    } as Browser.runtime.MessageSender),
  ).toBe(true);
  expect(fake.request).not.toHaveBeenCalled();
});

it("preserves existing controls when newly granted access changes script matches", async () => {
  fake.origins = ["https://one.test/*"];
  fake.send.mockResolvedValueOnce({ documentToken: "live-reader" });
  await syncReadingAccess();
  expect(fake.execute).not.toHaveBeenCalled();
});

it("replaces orphaned controls when no current reader answers the liveness probe", async () => {
  fake.origins = ["https://one.test/*"];
  fake.send.mockResolvedValue({ documentToken: undefined });
  // DOM left by an old installation is not evidence of a working connection.
  fake.execute.mockResolvedValue([{ result: true }]);
  await syncReadingAccess();
  expect(fake.execute).toHaveBeenCalledExactlyOnceWith({
    target: { tabId: 1 },
    files: ["/content-scripts/content.js"],
  });
  expect(fake.request).not.toHaveBeenCalled();
});
