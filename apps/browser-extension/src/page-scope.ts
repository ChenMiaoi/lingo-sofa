export function pageDocumentPrefix(
  tabId: number,
  url: URL,
  documentId: string | undefined,
): string {
  return `web:${tabId}:${url.origin}:${documentId ?? "document"}:`;
}

/** Distinguish SPA URLs without recording query strings or fragments in usage metadata. */
export async function pageScope(
  tabId: number,
  url: URL,
  documentId: string | undefined,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(url.href),
  );
  const identity = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${pageDocumentPrefix(tabId, url, documentId)}${identity}`;
}
