import {
  commandSuggestions,
  parseCommand,
  unescapeCommandText,
} from "../apps/desktop/src/commands";
import { expect, test } from "bun:test";
import {
  errorMessage,
  initialView,
  shouldSubmitQuestion,
} from "../apps/desktop/src/api";
test("public UI state contains no credentials", () => {
  expect(Object.keys(initialView)).not.toContain("key");
  expect(Object.keys(initialView)).not.toContain("credential");
});
test("IME confirmation, empty questions and busy requests do not submit", () => {
  expect(
    shouldSubmitQuestion(
      { key: "Enter", isComposing: true },
      false,
      "正在输入",
    ),
  ).toBe(false);
  expect(
    shouldSubmitQuestion({ key: "Enter", isComposing: false }, true, "问题"),
  ).toBe(false);
  expect(
    shouldSubmitQuestion({ key: "Enter", isComposing: false }, false, " "),
  ).toBe(false);
  expect(
    shouldSubmitQuestion({ key: "a", isComposing: false }, false, "问题"),
  ).toBe(false);
  expect(
    shouldSubmitQuestion({ key: "Enter", isComposing: false }, false, "问题"),
  ).toBe(true);
});
test("untrusted error details are not rendered", () => {
  expect(errorMessage("provider echoed PRIVATE_TOKEN")).not.toContain(
    "PRIVATE_TOKEN",
  );
  expect(errorMessage("clipboard_unavailable")).toContain("剪贴板");
});

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Desktop } from "../apps/desktop/src/view";
import {
  initialState,
  matchingActions,
  contextLabel,
  type DesktopState,
} from "../apps/desktop/src/api";
const perform = async () => {};
const context = {
  text: "Good design is as little design as possible.",
  origin: "Design notes",
  kind: "selection" as const,
  anchor: { x: 250, y: 300, width: 476, height: 55 },
  anchorValid: true,
};
function render(mode: DesktopState["desktop"]["mode"]) {
  return renderToStaticMarkup(
    React.createElement(Desktop, {
      state: {
        ...initialState,
        desktop: {
          ...initialState.desktop,
          mode,
          context,
          translation: "好的设计，是尽可能少的设计。",
        },
      },
      perform,
    }),
  );
}
test("reading mode contains just the edge entry and translation has no launcher or persistent input", () => {
  const idle = render("idle");
  expect(idle).toContain("翻译选中文字");
  expect(idle).not.toContain("<input");
  expect(idle).not.toContain("<header");
  const translation = render("translation");
  expect(translation).toContain("好的设计");
  expect(translation).toContain("译文操作");
  expect(translation).toContain("Ask");
  expect(translation).not.toContain("<input");
  expect(translation).not.toContain("<header");
  expect(translation).not.toContain("默认翻译语言");
});
test("Ask retains the captured source identity and exposes only explicit actions", () => {
  const ask = render("ask");
  expect(ask).toContain("已选文字");
  expect(ask).toContain("Design notes");
  expect(ask).toContain("解释这段内容");
  expect(ask).toContain("润色这段英文");
  expect(ask).toContain("Esc 返回阅读");
  expect(matchingActions("polish").map((a) => a.id)).toEqual(["polish"]);
  expect(matchingActions("翻译").map((a) => a.id)).toEqual(["translate"]);
  expect(matchingActions("一个自由问题")).toEqual([]);
  expect(contextLabel({ ...context, kind: "clipboard", anchor: null })).toBe(
    "剪贴板",
  );
});

test("Windows entry menu shows active custom bindings and does not claim failed registration", () => {
  const value: DesktopState = {
    ...initialState,
    desktop: { ...initialState.desktop, mode: "menu" },
    shortcuts: {
      ...initialState.shortcuts,
      bindings: {
        input: "Ctrl+Alt+I",
        selection: "Ctrl+Alt+S",
        clipboard: "Ctrl+Alt+T",
      },
      registered: [true, false, true],
    },
  };
  const menu = renderToStaticMarkup(
    React.createElement(Desktop, { state: value, perform }),
  );
  expect(menu).toContain("Ctrl+Alt+I");
  expect(menu).toContain("Ctrl+Alt+T");
  expect(menu).toContain("快捷键未启用");
  expect(menu).not.toContain("Ctrl+Alt+S");
  expect(menu).not.toContain("Alt+Shift+S");
  expect(menu).not.toContain("⌥");
});
test("source text is escaped and never rendered as HTML", () => {
  const state = {
    ...initialState,
    desktop: {
      ...initialState.desktop,
      mode: "translation" as const,
      context,
      translation: "<img src=x onerror=alert(1)>",
    },
  };
  const html = renderToStaticMarkup(
    React.createElement(Desktop, { state, perform }),
  );
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<img src=x");
});

