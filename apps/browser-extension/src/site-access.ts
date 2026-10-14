import { browser, type Browser } from "wxt/browser";

export const readingOrigins = ["https://*/*", "http://*/*"];
const scriptId = "lingo-sofa-reading";
let updates = Promise.resolve();

/** Register the launcher on authorized pages, independently of automatic translation. */
export function syncReadingAccess(): Promise<void> {
  updates = updates
    .catch(() => undefined)
    .then(async () => {
      const granted = await browser.permissions.getAll();
      const matches = [
        ...new Set(
          (granted.origins ?? []).flatMap((pattern) =>
            pattern === "<all_urls>"
              ? readingOrigins
              : /^https?:\/\//.test(pattern)
                ? [pattern]
                : [],
          ),
        ),
      ].sort();
      const scripts = await browser.scripting.getRegisteredContentScripts();
      if (scripts.some((script) => script.id === "lingo-sofa-auto"))
        await browser.scripting.unregisterContentScripts({
          ids: ["lingo-sofa-auto"],
        });
      const installed = scripts.find((script) => script.id === scriptId);
      if (!matches.length) {
        if (installed)
          await browser.scripting.unregisterContentScripts({ ids: [scriptId] });
        return;
      }
      if (installed) {
        if (
          JSON.stringify([...(installed.matches ?? [])].sort()) !==
          JSON.stringify(matches)
        )
          await browser.scripting.updateContentScripts([
            { id: scriptId, matches, js: ["content-scripts/content.js"] },
          ]);
      } else
        await browser.scripting.registerContentScripts([
          {
            id: scriptId,
            matches,
            js: ["content-scripts/content.js"],
            runAt: "document_idle",
            persistAcrossSessions: true,
          },
        ]);
      // Also show the launcher on pages already open when access is granted.
      for (const tab of await browser.tabs.query({})) {
        if (!tab.id || !tab.url || !/^https?:/.test(tab.url)) continue;
        if (
          !(await browser.permissions.contains({
            origins: [`${new URL(tab.url).origin}/*`],
          }))
        )
          continue;
        // WXT invalidates the previous context on reinjection; preserve open controls.
        const existing = await browser.scripting
          .executeScript({
            target: { tabId: tab.id },
            func: () =>
              Boolean(document.querySelector('[data-lingo-sofa="controls"]')),
          })
          .catch(() => []);
        if (existing[0]?.result) continue;
        await browser.scripting
          .executeScript({
            target: { tabId: tab.id },
            files: ["/content-scripts/content.js"],
          })
          .catch(() => undefined);
      }
    });
  return updates;
}

/** Begin in the originating click pipeline; never request already-granted access. */
export function automaticPermission(
  message: unknown,
  sender: Browser.runtime.MessageSender,
): Promise<boolean> | undefined {
  if (
    !message ||
    typeof message !== "object" ||
    !("action" in message) ||
    message.action !== "page-auto" ||
    !("enabled" in message) ||
    message.enabled !== true ||
    sender.id !== browser.runtime.id ||
    !sender.tab ||
    sender.frameId !== 0 ||
    !sender.url ||
    !/^https?:/.test(sender.url)
  )
    return;
  const access = { origins: [`${new URL(sender.url).origin}/*`] };
  return browser.permissions
    .contains(access)
    .then((granted) => granted || browser.permissions.request(access))
    .catch(() => false);
}
