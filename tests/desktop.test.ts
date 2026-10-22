import {
  commandSuggestions,
  completeCommand,
  parseCommand,
  unescapeCommandText,
} from "../apps/desktop/src/commands";
import { expect, test } from "bun:test";
import {
  errorMessage,
  initialView,
  shouldSubmitQuestion,
  textInputError,
} from "../apps/desktop/src/api";

test("input and followup validation shares UTF-8 boundaries and distinguishes empty from oversized text", () => {
  for (const empty of ["", " \n\t", "\u3000"])
    expect(textInputError(empty)).toBe("invalid_text");
  for (const [character, count] of [
    ["a", 15000],
    ["问", 5000],
    ["🛋", 3750],
  ] as const) {
    expect(textInputError(character.repeat(count))).toBeNull();
    expect(textInputError(character.repeat(count + 1))).toBe("text_too_long");
  }
  expect(textInputError("问".repeat(1500))).toBeNull();
  expect(errorMessage("text_too_long")).toContain("文本或问题过长");
  expect(errorMessage("invalid_text")).toContain("请输入文本或问题");
});
test("public UI state contains no credentials", () => {
  expect(Object.keys(initialView)).not.toContain("key");
  expect(Object.keys(initialView)).not.toContain("credential");
});

test("OCR errors identify platform limits and actionable local resource failures", () => {
  expect(errorMessage("ocr_image_too_large", false)).toContain("400 万");
  expect(errorMessage("ocr_image_too_large", false)).toContain("4096");
  expect(errorMessage("ocr_image_too_large", true)).toContain("1600 万");
  expect(errorMessage("ocr_runtime_unavailable")).toContain("Visual C++");
  expect(errorMessage("ocr_resource_invalid")).toContain("重新安装");
  expect(errorMessage("ocr_model_invalid")).toContain("重新安装");
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
test("macOS selection permission guidance identifies terminal-launched development builds", () => {
  const message = errorMessage("accessibility_permission_required", true);
  expect(message).toContain("设备控制和数据访问");
  expect(message).toContain("旧版称辅助功能");
  expect(message).toContain("Warp");
  expect(message).toContain("安装版允许 LingoSofa");
  expect(
    errorMessage("accessibility_permission_required", false),
  ).not.toContain("Warp");
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
        ...initialState.shortcuts.bindings,
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
      ocr: true,
      bindings: {
        ...initialState.shortcuts.bindings,
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
  expect(parseCommand("/settings updates")).toEqual({
    kind: "settings",
    page: "updates",
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

test("ask commands preserve question content and support multiline input", () => {
  expect(parseCommand("/ask")).toEqual({ kind: "ask", question: "" });
  expect(parseCommand("  /ASK   Explain  this\n  /model literally  ")).toEqual({
    kind: "ask",
    question: "Explain  this\n  /model literally",
  });
  expect(parseCommand("/ask /new")).toEqual({ kind: "ask", question: "/new" });
  expect(parseCommand("//ask question")).toBeNull();
  expect(commandSuggestions("/a").map((entry) => entry.command)).toEqual([
    "/ask",
  ]);
  expect(completeCommand("/a", 0)).toEqual({ text: "/ask ", caret: 5 });
});

test("Tab completion fills the selected command without consuming arguments or escaped content", () => {
  expect(completeCommand("/mo", 0)).toEqual({ text: "/model ", caret: 7 });
  expect(completeCommand("/s", 1)).toEqual({ text: "/shortcuts ", caret: 11 });
  expect(completeCommand("  /MO", 0)).toEqual({ text: "  /model ", caret: 9 });
  expect(completeCommand("/mo deepseek/test", 0, 3)).toEqual({
    text: "/model deepseek/test",
    caret: 7,
  });
  expect(completeCommand("/mo deepseek/test", 0)).toBeNull();
  expect(completeCommand("/model ", 0)).toBeNull();
  expect(completeCommand("//mo", 0)).toBeNull();
  expect(completeCommand("/unknown", 0)).toBeNull();
  expect(completeCommand("/mo\ntext", 0)).toBeNull();
  expect(completeCommand("ordinary text", 0)).toBeNull();
});

test("subscription commands remain local and support the subscribe alias", () => {
  expect(parseCommand("/login")).toEqual({
    kind: "login",
    provider: undefined,
  });
  expect(parseCommand("/subscribe anthropic")).toEqual({
    kind: "login",
    provider: "anthropic",
  });
  expect(parseCommand("/login openai-codex-device")).toEqual({
    kind: "login",
    provider: "openai-codex-device",
  });
  expect(parseCommand("/login bad/provider")?.kind).toBe("invalid");
  expect(parseCommand("/login one two")?.kind).toBe("invalid");
  expect(completeCommand("/lo", 0)).toEqual({ text: "/login ", caret: 7 });
});

test("Ask renders Markdown without executable HTML, external images or active navigation", async () => {
  const { AnswerMarkdown, toolRows, SessionStatus } =
    await import("../apps/desktop/src/ask-answer");
  const html = renderToStaticMarkup(
    React.createElement(AnswerMarkdown, {
      text: "## Summary\n\n**Strong** and `code`.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst markup = '<script>alert(1)</script>';\n```\n\n![secret](https://example.invalid/tracker)\n\n<script>alert(2)</script>\n\n[click](javascript:alert(3))\n\n[Docs](https://example.com/docs)",
    }),
  );
  expect(html).toContain("<h2>Summary</h2>");
  expect(html).toContain("<strong>Strong</strong>");
  expect(html).toContain("<table>");
  expect(html).toContain("&lt;script&gt;");
  for (const unsafe of ["<script>", "<img", "javascript:", "<a "])
    expect(html).not.toContain(unsafe);
  expect(html).toContain("https://example.com/docs");
  const rows = toolRows(
    [
      {
        type: "tool_execution_start",
        id: "read",
        name: "read",
        text: '{"path":"config.ts"}',
      },
      {
        type: "tool_execution_end",
        id: "read",
        name: "read",
        text: "File contents",
        isError: false,
      },
      {
        type: "tool_execution_start",
        id: "bash",
        name: "bash",
        text: '{"command":"test"}',
      },
    ],
    false,
  );
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    status: "done",
    args: '{"path":"config.ts"}',
    result: "File contents",
  });
  expect(rows[1]?.status).toBe("interrupted");
  const tinyCost = renderToStaticMarkup(
    React.createElement(SessionStatus, {
      model: { ...initialState.model, sessionEstimatedCost: 0.000003 },
    }),
  );
  expect(tinyCost).toContain("&lt;$0.0001");
});
