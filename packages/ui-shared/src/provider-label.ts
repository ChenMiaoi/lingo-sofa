import type { ProviderCatalog } from "@lingo-sofa/protocol";

/** Names are derived from the service; only repeated services need an endpoint. */
export function providerConnectionLabel(
  account: ProviderCatalog["accounts"][number],
  catalog: Pick<ProviderCatalog, "accounts" | "providers">,
): string {
  const name =
    catalog.providers.find((item) => item.id === account.model.provider)
      ?.name ??
    (account.model.provider === "openai-compatible"
      ? "自定义 · OpenAI 兼容"
      : account.model.provider);
  const peers = catalog.accounts.filter(
    (item) => item.model.provider === account.model.provider,
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
  return `${name} · ${endpoint}${sameEndpoint.length > 1 ? ` · 连接 ${sameEndpoint.findIndex((item) => item.id === account.id) + 1}` : ""}`;
}