test("an account error is actionable in the lightweight translation overlay", () => {
  const state: DesktopState = {
    ...initialState,
    desktop: {
      ...initialState.desktop,
      mode: "translation",
      context,
      modelRevision: 1,
    },
    model: {
      ...initialState.model,
      revision: 1,
      phase: "error",
      message: "请先设置 DeepSeek API Key。",
    },
  };
  const html = renderToStaticMarkup(
    React.createElement(Desktop, { state, perform }),
  );
  expect(html).toContain("API Key");
  expect(html).toContain("添加账户");
  expect(html).not.toContain("正在翻译");
});

test("macOS shortcut hints use native symbols while Windows keeps existing text", () => {
  const value: DesktopState = {
    ...initialState,
    desktop: { ...initialState.desktop, mode: "menu" },
    shortcuts: {
      ...initialState.shortcuts,
      macos: true,
      bindings: {
        input: "Ctrl+Alt+Shift+Super+I",
        selection: "Alt+Shift+S",
        clipboard: "Super+T",
      },
      registered: [true, true, true],
    },
  };
  const menu = renderToStaticMarkup(
    React.createElement(Desktop, { state: value, perform }),
  );
  expect(menu).toContain("⌃⌥⇧⌘I");
  expect(menu).toContain("⌥⇧S");
  expect(menu).toContain("⌘T");
  const idle = renderToStaticMarkup(
    React.createElement(Desktop, {
      state: { ...value, desktop: { ...value.desktop, mode: "idle" } },
      perform,
    }),
  );
  expect(idle).toContain("⌥⇧S");
  const input = renderToStaticMarkup(
    React.createElement(Desktop, {
      state: { ...value, desktop: { ...value.desktop, mode: "input" } },
      perform,
    }),
  );
  expect(input).toContain("⇧↩ 换行 · ⌥↑↓ 选择");
  const windows = renderToStaticMarkup(
    React.createElement(Desktop, {
      state: {
        ...value,
        shortcuts: {
          ...initialState.shortcuts,
          registered: [true, true, true],
        },
      },
      perform,
    }),
  );
  expect(windows).toContain("Alt+Shift+Space");
  expect(windows).not.toContain("⌥");
  expect(errorMessage("shortcut_invalid_0", true)).toContain(
    "Command、Option 或 Control",
  );
  expect(errorMessage("shortcut_invalid_0", false)).toContain("Ctrl 或 Alt");
});

test("slash commands parse configuration locally and preserve nested model IDs", () => {
  expect(parseCommand("/model openrouter/anthropic/claude-test")).toEqual({
    kind: "model",
    model: { provider: "openrouter", modelId: "anthropic/claude-test" },
  });
  expect(parseCommand("/settings shortcuts")).toEqual({
    kind: "settings",
    page: "shortcuts",
  });
  expect(parseCommand("/model")).toEqual({ kind: "model_picker", search: "" });
  expect(parseCommand("/model Claude Sonnet")).toEqual({
    kind: "model_picker",
    search: "Claude Sonnet",
  });
  expect(parseCommand("/new")).toEqual({ kind: "new" });
  expect(parseCommand("/language en")).toEqual({
    kind: "preferences",
    patch: { target: "English" },
  });
  expect(parseCommand("/pin off")).toEqual({
    kind: "preferences",
    patch: { pinned: false },
  });
  expect(parseCommand("/help")).toEqual({ kind: "help" });
  expect(commandSuggestions("/se").map((entry) => entry.command)).toEqual([
    "/settings",
  ]);
  for (const text of [
    "/model openai/",
    "/model /model",
    "/model openai/model extra",
    "/settings unknown",
    "/pin yes",
    "/new extra",
    "/language constructor",
    "/language __proto__",
    "/language en extra",
    "/unknown private-key",
    "/language en\nordinary text",
  ]) {
    expect(parseCommand(text)?.kind).toBe("invalid");
  }
  expect(parseCommand("Translate /settings literally")).toBeNull();
  expect(parseCommand("//usr/local")).toBeNull();
  expect(unescapeCommandText(" //usr/local")).toBe(" /usr/local");
});
