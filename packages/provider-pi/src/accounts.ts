import {
  accountMatches,
  accountStateSchema,
  type AccountState,
  type ModelConfig,
  type ProviderUpdate,
  type AccountImport,
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

/** A receipt and the imported defaults commit together, so a lost reply cannot replay a migration. */
export function planAccountImport(
  state: AccountState,
  migration: AccountImport,
  newId: () => string,
): AccountState {
  if (state.completedImports?.includes(migration.migrationId)) return state;
  if ((state.completedImports?.length ?? 0) >= 100)
    throw new Error("Account migration limit reached");
  const next = structuredClone(state);
  const ids = new Map<string, string>();
  for (const incoming of migration.state.accounts) {
    if (ids.has(incoming.id)) throw new Error("Duplicate browser account ID");
    if (incoming.model.authMode === "subscription" || !incoming.apiKey)
      throw new Error("Browser migration requires an API Key account");
    const same = next.accounts.find(
      (account) =>
        accountMatches(account, incoming.model) &&
        account.apiKey === incoming.apiKey,
    );
    const id = same?.id ?? newId();
    ids.set(incoming.id, id);
    if (!same)
      next.accounts.push({
        ...incoming,
        id,
        model: { ...incoming.model, accountId: id },
      });
  }
  function importedModel(model: ModelConfig) {
    const source = model.accountId
      ? migration.state.accounts.find(
          (account) => account.id === model.accountId,
        )
      : migration.state.accounts.find((account) =>
          accountMatches(account, model),
        );
    if (!source && !model.accountId) return undefined;
    if (!source || !accountMatches(source, model) || !ids.has(source.id))
      throw new Error("Browser default does not match an imported account");
    return { ...model, accountId: ids.get(source.id)! };
  }
  next.translation =
    importedModel(migration.state.translation) ?? next.translation;
  next.ask =
    importedModel(migration.state.ask) ??
    (accountKey(next, next.ask) ? next.ask : next.translation);
  next.translationEngine = migration.state.translationEngine ?? "llm";
  next.completedImports = [
    ...(next.completedImports ?? []),
    migration.migrationId,
  ];
  return accountStateSchema.parse(next);
}
