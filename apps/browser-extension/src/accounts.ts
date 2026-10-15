import { browser } from "wxt/browser";
import {
  accountStateSchema,
  accountKey,
  planAccountUpdate,
  type AccountState,
} from "@lingo-sofa/provider-pi/accounts";
import {
  settingsSchema,
  type ModelConfig,
  type ProviderUpdate,
  type Settings,
} from "@lingo-sofa/protocol";

export async function directAccounts(
  settings: Settings,
): Promise<AccountState> {
  const saved = await browser.storage.local.get("providerAccounts");
  if (saved.providerAccounts)
    return accountStateSchema.parse(saved.providerAccounts);
  const legacy = await browser.storage.session.get("apiKey");
  const initialModel = ["deepseek", "openai-compatible"].includes(
    settings.model.provider,
  )
    ? settings.model
    : settingsSchema.parse({}).model;
  const initial: AccountState = {
    accounts: [],
    translation: initialModel,
    ask: settings.askModel ?? initialModel,
  };
  const state =
    typeof legacy.apiKey === "string" && legacy.apiKey
      ? planAccountUpdate(
          initial,
          { model: initialModel, apiKey: legacy.apiKey },
          () => crypto.randomUUID(),
        )
      : initial;
  await browser.storage.local.set({ providerAccounts: state });
  await browser.storage.session.remove("apiKey");
  return state;
}
let writes: Promise<unknown> = Promise.resolve();
export function updateDirectAccounts(
  settings: Settings,
  update: ProviderUpdate,
  allowUnconfigured = false,
) {
  const operation = writes.then(async () => {
    const state = planAccountUpdate(
      await directAccounts(settings),
      update,
      () => crypto.randomUUID(),
    );
    if (
      !allowUnconfigured &&
      update.target !== "remove-account" &&
      update.model.authMode !== "subscription" &&
      !accountKey(
        state,
        update.target === "ask-default"
          ? state.ask
          : update.target === "account"
            ? update.newAccount || update.apiKey
              ? state.accounts.at(-1)!.model
              : update.model
            : state.translation,
      )
    )
      throw new Error("请先添加此供应商");
    await browser.storage.local.set({ providerAccounts: state });
    return state;
  });
  writes = operation.catch(() => undefined);
  return operation;
}
export async function directKey(settings: Settings, model: ModelConfig) {
  return accountKey(await directAccounts(settings), model);
}
