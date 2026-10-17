import { browser } from "wxt/browser";
import {
  themeStyles,
  themeAliases,
  type ColorTheme,
} from "@lingo-sofa/ui-shared";

export function bindAppearance(target: HTMLElement): () => void {
  let active = true;
  let changedSinceRead = false;
  const apply = (value: unknown) => {
    if (active) target.dataset.theme = colorTheme(value);
  };
  apply("system");
  void browser.runtime
    .sendMessage({ action: "appearance" })
    .then((value) => {
      if (!changedSinceRead) apply(value.uiTheme);
    })
    .catch(() => undefined);
  const notified = (message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      "action" in message &&
      message.action === "appearance-changed"
    ) {
      changedSinceRead = true;
      apply((message as { uiTheme?: unknown }).uiTheme);
    }
  };
  browser.runtime.onMessage.addListener(notified);
  const changed = (
    changes: Record<string, { newValue?: unknown }>,
    area: string,
  ) => {
    if (area === "local" && changes.uiTheme) {
      changedSinceRead = true;
      apply(changes.uiTheme.newValue);
    }
  };
  browser.storage.onChanged.addListener(changed);
  return () => {
    active = false;
    browser.storage.onChanged.removeListener(changed);
    browser.runtime.onMessage.removeListener(notified);
  };
}

export function installDocumentAppearance(document: Document) {
  const style = document.createElement("style");
  style.textContent = themeStyles(":root") + `:root{${themeAliases}}`;
  document.head.append(style);
  bindAppearance(document.documentElement);
}
export function colorTheme(value: unknown): ColorTheme {
  return value === "light" || value === "dark" ? value : "system";
}
