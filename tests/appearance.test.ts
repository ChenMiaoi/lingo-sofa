// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  resolve: undefined as ((value: { uiTheme: string }) => void) | undefined,
  notifications: new Set<(message: unknown) => void>(),
  changes: new Set<
    (changes: Record<string, { newValue: string }>, area: string) => void
  >(),
}));
vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      sendMessage: () =>
        new Promise((resolve) => {
          fake.resolve = resolve;
        }),
      onMessage: {
        addListener: (listener: (message: unknown) => void) =>
          fake.notifications.add(listener),
        removeListener: (listener: (message: unknown) => void) =>
          fake.notifications.delete(listener),
      },
    },
    storage: {
      onChanged: {
        addListener: (
          listener: (
            changes: Record<string, { newValue: string }>,
            area: string,
          ) => void,
        ) => fake.changes.add(listener),
        removeListener: (
          listener: (
            changes: Record<string, { newValue: string }>,
            area: string,
          ) => void,
        ) => fake.changes.delete(listener),
      },
    },
  },
}));
import { bindAppearance } from "../apps/browser-extension/src/appearance.js";
beforeEach(() => {
  fake.notifications.clear();
  fake.changes.clear();
});
it.each(["notification", "storage"])(
  "retains the latest theme when a delayed startup snapshot arrives after a %s",
  async (source) => {
    const target = document.createElement("div");
    const stop = bindAppearance(target);
    try {
      if (source === "notification")
        for (const notify of fake.notifications)
          notify({ action: "appearance-changed", uiTheme: "light" });
      else
        for (const notify of fake.changes)
          notify({ uiTheme: { newValue: "light" } }, "local");
      expect(target.dataset.theme).toBe("light");
      fake.resolve!({ uiTheme: "dark" });
      await Promise.resolve();
      expect(target.dataset.theme).toBe("light");
    } finally {
      stop();
    }
  },
);
