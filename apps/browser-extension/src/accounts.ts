import { browser } from "wxt/browser";
import {
  accountStateSchema,
  planAccountUpdate,
} from "@lingo-sofa/provider-pi/accounts";
import type { AccountImport, Settings } from "@lingo-sofa/protocol";

/** Old browser credentials are read only until the assistant acknowledges their migration. */
export async function pendingAccountImport(
  settings: Settings,
): Promise<AccountImport | null> {
  const saved = await browser.storage.local.get([
    "providerAccounts",
    "accountMigrationId",
  ]);
  let state = saved.providerAccounts
    ? accountStateSchema.parse(saved.providerAccounts)
    : undefined;
  if (!state) {
    const legacy = await browser.storage.session.get("apiKey");
    if (typeof legacy.apiKey !== "string" || !legacy.apiKey) return null;
    state = planAccountUpdate(
      {
        accounts: [],
        translation: settings.model,
        ask: settings.askModel ?? settings.model,
      },
      { model: settings.model, apiKey: legacy.apiKey },
      () => crypto.randomUUID(),
    );
    await browser.storage.local.set({ providerAccounts: state });
  }
  if (!state.accounts.some((account) => account.apiKey)) return null;
  const migrationId =
    typeof saved.accountMigrationId === "string"
      ? saved.accountMigrationId
      : crypto.randomUUID();
  await browser.storage.local.set({ accountMigrationId: migrationId });
  const { completedImports: _receipts, ...source } = state;
  void _receipts;
  return { migrationId, state: source };
}

export async function finishAccountImport(migrationId: string) {
  const saved = await browser.storage.local.get("accountMigrationId");
  if (saved.accountMigrationId !== migrationId)
    throw new Error("浏览器待迁移账户已变更，请重新读取后迁移");
  await browser.storage.session.remove(["apiKey", "balance"]);
  await browser.storage.local.remove([
    "providerAccounts",
    "accountMigrationId",
  ]);
}
