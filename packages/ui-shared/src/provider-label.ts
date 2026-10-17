import type { ProviderCatalog } from "@lingo-sofa/protocol";

/** User names and stable IDs keep connections recognizable after credential updates. */
export function providerConnectionLabel(
  account: ProviderCatalog["accounts"][number],
  catalog: Pick<ProviderCatalog, "accounts" | "providers">,
): string {
  const service =
    catalog.providers.find((item) => item.id === account.model.provider)
      ?.name ??
    (account.model.provider === "openai-compatible"
      ? "自定义 · OpenAI 兼容"
      : account.model.provider);
  const displayName = (item: typeof account) =>
    item.name && item.name !== item.model.provider && item.name !== service
      ? item.name
      : service;
  const name = displayName(account);
  const peers = catalog.accounts.filter(
    (item) =>
      item.model.provider === account.model.provider &&
      displayName(item) === name,
  );
  if (peers.length < 2) return name;
  let endpoint = account.model.endpoint;
  try {
    endpoint = new URL(endpoint).host;
  } catch {
    /* Keep invalid legacy endpoints identifiable. */
  }
  const sameEndpoint = peers.filter(
    (item) => item.model.endpoint === account.model.endpoint,
  );
  return `${name} · ${endpoint}${sameEndpoint.length > 1 ? ` · ${account.id.slice(-8)}` : ""}`;
}
