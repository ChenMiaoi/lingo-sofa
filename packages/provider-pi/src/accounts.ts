import {
  accountMatches,
  accountStateSchema,
  type AccountState,
  type ModelConfig,
  type ProviderUpdate,
} from "@lingo-sofa/protocol";
export { accountStateSchema, type AccountState } from "@lingo-sofa/protocol";

export function planAccountUpdate(
  state: AccountState,
  update: ProviderUpdate,
  newId: () => string,
): AccountState {
  const next = structuredClone(state);
  if (update.target === "translation-engine") {
    next.translationEngine = update.engine;
    return accountStateSchema.parse(next);
  }
  let model = { ...update.model };
  if (update.target === "remove-account") {
    if (!model.accountId) throw new Error("Choose an account to remove");
    if (
      [next.translation, next.ask].some(
        (item) =>
          (item.accountId ??
            next.accounts.find((account) => accountMatches(account, item))
              ?.id) === model.accountId,
      )
    )
      throw new Error(
        "Choose another default account before removing this account",
      );
    next.accounts = next.accounts.filter((item) => item.id !== model.accountId);
    return next;
  }
  let account =
    !update.newAccount &&
    (model.accountId
      ? next.accounts.find((item) => item.id === model.accountId)
      : next.accounts.find((item) => accountMatches(item, model)));
  if (update.apiKey && account && !accountMatches(account, model)) {
    account = undefined;
    model.accountId = undefined;
  }
  if (
    model.accountId &&
    !update.newAccount &&
    (!account || !accountMatches(account, model))
  )
    throw new Error(
      "Account does not match the selected provider and endpoint",
    );
  if (update.apiKey || model.authMode === "subscription") {
    const id = account ? account.id : newId();
    const saved = {
      id,
      name: update.accountName ?? (account ? account.name : model.provider),
      model: { ...model, accountId: id },
      ...(update.apiKey
        ? { apiKey: update.apiKey }
        : account && account.apiKey
          ? { apiKey: account.apiKey }
          : {}),
    };
    if (account)
      next.accounts = next.accounts.map((item) =>
        item.id === id ? saved : item,
      );
    else next.accounts.push(saved);
    model = saved.model;
  } else if (account) {
    model.accountId = account.id;
    if (update.accountName) account.name = update.accountName;
    if (update.target === "account") account.model = model;
  }
  if (next.accounts.length > 100) throw new Error("Account limit reached");
  if (update.target === "ask-default") next.ask = model;
  else if (!update.target || update.target === "translation") {
    next.translation = model;
    next.translationEngine = "llm";
  }
  return accountStateSchema.parse(next);
}
export function accountKey(state: AccountState, model: ModelConfig): string {
  const account = model.accountId
    ? state.accounts.find((item) => item.id === model.accountId)
    : state.accounts.find((item) => accountMatches(item, model));
  if (model.accountId && (!account || !accountMatches(account, model)))
    throw new Error(
      "Account does not match the selected provider and endpoint",
    );
  return account?.apiKey ?? "";
}
