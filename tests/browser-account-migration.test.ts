import { expect, it, vi } from "vitest";
import { accountStateSchema, settingsSchema } from "@lingo-sofa/protocol";

const fixture = vi.hoisted(() => {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const area = (store: Record<string, unknown>) => ({
    get: async (keys: string | string[]) =>
      Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).map((key) => [key, store[key]]),
      ),
    set: async (values: Record<string, unknown>) => {
      Object.assign(store, values);
    },
    remove: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    },
  });
  return {
    local,
    session,
    storage: { local: area(local), session: area(session) },
  };
});
vi.mock("wxt/browser", () => ({ browser: { storage: fixture.storage } }));
import {
  pendingAccountImport,
  finishAccountImport,
} from "../apps/browser-extension/src/accounts.js";

it("preserves legacy credentials and the migration identity across interruptions, then removes keys only after acknowledgement", async () => {
  const settings = settingsSchema.parse({ mode: "direct" });
  fixture.session.apiKey = "session-only-key";
  const first = await pendingAccountImport(settings);
  expect(first?.state.accounts[0]?.apiKey).toBe("session-only-key");
  expect(
    accountStateSchema.parse(fixture.local.providerAccounts).accounts[0]
      ?.apiKey,
  ).toBe("session-only-key");
  expect(await pendingAccountImport(settings)).toEqual(first);
  await expect(finishAccountImport(crypto.randomUUID())).rejects.toThrow(
    "待迁移账户已变更",
  );
  expect(await pendingAccountImport(settings)).toEqual(first);
  const clear = vi
    .spyOn(fixture.storage.session, "remove")
    .mockRejectedValueOnce(Error("Storage unavailable"));
  await expect(finishAccountImport(first!.migrationId)).rejects.toThrow(
    "Storage unavailable",
  );
  expect(await pendingAccountImport(settings)).toEqual(first);
  clear.mockRestore();
  await finishAccountImport(first!.migrationId);
  expect(fixture.session.apiKey).toBeUndefined();
  expect(fixture.local.providerAccounts).toBeUndefined();
  expect(fixture.local.accountMigrationId).toBeUndefined();
  expect(await pendingAccountImport(settings)).toBeNull();
});
