import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { Desktop, type Perform } from "../apps/desktop/src/view";
import { App } from "../apps/desktop/src/app";
import {
  saveReading,
  useReadingPosition,
} from "../apps/desktop/src/reading-position";
import { findAnswerMatches } from "../apps/desktop/src/answer-search";
import { codeTokens } from "../apps/desktop/src/highlighted-code";
import { canDragWindow } from "../apps/desktop/src/window-drag";
import {
  initialState,
  type DesktopState,
  type ModelCatalog,
  type RequestLogin,
  type LoadSessions,
  type LoadActivity,
} from "../apps/desktop/src/api";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  IS_REACT_ACT_ENVIRONMENT: true,
});
test("window dragging accepts title descendants but excludes controls and source text", () => {
  const title = document.createElement("header");
  title.innerHTML =
    "<span>Title</span><button><svg><path /></svg></button><textarea></textarea><section data-no-drag><p>Source</p></section>";
  expect(canDragWindow(title.querySelector("span"), 0)).toBe(true);
  expect(canDragWindow(title.querySelector("span"), 2)).toBe(false);
  for (const selector of ["path", "textarea", "p"])
    expect(canDragWindow(title.querySelector(selector), 0)).toBe(false);
});
const { createRoot } = await import("react-dom/client");
const context = {
  text: "The project code is MAPLE-731.",
  origin: "Acceptance document",
  kind: "selection" as const,
  anchor: { x: 10, y: 20, width: 300, height: 30 },
  anchorValid: true,
};
function state(
  mode: "ask" | "ask-result" | "input" | "settings",
  revision = 1,
): DesktopState {
  return {
    ...initialState,
    desktop: {
      ...initialState.desktop,
      mode,
      modelRevision: revision,
      context,
    },
    model: { ...initialState.model, revision, keyConfigured: true },
  };
}
const catalog = async (provider?: string): Promise<ModelCatalog> => ({
  providers: provider
    ? []
    : [
        { id: "deepseek", name: "DeepSeek", supported: true, modelCount: 1 },
        { id: "openai", name: "OpenAI", supported: true, modelCount: 1 },
        {
          id: "oauth-only",
          name: "OAuth only",
          supported: false,
          modelCount: 0,
        },
      ],
  supported: true,
  total: provider ? 1 : 0,
  models: provider
    ? [
        {
          id: provider === "openai" ? "test-openai" : "deepseek-flash",
          name: "Test model",
          contextWindow: 8192,
        },
      ]
    : [],
});
async function mount(
  initial: DesktopState,
  loadCatalog: (
    provider?: string,
    offset?: number,
  ) => Promise<ModelCatalog> = catalog,
  onPerform?: Perform,
  requestLogin?: RequestLogin,
  loadSessions?: LoadSessions,
  loadActivity?: LoadActivity,
) {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const perform = async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return onPerform?.(command, args);
  };
  const render = async (value: DesktopState) => {
    await act(async () =>
      root.render(
        React.createElement(Desktop, {
          state: value,
          perform,
          loadModelCatalog: loadCatalog,
          requestLogin,
          loadSessions,
          loadActivity,
        }),
      ),
    );
  };
  await render(initial);
  return {
    element,
    calls,
    render,
    async close() {
      await act(async () => root.unmount());
      element.remove();
    },
    async select(value: string, selector: string) {
      const select = element.querySelector<HTMLSelectElement>(selector)!;
      expect(select.closest("[hidden]")).toBeNull();
      await act(async () => {
        select.value = value;
        select.dispatchEvent(
          new dom.Event("change", { bubbles: true }) as unknown as Event,
        );
      });
    },
    async click(label: string) {
      const button = [
        ...element.querySelectorAll<HTMLButtonElement>("button"),
      ].find(
        (button) =>
          !button.closest("[hidden]") &&
          (button.getAttribute("aria-label") === label ||
            button.textContent?.trim() === label),
      );
      expect(button).toBeDefined();
      await act(async () => button!.click());
    },
    async type(value: string, selector = "input, textarea") {
      const input = element.querySelector(selector)!;
      expect(input.closest("[hidden]")).toBeNull();
      const setter = Object.getOwnPropertyDescriptor(
        input.tagName === "TEXTAREA"
          ? dom.HTMLTextAreaElement.prototype
          : dom.HTMLInputElement.prototype,
        "value",
      )!.set!;
      await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(
          new dom.Event("input", { bubbles: true }) as unknown as Event,
        );
      });
    },
    async key(
      key: string,
      isComposing = false,
      modifiers: {
        shiftKey?: boolean;
        altKey?: boolean;
        keyCode?: number;
      } = {},
    ) {
      const input =
        [...element.querySelectorAll("input, textarea")].find(
          (element) => !element.closest("[hidden]"),
        ) ?? document.activeElement!;
      await act(async () =>
        input.dispatchEvent(
          new dom.KeyboardEvent("keydown", {
            key,
            isComposing,
            bubbles: true,
            ...modifiers,
          }) as unknown as Event,
        ),
      );
    },
  };
}

test("accepted Ask clears the sent question, preserves a streaming follow-up draft, and empty Enter never resends", async () => {
  const ui = await mount(state("ask"));
  try {
    await ui.type("What is the project code?");
    await ui.key("Enter");
    expect(ui.calls).toEqual([
      {
        command: "ask_question",
        args: { question: "What is the project code?" },
      },
    ]);
    const answer = state("ask-result", 2);
    await ui.render(answer);
    expect(
      ui.element.querySelector<HTMLTextAreaElement>("textarea")!.value,
    ).toBe("");
    expect(
      ui.element.querySelector<HTMLTextAreaElement>("textarea")!.placeholder,
    ).toBe("继续追问，或 / 打开命令");
    await ui.key("Enter");
    expect(ui.calls).toHaveLength(1);
    await ui.type("Keep this follow-up draft.");
    await ui.render({
      ...answer,
      model: { ...answer.model, phase: "running", output: "MAPLE" },
    });
    expect(
      ui.element.querySelector<HTMLTextAreaElement>("textarea")!.value,
    ).toBe("Keep this follow-up draft.");
    await ui.render(state("ask-result", 3));
    expect(
      ui.element.querySelector<HTMLTextAreaElement>("textarea")!.value,
    ).toBe("");
  } finally {
    await ui.close();
  }
});

test("complete translation reading retains the frozen text after Ask and opens without another model request", async () => {
  const value = state("ask-result");
  value.desktop.mode = "translation";
  value.desktop.operation = "ask";
  value.desktop.translation =
    "这是一段完整译文。\n".repeat(80) + "末尾：译文没有丢失。";
  value.model.output = "A later Ask answer must not replace the translation.";
  const ui = await mount(value);
  try {
    expect(
      ui.element.querySelector('[aria-label="译文"]')!.textContent,
    ).toContain("末尾：译文没有丢失。");
    await ui.click("完整译文");
    expect(ui.calls).toEqual([
      { command: "set_mode", args: { mode: "translation-detail" } },
    ]);
    await ui.render({
      ...value,
      desktop: { ...value.desktop, mode: "translation-detail" },
    });
    const reading =
      ui.element.querySelector<HTMLElement>('[aria-label="译文"]')!;
    expect(reading.textContent).toContain("末尾：译文没有丢失。");
    expect(reading.textContent).not.toContain(value.model.output);
    expect(document.activeElement).toBe(reading);
    expect(ui.element.querySelector("input, textarea")).toBeNull();
    await ui.click("复制");
    await ui.key("Escape");
    expect(ui.calls.slice(1)).toEqual([
      { command: "copy_result", args: undefined },
      { command: "back_reading", args: undefined },
    ]);
  } finally {
    await ui.close();
  }
});

test("OCR translation keeps its source hint and actions while complete text remains available", async () => {
  const value = state("ask-result");
  value.desktop.mode = "translation";
  value.desktop.context = { ...context, kind: "ocr" };
  value.desktop.translation = "OCR 识别结果的译文。\n".repeat(80) + "OCR_END";
  const ui = await mount(value);
  try {
    expect(ui.element.querySelector(".origin-hint")?.textContent).toContain(
      "截图识别",
    );
    expect(
      ui.element.querySelector('[aria-label="译文"]')?.textContent,
    ).toContain("OCR_END");
    await ui.click("复制");
    await ui.click("Ask");
    await ui.key("Escape");
    expect(ui.calls).toEqual([
      { command: "copy_result", args: undefined },
      { command: "set_mode", args: { mode: "ask" } },
      { command: "collapse", args: undefined },
    ]);
  } finally {
    await ui.close();
  }
});

test("a failed result copy preserves the translation and reports its error in the reading controls", async () => {
  const value = state("ask-result");
  value.desktop.mode = "translation";
  value.desktop.operation = "translate";
  value.desktop.translation = "TRANSLATION_SENTINEL";
  value.model.phase = "ready";
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const invoke = <T>(command: string): Promise<T> =>
    command === "copy_result"
      ? Promise.reject("clipboard_write_failed")
      : Promise.resolve((command === "desktop_state" ? value : undefined) as T);
  try {
    await act(async () => root.render(React.createElement(App, { invoke })));
    const copy = [
      ...element.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "复制")!;
    await act(async () => {
      copy.click();
      await Promise.resolve();
    });
    expect(element.querySelector('[aria-label="译文"]')?.textContent).toBe(
      "TRANSLATION_SENTINEL",
    );
    expect(element.querySelector(".reading-controls")?.textContent).toContain(
      "复制失败，请稍后重试。",
    );
    expect(copy.disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

test("a reading notice remains the primary failure when no translation exists", async () => {
  const value = state("ask-result");
  value.desktop.mode = "translation";
  value.desktop.operation = "translate";
  value.desktop.translation = "";
  value.desktop.notice = "selection_unavailable";
  value.model.phase = "error";
  const ui = await mount(value);
  try {
    expect(
      ui.element.querySelector('[aria-label="译文"]')?.textContent,
    ).toContain("未能定位选区");
    const copy = [
      ...ui.element.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "复制")!;
    expect(copy.disabled).toBe(true);
  } finally {
    await ui.close();
  }
});

test("failed Ask does not mark the retained translation as failed and translation errors still do", async () => {
  for (const mode of ["translation", "translation-detail"] as const) {
    const value = state("ask-result");
    value.desktop.mode = mode;
    value.desktop.operation = "ask";
    value.desktop.translation = "RETAINED_TRANSLATION";
    value.model.phase = "error";
    value.model.message = "LATER_ASK_FAILED";
    const ui = await mount(value);
    try {
      expect(ui.element.querySelector('[aria-label="译文"]')?.textContent).toBe(
        "RETAINED_TRANSLATION",
      );
      expect(ui.element.querySelector(".reading.has-error")).toBeNull();
      expect(ui.element.querySelector(".reading-status")).toBeNull();
      await ui.render({
        ...value,
        desktop: { ...value.desktop, operation: "translate" },
      });
      expect(ui.element.querySelector(".reading.has-error")).not.toBeNull();
      expect(
        ui.element.querySelector(".reading-status")?.textContent,
      ).toContain("LATER_ASK_FAILED");
    } finally {
      await ui.close();
    }
  }
});

test("reading distinguishes an in-progress translation from a failed partial response", async () => {
  const value = state("ask-result");
  value.desktop.mode = "translation";
  value.desktop.operation = "translate";
  value.desktop.translation = "尚未完成的译文";
  value.model.phase = "running";
  const ui = await mount(value);
  try {
    expect(ui.element.textContent).toContain("译文仍在生成");
    await ui.render({
      ...value,
      model: {
        ...value.model,
        phase: "error",
        message: "请求过于频繁，请稍后重试。",
      },
    });
    expect(ui.element.textContent).toContain("请求过于频繁，请稍后重试。");
    expect(ui.element.textContent).toContain("尚未完成的译文");
    await ui.render({ ...value, model: { ...value.model, phase: "ready" } });
    expect(ui.element.textContent).not.toContain("译文仍在生成");
    expect(ui.element.textContent).not.toContain("翻译未完成");
  } finally {
    await ui.close();
  }
});

test("shortcut drafts survive polling, save explicitly, and defaults do not apply until saved", async () => {
  const value = state("settings");
  value.shortcuts = { ...value.shortcuts, registered: [true, true, true] };
  const ui = await mount(value);
  try {
    await ui.click("快捷键");
    await ui.type("Ctrl+Alt+I", "#shortcut-input");
    await ui.render({ ...value, shortcuts: { ...value.shortcuts } });
    expect(
      ui.element.querySelector<HTMLInputElement>("#shortcut-input")!.value,
    ).toBe("Ctrl+Alt+I");
    expect(ui.calls).toHaveLength(0);
    expect(ui.element.querySelector(".shortcut-row")!.textContent).toContain(
      "待保存",
    );
    const save = [
      ...ui.element.querySelectorAll<HTMLButtonElement>("button"),
    ].find((b) => b.textContent === "保存快捷键")!;
    await act(async () => save.click());
    expect(ui.calls).toEqual([
      {
        command: "save_shortcuts",
        args: {
          bindings: { ...value.shortcuts.bindings, input: "Ctrl+Alt+I" },
        },
      },
    ]);
    const saved = {
      ...value,
      shortcuts: {
        ...value.shortcuts,
        revision: 1,
        bindings: { ...value.shortcuts.bindings, input: "Ctrl+Alt+I" },
        message: "快捷键已保存并生效。",
      },
    };
    await ui.render(saved);
    expect(ui.element.textContent).toContain("快捷键已保存并生效");
    const restore = [
      ...ui.element.querySelectorAll<HTMLButtonElement>("button"),
    ].find((b) => b.textContent === "恢复默认")!;
    await act(async () => restore.click());
    expect(
      ui.element.querySelector<HTMLInputElement>("#shortcut-input")!.value,
    ).toBe("Alt+Shift+Space");
    expect(ui.calls).toHaveLength(1);
    expect(ui.element.textContent).toContain("修改尚未保存");
  } finally {
    await ui.close();
  }
});

test("manual input shares the Ask launcher without exposing or submitting an old reading", async () => {
  const ui = await mount(state("input"));
  try {
    expect(ui.element.querySelector(".launcher")).not.toBeNull();
    expect(ui.element.textContent).not.toContain(context.text);
    expect(ui.element.textContent).not.toContain(context.origin);
    expect(ui.calls).toHaveLength(0);
    await ui.type("A new paragraph.\nKeep this second line.");
    await ui.key("Enter", true);
    await ui.key("Enter", false, { shiftKey: true });
    expect(ui.calls).toHaveLength(0);
    await ui.key("Enter");
    expect(ui.calls).toEqual([
      {
        command: "translate_text",
        args: { text: "A new paragraph.\nKeep this second line." },
      },
    ]);
  } finally {
    await ui.close();
  }
});

test("manual questions explicitly use a fresh question entry and disable empty or busy submissions", async () => {
  const value = state("input");
  const ui = await mount(value);
  try {
    expect(
      [...ui.element.querySelectorAll<HTMLButtonElement>(".action")].every(
        (b) => b.disabled,
      ),
    ).toBe(true);
    await ui.key("Enter");
    expect(ui.calls).toHaveLength(0);
    await ui.type("A completely independent question?");
    await ui.key("ArrowDown", false, { altKey: true });
    await ui.key("Enter");
    expect(ui.calls).toEqual([
      {
        command: "ask_text",
        args: { text: "A completely independent question?" },
      },
    ]);
    await ui.render({
      ...value,
      model: { ...value.model, phase: "preparing" },
    });
    await ui.key("Enter");
    expect(ui.calls).toHaveLength(1);
    await ui.key("Escape");
    expect(ui.calls.at(-1)?.command).toBe("back_reading");
  } finally {
    await ui.close();
  }
});

test("IME processing keys never submit, change actions or close the shared panel", async () => {
  for (const mode of ["input", "ask", "ask-result"] as const) {
    const ui = await mount(state(mode));
    try {
      await ui.type("中文输入验收");
      await ui.key("Enter", false, { keyCode: 229 });
      await ui.key("Escape", false, { keyCode: 229 });
      await ui.key("ArrowDown", false, { altKey: true, keyCode: 229 });
      expect(ui.calls).toHaveLength(0);
      if (mode !== "ask-result")
        expect(
          ui.element.querySelector(".action.selected")!.textContent,
        ).toContain(mode === "input" ? "翻译这段文字" : "围绕原文提问");
      await ui.key("Enter");
      expect(ui.calls).toHaveLength(1);
      expect(ui.calls[0]?.command).toBe(
        mode === "input" ? "translate_text" : "ask_question",
      );
    } finally {
      await ui.close();
    }
  }
});

test("Ask arrow selection, IME Enter and Esc use the actual mounted handlers", async () => {
  const ui = await mount(state("ask"));
  try {
    await ui.key("ArrowDown");
    expect(ui.element.querySelector(".action.selected")!.textContent).toContain(
      "翻译成中文",
    );
    await ui.key("Enter", true);
    expect(ui.calls).toHaveLength(0);
    await ui.key("Enter");
    expect(ui.calls[0]?.args?.question).toContain("翻译成简体中文");
    await ui.key("Escape");
    expect(ui.calls.at(-1)?.command).toBe("back_reading");
  } finally {
    await ui.close();
  }
});

test("Ask keeps the frozen selected source visible after its live anchor expires", async () => {
  const value = state("ask");
  const ui = await mount(value);
  try {
    const chip = ui.element.querySelector(".context-chip")!;
    await act(async () => (chip as HTMLElement).click());
    expect(ui.element.querySelector(".source-peek")!.textContent).toBe(
      context.text,
    );
    await ui.render({
      ...value,
      desktop: {
        ...value.desktop,
        context: { ...context, anchorValid: false },
      },
    });
    expect(ui.element.querySelector(".source-peek")!.textContent).toBe(
      context.text,
    );
    expect(ui.calls).toHaveLength(0);
  } finally {
    await ui.close();
  }
});

test("macOS settings edit Command and Option, preview symbols, save and restore existing defaults", async () => {
  const value = state("settings");
  value.shortcuts = {
    ...value.shortcuts,
    macos: true,
    ocr: true,
    registered: [true, true, true],
    bindings: { ...value.shortcuts.bindings, input: "Alt+Super+I" },
  };
  const ui = await mount(value);
  try {
    await ui.click("快捷键");
    expect(
      ui.element.querySelector<HTMLInputElement>("#shortcut-input")!.value,
    ).toBe("Option+Command+I");
    expect(
      ui.element.querySelector("#shortcut-preview-input")!.textContent,
    ).toBe("⌥⌘I");
    expect(ui.element.querySelector(".shortcut-row")!.textContent).toContain(
      "已启用",
    );
    expect(ui.element.querySelector("#shortcut-help")!.textContent).toContain(
      "Command/Cmd/Meta/Super",
    );
    await ui.type("Command+Option+Q", "#shortcut-input");
    await ui.render({ ...value, shortcuts: { ...value.shortcuts } });
    expect(
      ui.element.querySelector("#shortcut-preview-input")!.textContent,
    ).toBe("⌘⌥Q");
    const buttons = [
      ...ui.element.querySelectorAll<HTMLButtonElement>("button"),
    ];
    await act(async () =>
      buttons.find((b) => b.textContent === "保存快捷键")!.click(),
    );
    expect(ui.calls).toEqual([
      {
        command: "save_shortcuts",
        args: {
          bindings: {
            input: "Command+Option+Q",
            selection: "Option+Shift+S",
            clipboard: "Option+Shift+T",
            selectionAlternate: "Ctrl+Option+Shift+S",
            ocr: "Option+Shift+O",
            ocrAlternate: "Ctrl+Option+Shift+O",
          },
        },
      },
    ]);
    await ui.render({
      ...value,
      shortcuts: {
        ...value.shortcuts,
        revision: 1,
        bindings: { ...value.shortcuts.bindings, input: "Alt+Super+Q" },
      },
    });
    expect(
      ui.element.querySelector<HTMLInputElement>("#shortcut-input")!.value,
    ).toBe("Option+Command+Q");
    await act(async () =>
      ui.element.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
        if (b.textContent === "恢复默认") b.click();
      }),
    );
    expect(
      ui.element.querySelector<HTMLInputElement>("#shortcut-input")!.value,
    ).toBe("Option+Shift+Space");
    expect(
      ui.element.querySelector("#shortcut-preview-input")!.textContent,
    ).toBe("⌥⇧Space");
    expect(ui.calls).toHaveLength(1);
    await ui.render({ ...value, desktop: { ...value.desktop, mode: "input" } });
    await ui.type("Translate this.");
    await ui.key("ArrowDown", false, { altKey: true });
    await ui.key("Enter");
    expect(ui.calls.at(-1)).toEqual({
      command: "ask_text",
      args: { text: "Translate this." },
    });
  } finally {
    await ui.close();
  }
});

test("settings returns to input, Ask and follow-up drafts without submitting or losing focus", async () => {
  for (const mode of ["input", "ask", "ask-result"] as const) {
    const value = state(mode);
    const ui = await mount(value);
    try {
      await ui.type("Keep my unsent draft.\n第二行");
      if (mode === "input") await ui.key("ArrowDown", false, { altKey: true });
      await act(async () =>
        ui.element
          .querySelector<HTMLButtonElement>('[aria-label="设置"]')!
          .click(),
      );
      expect(ui.calls).toEqual([
        { command: "set_mode", args: { mode: "settings" } },
      ]);
      const settings = {
        ...value,
        desktop: { ...value.desktop, mode: "settings" as const },
      };
      await ui.render(settings);
      expect(
        ui.element.querySelector(".launcher.settings-launcher"),
      ).not.toBeNull();
      expect(
        ui.element.querySelector("#api-key")!.closest("[hidden]"),
      ).not.toBeNull();
      await ui.click("模型与服务商");
      expect(
        ui.element.querySelector("#api-key")!.closest("[hidden]"),
      ).toBeNull();
      expect(ui.element.querySelector(".panel")).toBeNull();
      await ui.type("UNSAVED_SECRET", "#api-key");
      // Polling and a model settings update must not erase the suspended draft.
      await ui.render({
        ...settings,
        model: {
          ...settings.model,
          settings: { ...settings.model.settings, target: "English" },
        },
      });
      if (mode === "input") {
        await ui.click("返回设置");
        expect(ui.calls).toHaveLength(1);
        await ui.click("返回导航窗口");
      } else {
        await ui.key("Escape");
        expect(ui.calls).toHaveLength(1);
        await ui.key("Escape");
      }
      expect(ui.calls.at(-1)).toEqual({
        command: "back_reading",
        args: undefined,
      });
      await ui.render(value);
      const input = ui.element.querySelector<
        HTMLInputElement | HTMLTextAreaElement
      >("input, textarea")!;
      expect(input.value).toBe("Keep my unsent draft.\n第二行");
      expect(document.activeElement).toBe(input);
      if (mode === "input") {
        expect(
          ui.element.querySelector(".action.selected")!.textContent,
        ).toContain("作为新问题提问");
        await ui.key("Enter");
        expect(ui.calls.at(-1)?.command).toBe("ask_text");
      } else {
        expect(ui.calls).toHaveLength(2);
      }
      await ui.render(settings);
      await ui.click("模型与服务商");
      expect(
        ui.element.querySelector<HTMLInputElement>("#api-key")!.value,
      ).toBe("");
    } finally {
      await ui.close();
    }
  }
});

test("returning from settings after a new reading clears the previous draft", async () => {
  const value = state("input");
  const ui = await mount(value);
  try {
    await ui.type("An old draft");
    await ui.render({
      ...value,
      desktop: { ...value.desktop, mode: "settings" },
    });
    await ui.render({
      ...value,
      desktop: { ...value.desktop, epoch: value.desktop.epoch + 1 },
    });
    expect(
      ui.element.querySelector<HTMLTextAreaElement>("textarea")!.value,
    ).toBe("");
  } finally {
    await ui.close();
  }
});

test("settings categories navigate independently and preserve shortcut edits across subpages", async () => {
  const value = state("settings");
  const ui = await mount(value);
  try {
    expect(
      ui.element
        .querySelector('[aria-label="设置分类"]')!
        .hasAttribute("hidden"),
    ).toBe(false);
    expect(
      ui.element.querySelector(".settings-form")!.hasAttribute("hidden"),
    ).toBe(true);
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "模型与服务商",
    );
    expect(
      ui.element.querySelector(
        '[aria-label="模型与服务商"] .setting-current-value',
      )!.textContent,
    ).toBe("deepseek / deepseek-flash");
    expect(
      ui.element.querySelector(
        '[aria-label="翻译偏好"] .setting-current-value',
      )!.textContent,
    ).toBe("简体中文");
    expect(
      ui.element.querySelector('[aria-label="快捷键"] .setting-current-value')!
        .textContent,
    ).toBe("0/4 已启用");
    await ui.click("快捷键");
    expect(
      ui.element.querySelector("#api-key")!.closest("[hidden]"),
    ).not.toBeNull();
    expect(
      ui.element.querySelector("#target")!.closest("[hidden]"),
    ).not.toBeNull();
    await ui.type("Ctrl+Alt+Q", "#shortcut-input");
    await ui.key("Escape", true);
    expect(ui.element.querySelector('[aria-label="返回设置"]')).not.toBeNull();
    await ui.key("Escape");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("快捷键");
    const keyButton = document.activeElement!;
    await act(async () =>
      keyButton.dispatchEvent(
        new dom.KeyboardEvent("keydown", {
          key: "ArrowUp",
          bubbles: true,
        }) as unknown as Event,
      ),
    );
    expect(document.activeElement?.getAttribute("aria-label")).toBe("翻译偏好");
    await ui.click("翻译偏好");
    expect(ui.element.querySelector("#target")!.closest("[hidden]")).toBeNull();
    expect(
      ui.element.querySelector("#shortcut-input")!.closest("[hidden]"),
    ).not.toBeNull();
    await ui.click("返回设置");
    await ui.click("快捷键");
    await ui.render({ ...value, shortcuts: { ...value.shortcuts } });
    expect(
      ui.element.querySelector<HTMLInputElement>("#shortcut-input")!.value,
    ).toBe("Ctrl+Alt+Q");
    expect(ui.calls).toHaveLength(0);
    await ui.click("保存快捷键");
    expect(ui.calls).toEqual([
      {
        command: "save_shortcuts",
        args: {
          bindings: { ...value.shortcuts.bindings, input: "Ctrl+Alt+Q" },
        },
      },
    ]);
  } finally {
    await ui.close();
  }
});

test("models settings manage separate provider credentials and apply a default without exposing stored keys", async () => {
  const value = state("settings");
  value.model = { ...value.model, configuredProviders: ["deepseek"] };
  const ui = await mount(value);
  try {
    await ui.click("模型与服务商");
    expect(
      ui.element.querySelector(".default-model-summary")!.textContent,
    ).toContain("deepseek-flash");
    expect(
      ui.element.querySelector<HTMLSelectElement>("#provider")!.value,
    ).toBe("deepseek");
    expect(ui.element.querySelector<HTMLInputElement>("#api-key")!.value).toBe(
      "",
    );
    expect(
      ui.element.querySelector<HTMLOptionElement>('option[value="oauth-only"]')!
        .disabled,
    ).toBe(true);
    await ui.select("openai", "#provider");
    await ui.type("synthetic-openai-key", "#api-key");
    await ui.click("保存凭证");
    expect(ui.calls.at(-1)).toEqual({
      command: "save_provider",
      args: { provider: "openai", key: "synthetic-openai-key" },
    });
    expect(ui.element.querySelector<HTMLInputElement>("#api-key")!.value).toBe(
      "",
    );
    const configured = {
      ...value,
      model: { ...value.model, configuredProviders: ["deepseek", "openai"] },
    };
    await ui.render(configured);
    await ui.select("test-openai", "#default-model");
    await ui.click("设为默认模型");
    expect(ui.calls.at(-1)).toEqual({
      command: "select_model",
      args: { model: { provider: "openai", modelId: "test-openai" } },
    });
    expect(
      ui.element.querySelector(".default-model-summary")!.textContent,
    ).toContain("deepseek-flash");
    await ui.render({
      ...configured,
      model: {
        ...configured.model,
        defaultModel: { provider: "openai", modelId: "test-openai" },
      },
    });
    expect(
      ui.element.querySelector(".default-model-summary")!.textContent,
    ).toContain("openai / test-openai");
    await ui.type("do-not-reuse-this-key", "#api-key");
    await ui.select("deepseek", "#provider");
    expect(ui.element.querySelector<HTMLInputElement>("#api-key")!.value).toBe(
      "",
    );
    await ui.click("移除该服务商凭证");
    expect(ui.calls.at(-1)).toEqual({
      command: "save_provider",
      args: { provider: "deepseek", key: "" },
    });
  } finally {
    await ui.close();
  }
});

test("late catalog responses never replace another provider's models", async () => {
  const deepseek = Promise.withResolvers<ModelCatalog>();
  const openai = Promise.withResolvers<ModelCatalog>();
  const ui = await mount(state("settings"), async (provider) =>
    provider === "deepseek"
      ? deepseek.promise
      : provider === "openai"
        ? openai.promise
        : catalog(),
  );
  try {
    await ui.click("模型与服务商");
    await ui.select("openai", "#provider");
    await act(async () => openai.resolve(await catalog("openai")));
    await act(async () => deepseek.resolve(await catalog("deepseek")));
    const options = [
      ...ui.element.querySelectorAll<HTMLOptionElement>(
        "#default-model option",
      ),
    ].map((option) => option.value);
    expect(options).toContain("test-openai");
    expect(options).not.toContain("deepseek-flash");
  } finally {
    await ui.close();
  }
});

test("slash configuration commands execute locally in input, Ask and streaming follow-ups", async () => {
  for (const mode of ["input", "ask", "ask-result"] as const) {
    const value = state(mode);
    value.model = {
      ...value.model,
      phase: "running",
      output: "A streaming answer",
    };
    const ui = await mount(value);
    try {
      await ui.type("/unknown synthetic-secret");
      await ui.key("Enter");
      expect(ui.calls).toHaveLength(0);
      expect(ui.element.textContent).toContain("未找到应用命令");
      await ui.type("/language en");
      await ui.key("Enter", true);
      await ui.key("Enter", false, { keyCode: 229 });
      await ui.key("Enter", false, { shiftKey: true });
      expect(ui.calls).toHaveLength(0);
      await ui.key("Enter");
      expect(ui.calls.at(-1)).toEqual({
        command: "patch_settings",
        args: { patch: { target: "English" } },
      });
      await ui.type("/model openrouter/anthropic/test-model");
      await ui.key("Enter");
      expect(ui.calls.at(-1)).toEqual({
        command: "select_model",
        args: {
          model: { provider: "openrouter", modelId: "anthropic/test-model" },
        },
      });
      await ui.type("/pin off");
      await ui.key("Enter");
      expect(ui.calls.at(-1)).toEqual({
        command: "patch_settings",
        args: { patch: { pinned: false } },
      });
      const calls = ui.calls.length;
      await ui.key("Escape");
      expect(ui.calls).toHaveLength(calls);
      expect(
        ui.element.querySelector<HTMLInputElement | HTMLTextAreaElement>(
          "input, textarea",
        )!.value,
      ).toBe("");
      expect(
        ui.calls.every(
          (call) =>
            ![
              "translate_text",
              "ask_text",
              "ask_question",
              "cancel_task",
            ].includes(call.command),
        ),
      ).toBe(true);
    } finally {
      await ui.close();
    }
  }
});

test("slash navigation opens the requested settings subpage and returns through the same launcher", async () => {
  for (const [command, selector] of [
    ["/settings shortcuts", "#shortcut-input"],
    ["/settings models", "#provider"],
    ["/language", "#target"],
  ]) {
    const value = state("input");
    const ui = await mount(value);
    try {
      await ui.type(command!);
      await ui.key("Enter");
      expect(ui.calls).toEqual([
        { command: "set_mode", args: { mode: "settings" } },
      ]);
      await ui.render({
        ...value,
        desktop: { ...value.desktop, mode: "settings" },
      });
      expect(
        ui.element.querySelector(selector!)!.closest("[hidden]"),
      ).toBeNull();
      await ui.key("Escape");
      expect(ui.calls).toHaveLength(1);
      await ui.key("Escape");
      expect(ui.calls.at(-1)?.command).toBe("back_reading");
      await ui.render(value);
      expect(
        ui.element.querySelector<HTMLTextAreaElement>("textarea")!.value,
      ).toBe("");
      expect(document.activeElement).toBe(ui.element.querySelector("textarea"));
    } finally {
      await ui.close();
    }
  }
});

test("command suggestions complete prefixes and escaped slash text follows normal submission", async () => {
  const value = state("input");
  const ui = await mount(value);
  try {
    await ui.type("/");
    expect(ui.element.querySelector('[aria-label="应用命令"]')).not.toBeNull();
    expect(
      ui.element.querySelectorAll('[aria-label="应用命令"] .action'),
    ).toHaveLength(12);
    await ui.key("ArrowDown");
    expect(ui.element.querySelector(".action.selected")!.textContent).toContain(
      "/model",
    );
    await ui.type("/set");
    await ui.key("Enter");
    expect(ui.calls.at(-1)).toEqual({
      command: "set_mode",
      args: { mode: "settings" },
    });
    await ui.type("/pin not-on-or-off");
    const count = ui.calls.length;
    await ui.key("Enter");
    expect(ui.calls).toHaveLength(count);
    expect(ui.element.textContent).toContain("命令格式");
    await ui.type("//usr/local");
    await ui.key("Enter");
    expect(ui.calls.at(-1)).toEqual({
      command: "translate_text",
      args: { text: "/usr/local" },
    });
  } finally {
    await ui.close();
  }
});

test("pending configuration commands do not apply twice or report a failed save as success", async () => {
  const result = Promise.withResolvers<boolean>();
  const ui = await mount(state("input"), catalog, () => result.promise);
  try {
    await ui.type("/pin off");
    await ui.key("Enter");
    await ui.key("Enter");
    expect(ui.calls).toHaveLength(1);
    await act(async () => result.resolve(false));
    expect(ui.element.textContent).not.toContain("设置已保存");
    await ui.type("/unknown");
    await ui.key("Enter");
    expect(ui.element.textContent).toContain("未找到应用命令");
    expect(ui.calls).toHaveLength(1);
  } finally {
    await ui.close();
  }
});

test("/model switches inline using only search, arrows and Enter in every launcher", async () => {
  for (const mode of ["input", "ask", "ask-result"] as const) {
    const value = state(mode);
    value.model.configuredProviders = ["deepseek", "openai"];
    const ui = await mount(value);
    try {
      await ui.type("/model");
      await ui.key("Enter");
      expect(ui.calls).toHaveLength(0);
      expect(
        ui.element.querySelector('[aria-label="选择模型"]'),
      ).not.toBeNull();
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        "搜索模型",
      );
      expect(ui.element.querySelectorAll(".action")).toHaveLength(2);
      await ui.key("ArrowDown");
      expect(
        ui.element.querySelector(".action.selected")?.textContent,
      ).toContain("openai/test-openai");
      await ui.type("OpenAI TEST");
      expect(ui.element.querySelectorAll(".action")).toHaveLength(1);
      await ui.key("Enter", true);
      await ui.key("Enter", false, { shiftKey: true });
      expect(ui.calls).toHaveLength(0);
      await ui.key("Enter");
      expect(ui.calls).toEqual([
        {
          command: "select_model",
          args: { model: { provider: "openai", modelId: "test-openai" } },
        },
      ]);
      expect(ui.element.querySelector('[aria-label="选择模型"]')).toBeNull();
      expect(
        (ui.element.querySelector("textarea, input") as HTMLInputElement).value,
      ).toBe("");
    } finally {
      await ui.close();
    }
  }
});

test("model search loads all catalog pages and Escape restores the command without cancelling the session", async () => {
  const offsets: number[] = [];
  const value = state("input");
  value.model.configuredProviders = ["openai"];
  const ui = await mount(value, async (provider, offset = 0) => {
    offsets.push(offset);
    return {
      providers: [],
      supported: true,
      total: 2,
      models: [
        {
          id: offset ? "last-page" : "first-page",
          name: offset ? "Last model" : "First model",
          contextWindow: 8192,
        },
      ],
    };
  });
  try {
    await ui.type("/model last");
    await ui.key("Enter");
    expect(offsets).toEqual([0, 1]);
    expect(ui.element.querySelectorAll(".action")).toHaveLength(1);
    expect(ui.element.textContent).toContain("openai/last-page");
    await ui.key("Escape", true);
    expect(ui.element.querySelector('[aria-label="选择模型"]')).not.toBeNull();
    await ui.key("Escape");
    expect(ui.calls).toHaveLength(0);
    expect(
      ui.element.querySelector<HTMLTextAreaElement>("textarea")?.value,
    ).toBe("/model last");
    expect(document.activeElement).toBe(ui.element.querySelector("textarea"));
  } finally {
    await ui.close();
  }
});

test("model picker handles no matches, failed saves and duplicate Enter", async () => {
  const value = state("input");
  value.model.configuredProviders = ["openai"];
  const result = Promise.withResolvers<boolean>();
  const ui = await mount(value, catalog, () => result.promise);
  try {
    await ui.type("/model");
    await ui.key("Enter");
    await ui.type("absent-model");
    await ui.key("Enter");
    expect(ui.calls).toHaveLength(0);
    expect(ui.element.textContent).toContain("没有匹配的模型");
    await ui.type("");
    await ui.key("Enter");
    await ui.key("Enter");
    expect(ui.calls).toHaveLength(1);
    await act(async () => result.resolve(false));
    expect(ui.element.textContent).toContain("原默认模型已保留");
    expect(ui.element.querySelector('[aria-label="选择模型"]')).not.toBeNull();
  } finally {
    await ui.close();
  }
});

test("/new resets from input or a streaming answer and clears drafts when the new epoch arrives", async () => {
  for (const mode of ["input", "ask", "ask-result"] as const) {
    const value = state(mode);
    value.model.phase = "running";
    const ui = await mount(value);
    try {
      await ui.type("/new");
      await ui.key("Enter");
      expect(ui.calls).toEqual([{ command: "new_session", args: undefined }]);
      await ui.render({
        ...value,
        desktop: {
          ...value.desktop,
          mode: "input",
          epoch: value.desktop.epoch + 1,
          context: null,
          translation: "",
        },
        model: {
          ...value.model,
          phase: "ready",
          output: "",
          sessionReady: false,
        },
      });
      expect(
        ui.element.querySelector<HTMLTextAreaElement>("textarea")?.value,
      ).toBe("");
      expect(ui.element.textContent).not.toContain(context.text);
      expect(document.activeElement).toBe(ui.element.querySelector("textarea"));
      await ui.type("a fresh question");
      await ui.key("ArrowDown", false, { altKey: true });
      await ui.key("Enter");
      expect(ui.calls.at(-1)).toEqual({
        command: "ask_text",
        args: { text: "a fresh question" },
      });
    } finally {
      await ui.close();
    }
  }
});

test("confirming the current model leaves the running session intact", async () => {
  const value = state("ask-result");
  value.model.phase = "running";
  value.model.configuredProviders = ["deepseek"];
  const ui = await mount(value);
  try {
    await ui.type("/model");
    await ui.key("Enter");
    await ui.key("Enter");
    expect(ui.calls).toHaveLength(0);
    expect(ui.element.querySelector('[aria-label="选择模型"]')).toBeNull();
    expect(
      ui.element.querySelector<HTMLInputElement>("input, textarea")?.value,
    ).toBe("");
  } finally {
    await ui.close();
  }
});

test("/model without credentials stays inline through provider, model and password entry using only the keyboard", async () => {
  for (const mode of ["input", "ask", "ask-result"] as const) {
    const value = state(mode);
    value.model.keyConfigured = false;
    const ui = await mount(value);
    try {
      await ui.type("/model");
      await ui.key("Enter");
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        "搜索服务商",
      );
      expect(ui.element.textContent).not.toContain("OAuth only");
      await ui.key("ArrowDown");
      expect(
        ui.element.querySelector(".action.selected")?.textContent,
      ).toContain("OpenAI");
      await ui.key("Enter");
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        "搜索模型",
      );
      expect(ui.element.textContent).toContain("openai/test-openai");
      await ui.key("Enter");
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        "服务商 API Key",
      );
      expect(
        ui.element.querySelector("#provider, #api-key, #default-model"),
      ).toBeNull();
      await ui.key("Enter");
      expect(ui.calls).toHaveLength(0);
      await ui.type("synthetic-picker-key");
      expect(ui.element.querySelector<HTMLInputElement>("input")?.type).toBe(
        "password",
      );
      await ui.key("Enter", true);
      expect(ui.calls).toHaveLength(0);
      await ui.key("Enter");
      expect(ui.calls).toEqual([
        {
          command: "save_provider",
          args: { provider: "openai", key: "synthetic-picker-key" },
        },
        {
          command: "select_model",
          args: { model: { provider: "openai", modelId: "test-openai" } },
        },
      ]);
      expect(ui.element.querySelector(".model-picker")).toBeNull();
      expect(ui.element.textContent).not.toContain("synthetic-picker-key");
    } finally {
      await ui.close();
    }
  }
});

test("failed inline credential save never switches and Escape discards its password without opening settings", async () => {
  const ui = await mount(state("input"), catalog, async () => false);
  try {
    await ui.type("/model");
    await ui.key("Enter");
    await ui.type("openai");
    await ui.key("Enter");
    await ui.key("Enter");
    await ui.type("synthetic-rejected-key");
    await ui.key("Enter");
    expect(ui.calls.map((call) => call.command)).toEqual(["save_provider"]);
    expect(ui.element.textContent).toContain("凭证保存失败");
    await ui.key("Escape");
    expect(ui.element.querySelector('input[type="password"]')).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("搜索模型");
    await ui.key("Escape");
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "搜索服务商",
    );
    await ui.key("Escape");
    expect(
      ui.element.querySelector<HTMLTextAreaElement>("textarea")?.value,
    ).toBe("/model");
    expect(ui.calls.some((call) => call.command === "set_mode")).toBe(false);
  } finally {
    await ui.close();
  }
});

test("Tab completes commands in input, Ask and running follow-ups without executing or losing focus", async () => {
  for (const mode of ["input", "ask", "ask-result"] as const) {
    const value = state(mode);
    value.model.phase = "running";
    value.model.configuredProviders = ["deepseek"];
    const ui = await mount(value);
    const field = () =>
      ui.element.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        "input, textarea",
      )!;
    try {
      await ui.type("/mo");
      field().setSelectionRange(3, 3);
      await ui.key("Tab", true);
      expect(field().value).toBe("/mo");
      await ui.key("Tab", false, { shiftKey: true });
      expect(field().value).toBe("/mo");
      await ui.key("Tab");
      expect(field().value).toBe("/model ");
      expect(field().selectionStart).toBe(7);
      expect(document.activeElement).toBe(field());
      expect(ui.calls).toHaveLength(0);
      expect(ui.element.querySelector(".model-picker")).toBeNull();
      await ui.key("Enter");
      expect(
        ui.element.querySelector('[aria-label="选择模型"]'),
      ).not.toBeNull();
      expect(ui.calls).toHaveLength(0);
      await ui.key("Escape");
      await ui.type("/s");
      field().setSelectionRange(2, 2);
      await ui.key("ArrowDown");
      await ui.key("Tab");
      expect(field().value).toBe("/shortcuts ");
      expect(ui.calls).toHaveLength(0);
      await ui.key("Enter");
      expect(ui.calls).toEqual([
        { command: "set_mode", args: { mode: "settings" } },
      ]);
    } finally {
      await ui.close();
    }
  }
});

test("Tab leaves command arguments and escaped text alone and preserves arguments when completing at the command", async () => {
  const ui = await mount(state("input"));
  const field = () =>
    ui.element.querySelector<HTMLTextAreaElement>("textarea")!;
  try {
    await ui.type("/mo deepseek/deepseek-flash");
    field().setSelectionRange(field().value.length, field().value.length);
    await ui.key("Tab");
    expect(field().value).toBe("/mo deepseek/deepseek-flash");
    field().setSelectionRange(3, 3);
    await ui.key("Tab");
    expect(field().value).toBe("/model deepseek/deepseek-flash");
    expect(field().selectionStart).toBe(7);
    for (const text of ["//model", "/unknown", "ordinary text", "/mo\ntext"]) {
      await ui.type(text);
      field().setSelectionRange(text.length, text.length);
      await ui.key("Tab");
      expect(field().value).toBe(text);
    }
    expect(ui.calls).toHaveLength(0);
  } finally {
    await ui.close();
  }
});

test("subscription login opens from slash commands, masks authorization prompts and returns to model selection", async () => {
  const requests: Record<string, unknown>[] = [];
  let complete = false;
  const request: RequestLogin = async (entry) => {
    requests.push(entry);
    if (entry.action === "providers")
      return {
        providers: [
          {
            id: "openai-codex",
            provider: "openai-codex",
            name: "ChatGPT subscription",
          },
        ],
      };
    if (entry.action === "input") {
      complete = true;
      return {
        attempt: "ui-attempt",
        provider: "openai-codex",
        phase: "waiting",
      };
    }
    if (entry.action === "cancel")
      return {
        attempt: "ui-attempt",
        provider: "openai-codex",
        phase: "cancelled",
      };
    return {
      attempt: "ui-attempt",
      provider: "openai-codex",
      phase: complete ? "complete" : "prompt",
      url: "https://auth.openai.com/oauth/authorize?state=synthetic",
      prompt: complete
        ? undefined
        : {
            id: 1,
            message: "Authorization code",
            secret: true,
            allowEmpty: false,
          },
    };
  };
  const ui = await mount(state("input"), catalog, undefined, request);
  try {
    await ui.type("/subscribe");
    await ui.key("Enter");
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "搜索订阅服务商",
    );
    await ui.key("Enter");
    expect(ui.element.querySelector<HTMLInputElement>("input")?.type).toBe(
      "password",
    );
    expect(ui.calls).toEqual([
      { command: "open_login_url", args: { attempt: "ui-attempt" } },
    ]);
    await ui.type("synthetic-callback-code");
    await ui.key("Enter", true);
    expect(requests.filter((entry) => entry.action === "input")).toHaveLength(
      0,
    );
    await ui.key("Enter");
    expect(requests.filter((entry) => entry.action === "input")).toHaveLength(
      1,
    );
    expect(ui.element.textContent).not.toContain("synthetic-callback-code");
    await act(async () => {
      await Bun.sleep(160);
    });
    expect(ui.element.querySelector(".account-login")).toBeNull();
    expect(ui.element.querySelector(".model-picker")).not.toBeNull();
    expect(
      ui.calls.some((call) =>
        [
          "ask_text",
          "ask_question",
          "translate_text",
          "save_provider",
        ].includes(call.command),
      ),
    ).toBe(false);
  } finally {
    await ui.close();
  }
});

test("Escape cancels an authorization attempt and restores the original command", async () => {
  const requests: Record<string, unknown>[] = [];
  const request: RequestLogin = async (entry) => {
    requests.push(entry);
    if (entry.action === "providers") return { providers: [] };
    return {
      attempt: "cancel-attempt",
      provider: "anthropic",
      phase: entry.action === "cancel" ? "cancelled" : "waiting",
    };
  };
  const ui = await mount(state("ask"), catalog, undefined, request);
  try {
    await ui.type("/login anthropic");
    await ui.key("Enter");
    expect(ui.element.querySelector(".account-login")).not.toBeNull();
    await ui.key("Escape");
    expect(
      requests.some(
        (entry) =>
          entry.action === "cancel" && entry.attempt === "cancel-attempt",
      ),
    ).toBe(true);
    expect(
      ui.element.querySelector<HTMLInputElement>("input, textarea")?.value,
    ).toBe("/login anthropic");
    expect(ui.calls).toHaveLength(0);
  } finally {
    await ui.close();
  }
});

test("SDK browser-session prompts open a private window without exposing a cookie input", async () => {
  const request: RequestLogin = async (entry) => {
    if (entry.action === "providers")
      return {
        providers: [
          { id: "perplexity", name: "Perplexity", provider: "perplexity" },
        ],
      };
    return {
      attempt: "browser-attempt",
      provider: "perplexity",
      phase: entry.action === "cancel" ? "cancelled" : "prompt",
      prompt: {
        id: 1,
        message: "Complete SSO in the private window",
        secret: true,
        allowEmpty: false,
        browser: {
          url: "https://www.perplexity.ai/auth/signin",
          cookieNames: ["__Secure-session"],
        },
      },
    };
  };
  const ui = await mount(state("input"), catalog, undefined, request);
  try {
    await ui.type("/login perplexity");
    await ui.key("Enter");
    expect(ui.calls).toEqual([
      {
        command: "open_login_browser",
        args: { attempt: "browser-attempt", prompt: 1 },
      },
    ]);
    expect(ui.element.querySelector("input, textarea")).toBeNull();
    expect(ui.element.textContent).not.toContain("__Secure-session");
    await ui.key("Escape");
    expect(ui.element.querySelector(".account-login")).toBeNull();
  } finally {
    await ui.close();
  }
});

test("updates follow settings navigation, preserve input drafts and dispatch explicit actions", async () => {
  const current = state("input");
  const ui = await mount(current);
  try {
    await ui.type("unfinished translation");
    await ui.click("设置");
    const settings: DesktopState = {
      ...current,
      desktop: { ...current.desktop, mode: "settings" },
    };
    await ui.render(settings);
    await ui.click("关于与更新");
    await ui.click("检查更新");
    expect(ui.calls.at(-1)?.command).toBe("check_updates");
    const available: DesktopState = {
      ...settings,
      updates: {
        ...current.updates,
        currentVersion: "0.1.0",
        phase: "available",
        availableVersion: "0.2.0",
        notes: "New improvements",
      },
    };
    await ui.render(available);
    await ui.click("下载更新");
    expect(ui.calls.at(-1)?.command).toBe("download_update");
    const checkbox =
      ui.element.querySelector<HTMLInputElement>("#auto-update")!;
    await act(async () => checkbox.click());
    expect(ui.calls.at(-1)).toEqual({
      command: "set_auto_update",
      args: { enabled: false },
    });
    await ui.render({
      ...available,
      updates: {
        ...available.updates,
        phase: "downloading",
        downloaded: 2048,
        total: null,
      },
    });
    expect(ui.element.querySelector("progress")?.hasAttribute("value")).toBe(
      false,
    );
    await ui.click("下载中…");
    expect(
      ui.calls.filter((call) => call.command === "download_update"),
    ).toHaveLength(1);
    const ready: DesktopState = {
      ...available,
      updates: { ...available.updates, phase: "ready" },
    };
    await ui.render({ ...ready, model: { ...ready.model, phase: "running" } });
    await ui.click("安装并重启");
    expect(ui.calls.some((call) => call.command === "install_update")).toBe(
      false,
    );
    await ui.render(ready);
    await ui.click("安装并重启");
    expect(ui.calls.at(-1)?.command).toBe("install_update");
    await ui.click("返回设置");
    await ui.click("返回导航窗口");
    await ui.render(current);
    expect(
      ui.element.querySelector<HTMLTextAreaElement>("textarea")?.value,
    ).toBe("unfinished translation");
  } finally {
    await ui.close();
  }
});

test("updates distinguish unpublished releases from network failures and retry", async () => {
  const current = state("settings");
  const ui = await mount(current);
  try {
    await ui.click("关于与更新");
    await ui.render({
      ...current,
      updates: { ...current.updates, phase: "no-release" },
    });
    expect(ui.element.textContent).toContain("尚未发布可用更新");
    expect(ui.element.textContent).not.toContain("已是最新版本");
    await ui.render({
      ...current,
      updates: { ...current.updates, phase: "error", error: "network" },
    });
    expect(ui.element.querySelector('[role="alert"]')?.textContent).toContain(
      "无法连接更新服务",
    );
    await ui.click("检查更新");
    expect(ui.calls.at(-1)?.command).toBe("check_updates");
  } finally {
    await ui.close();
  }
});

test("ask command submits only the question through the current entry's Ask path", async () => {
  for (const mode of ["input", "ask", "ask-result"] as const) {
    const ui = await mount(state(mode));
    try {
      await ui.type("/a");
      await ui.key("Tab");
      expect(
        ui.element.querySelector<HTMLInputElement | HTMLTextAreaElement>(
          "input, textarea",
        )!.value,
      ).toBe("/ask ");
      await ui.type("/ask Explain  /model literally");
      await ui.key("Enter", true);
      await ui.key("Enter", false, { keyCode: 229 });
      await ui.key("Enter", false, { shiftKey: true });
      expect(ui.calls).toHaveLength(0);
      await ui.key("Enter");
      expect(ui.calls).toEqual([
        mode === "input"
          ? { command: "ask_text", args: { text: "Explain  /model literally" } }
          : {
              command: "ask_question",
              args: { question: "Explain  /model literally" },
            },
      ]);
    } finally {
      await ui.close();
    }
  }
});

test("bare ask selects independent questioning or keeps the current Ask context", async () => {
  for (const mode of ["input", "ask", "ask-result"] as const) {
    const ui = await mount(state(mode));
    try {
      await ui.type("/ask");
      await ui.key("Enter");
      expect(ui.calls).toHaveLength(0);
      const field = ui.element.querySelector<
        HTMLInputElement | HTMLTextAreaElement
      >("input, textarea")!;
      expect(field.value).toBe("");
      expect(document.activeElement).toBe(field);
      await ui.type("What does MAPLE mean?");
      await ui.key("Enter");
      expect(ui.calls).toEqual([
        mode === "input"
          ? { command: "ask_text", args: { text: "What does MAPLE mean?" } }
          : {
              command: "ask_question",
              args: { question: "What does MAPLE mean?" },
            },
      ]);
    } finally {
      await ui.close();
    }
  }
});

test("ask waits for active tasks and retains a question after submission fails", async () => {
  for (const phase of ["preparing", "running", "compacting"] as const) {
    const value = state("input");
    value.model = { ...value.model, phase };
    const ui = await mount(value);
    try {
      for (const command of ["/ask", "/ask A new question"]) {
        await ui.type(command);
        await ui.key("Enter");
        expect(ui.calls).toHaveLength(0);
        expect(ui.element.textContent).toContain("请等待完成或取消后再提问");
        expect(
          ui.element.querySelector<HTMLTextAreaElement>("textarea")!.value,
        ).toBe(command);
      }
      await ui.render(state("input"));
      await ui.key("Enter");
      expect(ui.calls).toEqual([
        { command: "ask_text", args: { text: "A new question" } },
      ]);
    } finally {
      await ui.close();
    }
  }
  const pending = Promise.withResolvers<void | boolean>();
  const ui = await mount(state("input"), catalog, () => pending.promise);
  try {
    await ui.type("/ask First line\n  second line");
    await ui.key("Enter");
    await ui.key("Enter");
    expect(ui.calls).toEqual([
      { command: "ask_text", args: { text: "First line\n  second line" } },
    ]);
    await act(async () => pending.reject(new Error("Submission failed")));
    expect(
      ui.element.querySelector<HTMLTextAreaElement>("textarea")!.value,
    ).toBe("/ask First line\n  second line");
    expect(ui.element.textContent).toContain("暂时无法完成操作，请稍后重试。");
    expect(ui.element.textContent).not.toContain("Submission failed");
  } finally {
    await ui.close();
  }
});

test("history picker restores with search, arrows and Enter and Escape preserves the command draft", async () => {
  const value = state("input");
  const load = async () => ({
    sessions: [
      {
        id: "first",
        title: "First question",
        modified: "2026-10-21T00:00:00Z",
        messageCount: 2,
      },
      {
        id: "second",
        title: "Second question",
        modified: "2026-10-20T00:00:00Z",
        messageCount: 4,
      },
    ],
    total: 2,
  });
  const ui = await mount(value, catalog, undefined, undefined, load);
  try {
    await ui.type("/resume");
    await ui.key("Enter");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("搜索会话");
    await ui.key("Escape");
    expect(
      ui.element.querySelector<HTMLTextAreaElement>("textarea")!.value,
    ).toBe("/resume");
    expect(ui.calls).toHaveLength(0);
    await ui.key("Enter");
    await ui.key("ArrowDown");
    await ui.key("Enter", true);
    expect(ui.calls).toHaveLength(0);
    await ui.key("Enter");
    expect(ui.calls).toEqual([
      {
        command: "session_request",
        args: { request: { action: "resume", id: "second" } },
      },
    ]);
    await ui.type("/resume First");
    await ui.key("Enter");
    await ui.key("Enter");
    expect(ui.calls.at(-1)?.args).toEqual({
      request: { action: "resume", id: "first" },
    });
  } finally {
    await ui.close();
  }
});
test("thinking and tools commands configure locally and refuse changes during generation", async () => {
  const value = state("input");
  const ui = await mount(value);
  try {
    for (const [command, thinking, tools] of [
      ["/thinking high", "high", false],
      ["/tools on", "off", true],
    ] as const) {
      await ui.type(command);
      await ui.key("Enter");
      expect(ui.calls.at(-1)).toEqual({
        command: "session_request",
        args: {
          request: command.startsWith("/thinking")
            ? { action: "configure", thinking }
            : { action: "configure", tools },
        },
      });
    }
    await ui.render({ ...value, model: { ...value.model, phase: "running" } });
    const count = ui.calls.length;
    await ui.type("/tools off");
    await ui.key("Enter");
    expect(ui.calls).toHaveLength(count);
    expect(ui.element.textContent).toContain("请等待当前任务完成");
  } finally {
    await ui.close();
  }
});
test("a followup leaves the restored history view and shows the live answer", async () => {
  const value = state("ask-result");
  value.model.messages = [
    { role: "user", content: "Earlier question", truncated: false },
  ];
  value.model.messageCount = 1;
  const ui = await mount(value);
  try {
    await ui.click("会话记录 · 1");
    expect(ui.element.querySelector(".conversation-history")).not.toBeNull();
    await ui.render({
      ...value,
      desktop: { ...value.desktop, modelRevision: value.model.revision + 1 },
      model: {
        ...value.model,
        revision: value.model.revision + 1,
        phase: "running",
        output: "Live followup answer",
      },
    });
    expect(ui.element.querySelector(".conversation-history")).toBeNull();
    expect(ui.element.querySelector(".answer-response")?.textContent).toContain(
      "Live followup answer",
    );
  } finally {
    await ui.close();
  }
});
test("Ask keeps the question above the answer and its actions menu supports keyboard dismissal", async () => {
  const value = state("ask-result");
  value.desktop.operation = "ask";
  value.model.question = "Explain this configuration";
  value.model.output = "Configuration answer";
  const ui = await mount(value);
  try {
    expect(ui.element.querySelector(".launcher-footer")).toBeNull();
    const question = ui.element.querySelector(".question-block")!;
    expect(question.textContent).toContain("Explain this configuration");
    expect(
      question.compareDocumentPosition(
        ui.element.querySelector(".answer-response")!,
      ) & 4,
    ).toBe(4);
    const menu = ui.element.querySelector<HTMLDetailsElement>(".answer-menu")!;
    const summary = menu.querySelector("summary")!;
    await act(async () => {
      menu.open = true;
      summary.dispatchEvent(
        new dom.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }) as unknown as Event,
      );
    });
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(summary);
    expect(ui.calls).toHaveLength(0);
    await ui.render({
      ...value,
      model: { ...value.model, phase: "error", message: "Request failed" },
    });
    expect(ui.element.querySelector(".launcher-footer")?.textContent).toContain(
      "Request failed",
    );
  } finally {
    await ui.close();
  }
});
test("thinking, persisted messages, tool progress and costs are visible; each tool needs an explicit decision", async () => {
  const value = state("ask-result");
  value.model = {
    ...value.model,
    phase: "running",
    thinking: "high",
    thinkingOutput: "Visible provider reasoning",
    toolsEnabled: true,
    messages: [{ role: "user", content: "Earlier question", truncated: false }],
    messageCount: 1,
    toolCalls: [
      {
        type: "tool_execution_start",
        id: "tool",
        name: "read",
        text: "fixture.txt",
      },
    ],
    toolApprovals: [
      {
        id: "approval",
        name: "read",
        args: '{"path":"fixture.txt"}',
        cwd: "/workspace",
      },
    ],
    estimatedCost: 0.125,
    unpricedCalls: 2,
  };
  const ui = await mount(value);
  try {
    expect(ui.calls).toHaveLength(0);
    expect(ui.element.textContent).toContain("Visible provider reasoning");
    expect(document.activeElement?.textContent).toBe("拒绝本次");
    await ui.click("会话记录 · 1");
    expect(ui.element.textContent).toContain("Earlier question");
    await ui.click("当前回答");
    await ui.click("用量与费用");
    expect(ui.element.textContent).toContain("$0.1250");
    expect(ui.element.textContent).toContain("2 次费用未知");
    await ui.click("拒绝本次");
    expect(ui.calls.at(-1)).toEqual({
      command: "session_request",
      args: {
        request: { action: "decision", id: "approval", approved: false },
      },
    });
    await ui.click("允许本次");
    expect(ui.calls).toHaveLength(1);
    await ui.render({
      ...value,
      model: {
        ...value.model,
        toolApprovals: [
          { ...value.model.toolApprovals[0]!, id: "next-approval" },
        ],
      },
    });
    await ui.click("允许本次");
    expect(ui.calls.at(-1)?.args).toEqual({
      request: { action: "decision", id: "next-approval", approved: true },
    });
  } finally {
    await ui.close();
  }
});

test("Ask merges each tool lifecycle, previews results and keeps usage in an Escape-dismissible status control", async () => {
  const value = state("ask-result");
  value.model = {
    ...value.model,
    output: "## Result\n\n**Readable** response.",
    sessionEstimatedCost: 0.0042,
    sessionStats: {
      tokens: {
        input: 12400,
        output: 826,
        reasoning: 386,
        cacheRead: 8192,
        cacheWrite: 0,
        total: 13226,
      },
      toolCalls: 1,
    },
    toolCalls: [
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
        text: "line one\nline two\nline three",
        isError: false,
      },
    ],
  };
  const ui = await mount(value);
  try {
    expect(ui.element.querySelectorAll(".tool-row")).toHaveLength(1);
    expect(
      ui.element.querySelector(".tool-row summary")?.textContent,
    ).toContain("config.ts");
    expect(ui.element.querySelector(".tool-preview")?.textContent).toBe(
      "line one\nline two …",
    );
    expect(ui.element.querySelector(".answer-prose h2")?.textContent).toBe(
      "Result",
    );
    expect(ui.element.querySelector(".price-counter")?.textContent).toBe(
      "$0.0042",
    );
    expect(ui.element.querySelector(".usage-panel")).toBeNull();
    expect(
      ui.element
        .querySelector(".answer")!
        .compareDocumentPosition(ui.element.querySelector(".command-header")!) &
        4,
    ).toBe(4);
    await ui.click("用量与费用");
    expect(ui.element.querySelector(".usage-panel")?.textContent).toContain(
      "12,400",
    );
    const trigger =
      ui.element.querySelector<HTMLButtonElement>(".usage-trigger")!;
    await act(async () =>
      trigger.dispatchEvent(
        new dom.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }) as unknown as Event,
      ),
    );
    expect(ui.element.querySelector(".usage-panel")).toBeNull();
    expect(ui.calls).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
    const scroll = ui.element.querySelector<HTMLDivElement>(".answer")!;
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 300 },
    });
    scroll.scrollTop = 100;
    await act(async () =>
      scroll.dispatchEvent(new dom.Event("scroll") as unknown as Event),
    );
    await ui.render({
      ...value,
      model: { ...value.model, output: value.model.output + "\nMore content" },
    });
    expect(scroll.scrollTop).toBe(100);
  } finally {
    await ui.close();
  }
});

test("macOS OCR is local, preserves a cancelled command draft and prefills an editable review without submitting", async () => {
  const value = state("input");
  value.shortcuts = { ...value.shortcuts, macos: true, ocr: true };
  const ui = await mount(value);
  try {
    await ui.type("/ocr");
    await ui.key("Enter");
    expect(ui.calls).toEqual([{ command: "capture_ocr", args: undefined }]);
    await ui.render({ ...value, desktop: { ...value.desktop } });
    const field = () =>
      ui.element.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(field().value).toBe("/ocr");
    const reviewed = {
      ...value,
      desktop: {
        ...value.desktop,
        epoch: value.desktop.epoch + 1,
        context: {
          ...context,
          kind: "ocr" as const,
          origin: "截图识别",
          text: "Recognized words\n本机识别",
          anchor: null,
          anchorValid: false,
        },
      },
    };
    await ui.render(reviewed);
    expect(field().value).toBe("Recognized words\n本机识别");
    expect(ui.element.textContent).toContain("截图识别 · 请校对");
    expect(ui.calls).toHaveLength(1);
    await ui.type("Corrected words");
    await ui.render({ ...reviewed, desktop: { ...reviewed.desktop } });
    expect(field().value).toBe("Corrected words");
    await ui.key("Enter");
    expect(ui.calls.at(-1)).toEqual({
      command: "translate_text",
      args: { text: "Corrected words" },
    });
  } finally {
    await ui.close();
  }
});

test("OCR content that looks like a command remains ordinary text, and unsupported hosts keep OCR unavailable", async () => {
  const value = state("input");
  value.shortcuts = { ...value.shortcuts, macos: true, ocr: true };
  value.desktop.context = {
    ...context,
    kind: "ocr",
    text: "/tools on",
    anchor: null,
    anchorValid: false,
  };
  const ui = await mount(value);
  try {
    expect(
      ui.element.querySelector<HTMLTextAreaElement>("textarea")!.value,
    ).toBe("//tools on");
    await ui.key("Enter");
    expect(ui.calls).toEqual([
      { command: "translate_text", args: { text: "/tools on" } },
    ]);
    await ui.render({
      ...value,
      shortcuts: { ...value.shortcuts, macos: false, ocr: false },
    });
    await ui.type("/ocr");
    await ui.key("Enter");
    expect(ui.calls).toHaveLength(1);
    expect(ui.element.textContent).toContain("截图识别需要 Windows 或 macOS");
  } finally {
    await ui.close();
  }
});

test("Command completion follows the visible commands when OCR is unavailable", async () => {
  const value = state("input");
  value.shortcuts = { ...value.shortcuts, macos: false };
  const ui = await mount(value);
  try {
    await ui.type("/");
    const entries = [
      ...ui.element.querySelectorAll<HTMLButtonElement>(
        '[aria-label="应用命令"] .action',
      ),
    ];
    const index = entries.findIndex((entry) =>
      entry.textContent?.includes("/resume"),
    );
    expect(index).toBeGreaterThan(0);
    for (let i = 0; i < index; i++) await ui.key("ArrowDown");
    await ui.key("Tab");
    expect(
      ui.element.querySelector<HTMLTextAreaElement>("textarea")!.value,
    ).toBe("/resume ");
  } finally {
    await ui.close();
  }
});

test("translation placement saves independently and shortcuts label both styles", async () => {
  const value = state("settings");
  value.shortcuts = {
    ...value.shortcuts,
    macos: true,
    ocr: true,
    registered: Array(6).fill(true),
  };
  const ui = await mount(value);
  try {
    await ui.click("翻译偏好");
    const display = ui.element.querySelector<HTMLSelectElement>(
      "#translation-display",
    )!;
    await act(async () => {
      display.value = "panel";
      display.dispatchEvent(
        new dom.Event("change", { bubbles: true }) as unknown as Event,
      );
    });
    expect(ui.calls.at(-1)).toEqual({
      command: "patch_settings",
      args: { patch: { translationDisplay: "panel" } },
    });
    await ui.render({
      ...value,
      model: {
        ...value.model,
        settings: { ...value.model.settings, translationDisplay: "panel" },
      },
    });
    await ui.click("返回设置");
    await ui.click("快捷键");
    expect(
      ui.element.querySelector('label[for="shortcut-ocr"]')?.textContent,
    ).toContain("悬浮栏");
    expect(
      ui.element.querySelector('label[for="shortcut-ocrAlternate"]')
        ?.textContent,
    ).toContain("原文下方");
    expect(
      ui.element.querySelector<HTMLInputElement>("#shortcut-ocrAlternate")
        ?.value,
    ).toBe("Ctrl+Option+Shift+O");
  } finally {
    await ui.close();
  }
});

test("preference controls patch independent fields before polling catches up", async () => {
  const ui = await mount(state("settings"));
  try {
    await ui.click("翻译偏好");
    await ui.select("English", "#target");
    await act(async () =>
      ui.element.querySelector<HTMLInputElement>("#pin-window")!.click(),
    );
    await ui.select("panel", "#translation-display");
    expect(ui.calls).toEqual([
      { command: "patch_settings", args: { patch: { target: "English" } } },
      { command: "patch_settings", args: { patch: { pinned: false } } },
      {
        command: "patch_settings",
        args: { patch: { translationDisplay: "panel" } },
      },
    ]);
  } finally {
    await ui.close();
  }
});

test("failed preference persistence is shown in settings and keeps the previous value", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const snapshot = state("settings");
  let rejectSave!: (error: unknown) => void;
  const save = new Promise((_, reject) => {
    rejectSave = reject;
  });
  const invoke = <T>(command: string): Promise<T> => {
    if (command === "patch_settings") return save as Promise<T>;
    return Promise.resolve((command === "desktop_state" ? snapshot : {}) as T);
  };
  try {
    await act(async () => root.render(React.createElement(App, { invoke })));
    const preferences = [
      ...element.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.getAttribute("aria-label") === "翻译偏好")!;
    await act(async () => preferences.click());
    const select = element.querySelector<HTMLSelectElement>("#target")!;
    await act(async () => {
      select.value = "English";
      select.dispatchEvent(
        new dom.Event("change", { bubbles: true }) as unknown as Event,
      );
    });
    expect(element.textContent).not.toContain("设置已保存");
    await act(async () => {
      rejectSave("settings_write_failed");
      await Promise.resolve();
    });
    expect(element.textContent).toContain("设置保存失败，原配置继续生效。");
    expect(select.value).toBe("简体中文");
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

test("automatic mouse selection is opt-in, hidden on macOS, and failed persistence rolls back the checkbox", async () => {
  for (const macos of [false, true]) {
    const value = state("settings");
    value.shortcuts = { ...value.shortcuts, macos };
    const ui = await mount(value);
    try {
      await ui.click("翻译偏好");
      const label = [...ui.element.querySelectorAll("label")].find((label) =>
        label.textContent?.includes("鼠标选中后自动翻译"),
      );
      if (macos) {
        expect(label).toBeUndefined();
        continue;
      }
      expect(label?.querySelector<HTMLInputElement>("input")?.checked).toBe(
        false,
      );
      expect(ui.element.textContent).toContain("原有划词快捷键仍可使用");
      await act(async () =>
        label!.querySelector<HTMLInputElement>("input")!.click(),
      );
      expect(ui.calls.at(-1)).toEqual({
        command: "patch_settings",
        args: { patch: { autoSelectionTranslation: true } },
      });
    } finally {
      await ui.close();
    }
  }
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const snapshot = state("settings");
  const invoke = <T>(command: string): Promise<T> =>
    command === "patch_settings"
      ? Promise.reject("settings_write_failed")
      : Promise.resolve((command === "desktop_state" ? snapshot : {}) as T);
  try {
    await act(async () => root.render(React.createElement(App, { invoke })));
    await act(async () =>
      [...element.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.getAttribute("aria-label") === "翻译偏好")!
        .click(),
    );
    const checkbox = [...element.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("鼠标选中后自动翻译"))!
      .querySelector<HTMLInputElement>("input")!;
    await act(async () => checkbox.click());
    expect(element.textContent).toContain("设置保存失败，原配置继续生效。");
    expect(checkbox.checked).toBe(false);
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

test("automatic selection toggle shows pending save and rejects duplicate changes", async () => {
  const value = state("settings");
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  let saves = 0;
  const invoke = <T>(command: string): Promise<T> => {
    if (command === "patch_settings") {
      saves++;
      return pending as Promise<T>;
    }
    return Promise.resolve((command === "desktop_state" ? value : {}) as T);
  };
  try {
    await act(async () => root.render(React.createElement(App, { invoke })));
    await act(async () =>
      [...element.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.getAttribute("aria-label") === "翻译偏好")!
        .click(),
    );
    const checkbox = [...element.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("鼠标选中后自动翻译"))!
      .querySelector<HTMLInputElement>("input")!;
    await act(async () => checkbox.click());
    expect(checkbox.disabled).toBe(true);
    expect(element.textContent).toContain("保存中…");
    await act(async () => checkbox.click());
    expect(saves).toBe(1);
    value.model.settings = {
      ...value.model.settings,
      autoSelectionTranslation: true,
    };
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.checked).toBe(true);
    expect(element.textContent).not.toContain("保存中…");
  } finally {
    finish();
    await act(async () => root.unmount());
    element.remove();
  }
});

test("Chinese followups use the input byte budget and oversized questions stay editable without a native call", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const snapshot = state("ask-result");
  const questions: string[] = [];
  const invoke = <T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> => {
    if (command === "ask_question") questions.push(String(args?.question));
    return Promise.resolve((command === "desktop_state" ? snapshot : {}) as T);
  };
  const typeAndSubmit = async (text: string) => {
    const input = element.querySelector<HTMLTextAreaElement>(
      '[aria-label="Ask 问题或动作"]',
    )!;
    const setter = Object.getOwnPropertyDescriptor(
      dom.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(input, text);
      input.dispatchEvent(
        new dom.Event("input", { bubbles: true }) as unknown as Event,
      );
    });
    await act(async () =>
      input.dispatchEvent(
        new dom.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
        }) as unknown as Event,
      ),
    );
    return input;
  };
  try {
    await act(async () => root.render(React.createElement(App, { invoke })));
    const valid = "问".repeat(1500);
    await typeAndSubmit(valid);
    expect(questions).toEqual([valid]);
    const tooLong = "问".repeat(5001);
    const input = await typeAndSubmit(tooLong);
    expect(questions).toEqual([valid]);
    expect(input.value).toBe(tooLong);
    expect(element.textContent).toContain("文本或问题过长");
    expect(element.textContent).not.toContain("请输入需要翻译的文本");
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

test("OCR commands can override placement once without saving a preference", async () => {
  const value = state("input");
  value.shortcuts = { ...value.shortcuts, macos: true, ocr: true };
  const ui = await mount(value);
  try {
    await ui.type("/ocr panel");
    await ui.key("Enter");
    expect(ui.calls.at(-1)).toEqual({
      command: "capture_ocr",
      args: { display: "panel" },
    });
    await ui.type("/ocr below");
    await ui.key("Enter");
    expect(ui.calls.at(-1)).toEqual({
      command: "capture_ocr",
      args: { display: "below" },
    });
    expect(ui.calls.every((call) => call.command === "capture_ocr")).toBe(true);
  } finally {
    await ui.close();
  }
});

test("history search distinguishes no matches and clears the query back to focused history", async () => {
  const queries: string[] = [];
  const load: LoadSessions = async (_offset, query = "") => {
    queries.push(query);
    return query.trim()
      ? { sessions: [], total: 0 }
      : {
          sessions: [
            {
              id: "recent",
              title: "Recent history",
              modified: "2026-10-21T00:00:00Z",
              messageCount: 2,
            },
          ],
          total: 1,
        };
  };
  const ui = await mount(state("input"), catalog, undefined, undefined, load);
  try {
    await ui.type("/resume");
    await ui.key("Enter");
    expect(ui.element.textContent).toContain("Recent history");
    await ui.type("  missing  ");
    expect(ui.element.querySelector(".quiet-status")?.textContent).toContain(
      "没有匹配的会话",
    );
    expect(ui.element.textContent).not.toContain("暂无历史会话");
    const input = ui.element.querySelector<HTMLInputElement>(
      '[aria-label="搜索会话"]',
    )!;
    const clear = [
      ...ui.element.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "清空搜索")!;
    clear.focus();
    expect(document.activeElement).toBe(clear);
    await ui.click("清空搜索");
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(ui.element.textContent).toContain("Recent history");
    expect(ui.element.querySelector(".quiet-status")).toBeNull();
    expect(queries).toEqual(["", "  missing  ", ""]);
  } finally {
    await ui.close();
  }
});

test("an empty history with an empty or whitespace-only query does not offer search recovery", async () => {
  const load: LoadSessions = async () => ({ sessions: [], total: 0 });
  const ui = await mount(state("input"), catalog, undefined, undefined, load);
  try {
    await ui.type("/resume");
    await ui.key("Enter");
    for (const query of ["", "   "]) {
      await ui.type(query);
      expect(ui.element.querySelector(".quiet-status")?.textContent).toBe(
        "暂无历史会话",
      );
      expect(ui.element.textContent).not.toContain("没有匹配的会话");
      expect(ui.element.textContent).not.toContain("清空搜索");
    }
  } finally {
    await ui.close();
  }
});

test("history loading and failed queries do not claim empty results or retain the previous total", async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<Awaited<ReturnType<LoadSessions>>>(
    (_resolve, fail) => {
      reject = fail;
    },
  );
  const load: LoadSessions = async (_offset, query) =>
    query
      ? pending
      : {
          sessions: [
            {
              id: "recent",
              title: "Recent",
              modified: "2026-10-21T00:00:00Z",
              messageCount: 1,
            },
          ],
          total: 123,
        };
  const ui = await mount(state("input"), catalog, undefined, undefined, load);
  try {
    await ui.type("/resume");
    await ui.key("Enter");
    expect(ui.element.querySelector(".list-caption")?.textContent).toContain(
      "123 个会话",
    );
    await ui.type("pending query");
    expect(ui.element.querySelector(".list-caption")?.textContent).toContain(
      "正在读取…",
    );
    expect(ui.element.querySelector(".quiet-status")).toBeNull();
    expect(ui.element.textContent).not.toContain("加载更多会话");
    await act(async () => {
      reject(new Error("history unavailable"));
      await Promise.resolve();
    });
    expect(ui.element.querySelector('[role="alert"]')?.textContent).toContain(
      "会话历史未加载完整",
    );
    expect(ui.element.querySelector(".list-caption")?.textContent).toContain(
      "读取未完成",
    );
    expect(ui.element.querySelector(".quiet-status")).toBeNull();
    expect(ui.element.textContent).not.toContain("123");
    expect(ui.element.textContent).not.toContain("清空搜索");
    expect(ui.element.textContent).toContain("重新加载会话");
  } finally {
    await ui.close();
  }
});

test("a startup restore timeout cannot mask a later native shortcut translation", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  let rejectRestore!: (error: unknown) => void;
  const restore = new Promise((_, reject) => {
    rejectRestore = reject;
  });
  let snapshot: DesktopState = {
    ...initialState,
    desktop: { ...initialState.desktop, mode: "menu" },
  };
  const invoke = <T>(command: string): Promise<T> =>
    command === "session_request"
      ? (restore as Promise<T>)
      : Promise.resolve(snapshot as T);
  try {
    await act(async () => root.render(React.createElement(App, { invoke })));
    await act(async () => {
      rejectRestore("service_timeout");
      await Promise.resolve();
    });
    expect(element.textContent).toContain("模型服务响应超时");
    snapshot = {
      ...snapshot,
      desktop: {
        ...snapshot.desktop,
        epoch: 1,
        modelRevision: 1,
        mode: "translation",
        context,
        translation: "已完成的译文",
      },
      model: { ...snapshot.model, revision: 1, phase: "completed" },
    };
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(element.textContent).toContain("已完成的译文");
    expect(element.textContent).not.toContain("模型服务响应超时");
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

test("a late startup restore failure does not replace an active translation", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  let rejectRestore!: (error: unknown) => void;
  const restore = new Promise((_, reject) => {
    rejectRestore = reject;
  });
  const snapshot: DesktopState = {
    ...initialState,
    desktop: {
      ...initialState.desktop,
      epoch: 2,
      modelRevision: 3,
      mode: "translation",
      context,
      translation: "当前译文",
    },
    model: { ...initialState.model, revision: 3, phase: "completed" },
  };
  const invoke = <T>(command: string): Promise<T> =>
    command === "session_request"
      ? (restore as Promise<T>)
      : Promise.resolve(snapshot as T);
  try {
    await act(async () => root.render(React.createElement(App, { invoke })));
    await act(async () => {
      rejectRestore("service_timeout");
      await Promise.resolve();
    });
    expect(element.textContent).toContain("当前译文");
    expect(element.textContent).not.toContain("模型服务响应超时");
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

test("history loads one page, searches all history on the server and retries incomplete pages", async () => {
  const requests: Array<[number, string]> = [];
  let fail = true;
  const load: LoadSessions = async (offset = 0, query = "") => {
    requests.push([offset, query]);
    if (offset && fail) return { sessions: [], total: 2 };
    return {
      sessions: [
        {
          id: query ? "older" : offset ? "next" : "recent",
          title: query ? "x".repeat(100) : offset ? "Next" : "Recent",
          modified: "2026-10-21T00:00:00Z",
          messageCount: 2,
        },
      ],
      total: query ? 1 : 2,
      snapshot: "stable",
    };
  };
  const ui = await mount(state("input"), catalog, undefined, undefined, load);
  try {
    await ui.type("/resume");
    await ui.key("Enter");
    expect(requests).toEqual([[0, ""]]);
    await ui.click("加载更多会话");
    expect(ui.element.textContent).toContain("会话历史未加载完整");
    fail = false;
    await ui.click("重新加载会话");
    await ui.type("Older");
    expect(requests.at(-1)).toEqual([0, "Older"]);
    expect(ui.element.querySelector("strong")?.title).toBe("x".repeat(100));
    await ui.key("Enter");
    expect(ui.calls.at(-1)?.args).toEqual({
      request: { action: "resume", id: "older" },
    });
  } finally {
    await ui.close();
  }
});

test("multiline followups support explicit send and keep IME, Shift Enter and busy drafts intact", async () => {
  const value = state("ask-result");
  const ui = await mount(value);
  try {
    await ui.type("第一行\n第二行");
    await ui.key("Enter", true);
    await ui.key("Enter", false, { shiftKey: true });
    expect(ui.calls).toHaveLength(0);
    await ui.click("发送追问");
    expect(ui.calls.at(-1)).toEqual({
      command: "ask_question",
      args: { question: "第一行\n第二行" },
    });
    value.model.phase = "running";
    await ui.render(value);
    await ui.type("继续编辑的草稿");
    await ui.key("Enter");
    expect(ui.calls).toHaveLength(1);
    await ui.click("停止生成");
    expect(ui.calls.at(-1)?.command).toBe("cancel_task");
    expect(ui.element.querySelector("textarea")?.value).toBe("继续编辑的草稿");
    await ui.key("Escape");
    expect(ui.calls.at(-1)?.command).toBe("cancel_task");
    expect(ui.calls.some((call) => call.command === "set_mode")).toBe(false);
  } finally {
    await ui.close();
  }
});

test("followup commands preserve the answer surface and Escape returns to editing", async () => {
  const value = state("ask-result");
  value.model.output = "Keep this answer visible";
  const ui = await mount(value);
  try {
    const answer = ui.element.querySelector('[aria-label="Ask 回答"]');
    await ui.type("/model");
    expect(ui.element.querySelector('[aria-label="Ask 回答"]')).toBe(answer);
    expect(ui.element.textContent).toContain("Keep this answer visible");
    expect(
      ui.element.querySelector('.followup-composer [aria-label="应用命令"]'),
    ).not.toBeNull();
    await ui.key("Escape");
    expect(ui.element.querySelector('[aria-label="应用命令"]')).toBeNull();
    expect(ui.element.querySelector("textarea")?.value).toBe("");
    expect(ui.calls).toHaveLength(0);
  } finally {
    await ui.close();
  }
});

test("restored unanswered questions show an answer-specific empty state", async () => {
  const value = state("ask-result");
  value.model.question = "Interrupted question";
  value.model.output = "";
  value.model.message = "选择文字，复制后翻译。";
  const ui = await mount(value);
  try {
    expect(ui.element.textContent).toContain("本轮暂无可恢复的回答");
    expect(ui.element.textContent).not.toContain("选择文字，复制后翻译。");
    value.model.phase = "error";
    value.model.message = "请求失败";
    await ui.render(value);
    expect(ui.element.textContent).toContain("请求失败");
  } finally {
    await ui.close();
  }
});

test("multiline Ask leaves plain arrows to the editor and Alt arrows select actions", async () => {
  const ui = await mount(state("ask"));
  try {
    await ui.type("First line\nSecond line");
    const input = ui.element.querySelector("textarea")!;
    for (const altKey of [false, true]) {
      const event = new dom.KeyboardEvent("keydown", {
        key: "ArrowUp",
        bubbles: true,
        cancelable: true,
        altKey,
      });
      await act(async () => {
        input.dispatchEvent(event as unknown as Event);
      });
      expect(event.defaultPrevented).toBe(altKey);
    }
    expect(ui.calls).toHaveLength(0);
  } finally {
    await ui.close();
  }
});

test("answer links open through the native boundary only after an explicit click", async () => {
  const value = state("ask-result");
  value.model.output =
    "[Documentation](https://example.com/docs)\n\n[Unsafe](javascript:alert(1))";
  const ui = await mount(value);
  try {
    expect(ui.calls).toHaveLength(0);
    expect(ui.element.querySelectorAll(".answer-link-button")).toHaveLength(1);
    await ui.click("Documentation ↗");
    expect(ui.calls).toEqual([
      {
        command: "open_external_url",
        args: { url: "https://example.com/docs" },
      },
    ]);
  } finally {
    await ui.close();
  }
});

test("settings search keeps its query across subpages and Escape clears before leaving", async () => {
  const ui = await mount(state("settings"));
  try {
    await ui.type("置顶", '[aria-label="搜索设置"]');
    expect(
      ui.element.querySelectorAll(".settings-categories .action"),
    ).toHaveLength(1);
    await ui.key("Enter");
    expect(ui.element.querySelector("#target")!.closest("[hidden]")).toBeNull();
    await ui.key("Escape");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("翻译偏好");
    expect(
      ui.element.querySelector<HTMLInputElement>('[aria-label="搜索设置"]')!
        .value,
    ).toBe("置顶");
    await ui.key("Escape");
    expect(
      ui.element.querySelectorAll(".settings-categories .action"),
    ).toHaveLength(4);
    expect(ui.calls).toHaveLength(0);
    await ui.type("不存在", '[aria-label="搜索设置"]');
    await ui.key("Enter");
    expect(ui.element.textContent).toContain("没有匹配的设置");
    expect(ui.calls).toHaveLength(0);
  } finally {
    await ui.close();
  }
});

test("picker paging clamps to visible rows and history identifies the current session", async () => {
  const value = state("input");
  value.model.sessionId = "item-0";
  value.model.configuredProviders = ["openai"];
  const ui = await mount(
    value,
    async () => ({
      providers: [],
      supported: true,
      total: 12,
      models: Array.from({ length: 12 }, (_, i) => ({
        id: `item-${String(i).padStart(2, "0")}`,
        name: `Model ${String(i).padStart(2, "0")}`,
        contextWindow: 8192,
      })),
    }),
    undefined,
    undefined,
    async (_offset, query = "") => {
      const sessions = Array.from({ length: 12 }, (_, i) => ({
        id: `item-${i}`,
        title: `Session ${i}`,
        modified: "2026-10-21T00:00:00Z",
        messageCount: 2,
      })).filter((item) => item.title.includes(query));
      return { total: sessions.length, sessions };
    },
  );
  try {
    await ui.type("/model");
    await ui.key("Enter");
    await ui.key("PageDown");
    expect(ui.element.querySelector(".action.selected")?.textContent).toContain(
      "Model 08",
    );
    await ui.key("PageDown");
    expect(ui.element.querySelector(".action.selected")?.textContent).toContain(
      "Model 11",
    );
    await ui.key("PageUp");
    expect(ui.element.querySelector(".action.selected")?.textContent).toContain(
      "Model 03",
    );
    await ui.key("Escape");
    await ui.type("/resume");
    await ui.key("Enter");
    expect(
      ui.element.querySelector('[aria-current="true"]')?.textContent,
    ).toContain("Session 0");
    await ui.key("PageDown");
    expect(ui.element.querySelector(".action.selected")?.textContent).toContain(
      "Session 8",
    );
    await ui.type("Session 11");
    expect(ui.element.textContent).toContain("1 / 1 个会话");
    await ui.key("PageDown");
    expect(ui.element.querySelector(".action.selected")?.textContent).toContain(
      "Session 11",
    );
    expect(ui.calls).toHaveLength(0);
  } finally {
    await ui.close();
  }
});

test("activity details close locally with Escape, retain expansion on updates, and pause following", async () => {
  const value = state("ask-result");
  value.model.thinkingOutput = "Reasoning summary\n\nMore details";
  value.model.output = "Partial answer";
  value.model.toolCalls = [
    {
      type: "tool_execution_start",
      id: "read",
      name: "read",
      text: '{"path":"fixture.txt"}',
    },
  ];
  const ui = await mount(value);
  try {
    expect(ui.element.querySelector(".follow-answer")).toBeNull();
    const details =
      ui.element.querySelector<HTMLDetailsElement>(".thinking-row")!;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new dom.Event("toggle") as unknown as Event);
    });
    expect(ui.element.querySelector(".follow-answer")).not.toBeNull();
    await ui.render({
      ...value,
      model: {
        ...value.model,
        thinkingOutput: "Reasoning summary\n\nUpdated details",
      },
    });
    expect(details.open).toBe(true);
    const summary = details.querySelector("summary")!;
    for (const isComposing of [true, false]) {
      await act(async () =>
        summary.dispatchEvent(
          new dom.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            isComposing,
          }) as unknown as Event,
        ),
      );
      expect(details.open).toBe(isComposing);
    }
    expect(document.activeElement).toBe(summary);
    expect(ui.calls).toHaveLength(0);
    const tool = ui.element.querySelector<HTMLDetailsElement>(".tool-row")!;
    expect(tool.textContent).toContain("调用已停止，暂无结果。");
    await act(async () => {
      tool.open = true;
      tool.querySelector("pre")!.dispatchEvent(
        new dom.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }) as unknown as Event,
      );
    });
    expect(tool.open).toBe(false);
    expect(document.activeElement).toBe(tool.querySelector("summary"));
    expect(ui.calls).toHaveLength(0);
  } finally {
    await ui.close();
  }
});

test("partial answer errors remain visible and answer copy is directly available", async () => {
  const value = state("ask-result");
  value.model.output = "Preserved partial answer";
  value.model.phase = "error";
  value.model.message = "连接中断，请重试";
  const ui = await mount(value);
  try {
    expect(ui.element.querySelector(".answer-response")?.textContent).toContain(
      value.model.output,
    );
    expect(ui.element.querySelector(".answer-error")?.textContent).toBe(
      value.model.message,
    );
    await ui.click("复制回答");
    expect(ui.calls).toEqual([
      { command: "copy_text", args: { text: value.model.output } },
    ]);
  } finally {
    await ui.close();
  }
});

test("answer polling preserves code and table nodes, focus and horizontal scroll", async () => {
  const value = state("ask-result");
  value.model.output =
    "```text\nwide code\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |";
  const ui = await mount(value);
  try {
    const pre = ui.element.querySelector<HTMLPreElement>(".answer-prose pre")!;
    const table = ui.element.querySelector<HTMLDivElement>(".answer-table")!;
    pre.focus();
    pre.scrollLeft = 30;
    table.scrollLeft = 20;
    await ui.render({
      ...value,
      model: { ...value.model, reportedTokens: 20 },
    });
    expect(ui.element.querySelector(".answer-prose pre")).toBe(pre);
    expect(ui.element.querySelector(".answer-table")).toBe(table);
    expect(document.activeElement).toBe(pre);
    expect(pre.scrollLeft).toBe(30);
    expect(table.scrollLeft).toBe(20);
  } finally {
    await ui.close();
  }
});

test("restored activity includes complete past turns and ignores stale session responses", async () => {
  const value = state("ask-result");
  value.model.sessionId = "restored";
  value.model.sessionReady = true;
  value.model.messages = [
    { role: "assistant", content: "short preview", truncated: true },
  ];
  value.model.messageCount = 4;
  const turns = [
    {
      id: "first",
      question: "Earlier",
      output: "Complete older answer",
      thinkingOutput: "Earlier reasoning",
      toolCalls: [],
    },
    {
      id: "last",
      question: "Latest",
      output: "Answer",
      thinkingOutput: "Complete persisted reasoning",
      toolCalls: [
        {
          type: "tool_execution_start",
          id: "tool",
          name: "read",
          text: '{"path":"fixture.txt"}',
        },
        {
          type: "tool_execution_end",
          id: "tool",
          name: "read",
          text: "Full result tail",
          isError: false,
        },
      ],
    },
  ];
  let resolve!: (value: { turns: typeof turns }) => void;
  let requested = 0;
  const load: LoadActivity = async () => {
    requested++;
    if (requested === 1) return { turns };
    return new Promise((r) => {
      resolve = r;
    });
  };
  const ui = await mount(value, catalog, undefined, undefined, undefined, load);
  try {
    expect(ui.element.querySelector(".thinking-row")?.textContent).toContain(
      "Complete persisted reasoning",
    );
    expect(ui.element.querySelector(".tool-body")?.textContent).toContain(
      "Full result tail",
    );
    await ui.click("会话记录 · 4");
    expect(ui.element.querySelectorAll(".history-turn")).toHaveLength(2);
    expect(ui.element.textContent).toContain("Complete older answer");
    expect(ui.element.textContent).toContain("Earlier reasoning");
    await ui.render({
      ...value,
      desktop: { ...value.desktop, modelRevision: 2 },
      model: { ...value.model, sessionId: "next", revision: 2 },
    });
    await ui.render({
      ...value,
      desktop: { ...value.desktop, modelRevision: 3 },
      model: {
        ...value.model,
        sessionId: null,
        sessionReady: false,
        revision: 3,
      },
    });
    await act(async () => resolve({ turns }));
    expect(ui.element.querySelector(".thinking-row")).toBeNull();
    expect(ui.calls).toHaveLength(0);
  } finally {
    await ui.close();
  }
});

test("persisted activity failures are retryable without replaying tools", async () => {
  const value = state("ask-result");
  value.model.sessionId = "retry";
  value.model.sessionReady = true;
  let count = 0;
  const load: LoadActivity = async () => {
    if (!count++) throw new Error("unavailable");
    return {
      turns: [
        {
          id: "turn",
          question: "Q",
          output: "A",
          thinkingOutput: "Restored",
          toolCalls: [],
        },
      ],
    };
  };
  const ui = await mount(value, catalog, undefined, undefined, undefined, load);
  try {
    expect(ui.element.textContent).toContain("完整过程加载失败");
    await ui.click("重试加载完整过程");
    expect(ui.element.textContent).not.toContain("完整过程加载失败");
    expect(ui.element.querySelector(".thinking-row")?.textContent).toContain(
      "Restored",
    );
    expect(ui.calls).toHaveLength(0);
  } finally {
    await ui.close();
  }
});

test("activity loader joins chunks, rejects mixed versions and honors cancellation", async () => {
  const { loadActivity } = await import("../apps/desktop/src/api");
  const json = JSON.stringify({
    turns: [
      {
        id: "u",
        question: "中文🛋️",
        output: "",
        thinkingOutput: "完整思考",
        toolCalls: [],
      },
    ],
  });
  const abort = new AbortController();
  let calls = 0;
  const invoke = async <T>(
    _command: string,
    args?: Record<string, unknown>,
  ): Promise<T> => {
    calls++;
    const request = args!.request as { offset: number; version: string | null };
    if (request.offset) expect(request.version).toBe("version");
    const end = Math.min(json.length, request.offset + 7);
    return {
      chunk: json.slice(request.offset, end),
      next: end < json.length ? end : null,
      version: "version",
    } as T;
  };
  expect(await loadActivity("id", abort.signal, invoke)).toEqual(
    JSON.parse(json),
  );
  expect(calls).toBeGreaterThan(2);
  let page = 0;
  await expect(
    loadActivity(
      "id",
      abort.signal,
      async <T>() =>
        ({ chunk: "x", next: ++page, version: page === 1 ? "a" : "b" }) as T,
    ),
  ).rejects.toThrow("invalid_activity_page");
  abort.abort();
  const before = calls;
  await expect(loadActivity("id", abort.signal, invoke)).rejects.toThrow();
  expect(calls).toBe(before);
});

test("code controls preserve exact text and survive polling; table copy uses quoted TSV", async () => {
  const value = state("ask-result");
  const code = "\tconst 中文 = 1;  \n".repeat(20);
  value.model.output =
    "```ts\n" + code + '```\n\n| A | B |\n|---|---|\n| 中文 | say "yes" |';
  let fail = true;
  const ui = await mount(value, catalog, async () => !fail);
  try {
    await ui.click("自动换行");
    await ui.click("展开全部");
    await ui.render({
      ...value,
      model: { ...value.model, reportedTokens: 10 },
    });
    expect(ui.element.querySelector(".code-block")?.className).toContain(
      "is-wrapped is-expanded",
    );
    await ui.click("复制代码");
    expect(ui.calls.at(-1)).toEqual({
      command: "copy_text",
      args: { text: code },
    });
    expect(ui.element.textContent).toContain("复制失败，请重试");
    fail = false;
    await ui.click("复制代码");
    expect(
      ui.element.querySelector('[aria-label="复制代码"]')?.textContent,
    ).toBe("已复制");
    await ui.click("复制表格");
    expect(ui.calls.at(-1)).toEqual({
      command: "copy_text",
      args: { text: 'A\tB\n中文\t"say ""yes"""' },
    });
    await ui.click("展开表格");
    expect(ui.element.querySelector(".table-block")?.className).toContain(
      "is-expanded",
    );
  } finally {
    await ui.close();
  }
});

test("restored answer copies full content beyond snapshot preview", async () => {
  const value = state("ask-result");
  value.model.sessionId = "full-copy";
  value.model.sessionReady = true;
  value.model.output = "preview";
  const output = "完整内容".repeat(3000) + "END";
  const ui = await mount(
    value,
    catalog,
    undefined,
    undefined,
    undefined,
    async () => ({
      turns: [
        {
          id: "turn",
          question: "Q",
          output,
          thinkingOutput: "",
          toolCalls: [],
        },
      ],
    }),
  );
  try {
    expect(ui.element.querySelector(".answer-response")?.textContent).toContain(
      output,
    );
    await ui.click("复制回答");
    expect(ui.calls).toEqual([
      { command: "copy_text", args: { text: output } },
    ]);
  } finally {
    await ui.close();
  }
});

test("completed answer polling cannot pull expanded content to the bottom", async () => {
  const value = state("ask-result");
  value.model.output = "```text\n" + "line\n".repeat(20) + "```";
  const ui = await mount(value);
  try {
    const answer = ui.element.querySelector<HTMLDivElement>(".answer")!;
    Object.defineProperties(answer, {
      scrollHeight: { value: 500, configurable: true },
      clientHeight: { value: 400 },
    });
    answer.scrollTop = 100;
    await act(async () =>
      answer.dispatchEvent(new dom.Event("scroll") as unknown as Event),
    );
    await ui.click("展开全部");
    Object.defineProperty(answer, "scrollHeight", { value: 2000 });
    await ui.render({ ...value, model: { ...value.model, toolCalls: [] } });
    expect(answer.scrollTop).toBe(100);
  } finally {
    await ui.close();
  }
});

test("syntax tokens preserve multiline source and fall back for unknown or oversized code", () => {
  const source = '/* first\n second */\nconst 中文 = "<script>";\n';
  const highlighted = codeTokens(source, "typescript");
  expect(highlighted.highlighted).toBe(true);
  expect(highlighted.lines[1]![0]!.classes).toContain("hljs-comment");
  expect(
    highlighted.lines
      .map((line) => line.map((token) => token.value).join(""))
      .join("\n") + "\n",
  ).toBe(source);
  expect(codeTokens(source, "unknown-language").highlighted).toBe(false);
  const large = "a".repeat(100001);
  expect(codeTokens(large, "js").lines[0]![0]!.value).toBe(large);
  expect(codeTokens(large, "js").highlighted).toBe(false);
});

test("line numbers do not alter source and selected code copies without decoration", async () => {
  const value = state("ask-result");
  const source = 'const value = "中文";  \n\t// second line\n';
  value.model.output = "```ts\n" + source + "```";
  const ui = await mount(value);
  try {
    const code = ui.element.querySelector(".highlighted-code")!;
    expect(code.textContent).toBe(source);
    expect(code.querySelectorAll(".code-line")).toHaveLength(2);
    expect(code.querySelector(".hljs-keyword")?.textContent).toBe("const");
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = document.getSelection()!;
    await act(async () => {
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await act(async () =>
      document.dispatchEvent(
        new dom.Event("selectionchange") as unknown as Event,
      ),
    );
    await ui.render({
      ...value,
      model: { ...value.model, reportedTokens: 12 },
    });
    expect(selection.toString()).toBe(source);
    const clipboard = new Map<string, string>();
    const copyEvent = new dom.Event("copy", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(copyEvent, "clipboardData", {
      value: {
        setData: (type: string, text: string) => clipboard.set(type, text),
      },
    });
    await act(async () => code.dispatchEvent(copyEvent as unknown as Event));
    expect(copyEvent.defaultPrevented).toBe(true);
    expect(clipboard.get("text/plain")).toBe(source);
    await ui.click("复制选中内容");
    expect(ui.calls.at(-1)).toEqual({
      command: "copy_text",
      args: { text: source },
    });
    await ui.click("行号");
    expect(code.className).not.toContain("has-line-numbers");
    await ui.click("复制代码");
    expect(ui.calls.at(-1)).toEqual({
      command: "copy_text",
      args: { text: source },
    });
    await act(async () => selection.removeAllRanges());
    await act(async () =>
      document.dispatchEvent(
        new dom.Event("selectionchange") as unknown as Event,
      ),
    );
    expect(ui.element.querySelector(".selection-actions")).toBeNull();
  } finally {
    await ui.close();
  }
});

test("collapsing a long code block reveals the same block", async () => {
  const value = state("ask-result");
  value.model.output = "```text\n" + "line\n".repeat(30) + "```";
  const ui = await mount(value);
  try {
    const block = ui.element.querySelector<HTMLElement>(".code-block")!;
    let revealed = false;
    block.scrollIntoView = () => {
      revealed = true;
    };
    await ui.click("展开全部");
    expect(revealed).toBe(false);
    await ui.click("限制高度");
    expect(revealed).toBe(true);
    expect(block.className).not.toContain("is-expanded");
  } finally {
    await ui.close();
  }
});

test("answer search matches phrases across syntax spans and ignores code controls", async () => {
  const value = state("ask-result");
  value.model.output =
    "```js\nconst answer = 42;\n```\n\nThe answer is 42.\n\n| Name | Value |\n|---|---|\n| answer | 42 |";
  const ui = await mount(value);
  try {
    const root = ui.element.querySelector<HTMLElement>(".answer")!;
    expect(findAnswerMatches(root, "answer")).toHaveLength(3);
    expect(findAnswerMatches(root, "const answer")[0]?.range.toString()).toBe(
      "const answer",
    );
    expect(findAnswerMatches(root, "复制代码")).toHaveLength(0);
    expect(findAnswerMatches(root, ".*")).toHaveLength(0);
    await ui.click("搜索回答");
    await ui.type("answer", '[aria-label="搜索回答内容"]');
    expect(
      ui.element.querySelector('.answer-search [role="status"]')?.textContent,
    ).toBe("1 / 3");
    await ui.click("下一个匹配");
    expect(
      ui.element.querySelector('.answer-search [role="status"]')?.textContent,
    ).toBe("2 / 3");
    await ui.type("missing", '[aria-label="搜索回答内容"]');
    expect(
      ui.element.querySelector('.answer-search [role="status"]')?.textContent,
    ).toBe("无匹配");
    const input = ui.element.querySelector('[aria-label="搜索回答内容"]')!;
    await act(async () =>
      input.dispatchEvent(
        new dom.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }) as unknown as Event,
      ),
    );
    expect(ui.element.querySelector(".answer-search")).toBeNull();
    expect(ui.calls).toHaveLength(0);
  } finally {
    await ui.close();
  }
});

test("code jump validates source lines, marks target and closes locally", async () => {
  const value = state("ask-result");
  value.model.output = "```text\n" + "line\n".repeat(50) + "```";
  const ui = await mount(value);
  try {
    await ui.click("跳行");
    await ui.type("51", '[aria-label="跳转到代码行"]');
    await ui.click("前往");
    expect(ui.element.textContent).toContain("请输入 1–50 的行号");
    await ui.type("42", '[aria-label="跳转到代码行"]');
    const composing = new dom.KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () =>
      ui.element
        .querySelector('[aria-label="跳转到代码行"]')!
        .dispatchEvent(composing as unknown as Event),
    );
    expect(composing.defaultPrevented).toBe(true);
    expect(ui.element.querySelector(".is-target-line")).toBeNull();
    await ui.click("前往");
    expect(
      ui.element.querySelector(".is-target-line")?.getAttribute("data-line"),
    ).toBe("42");
    await ui.click("关闭跳行");
    expect(ui.element.querySelector(".code-jump")).toBeNull();
    expect(ui.calls).toHaveLength(0);
  } finally {
    await ui.close();
  }
});

test("reading positions and code options survive remount without leaking across sessions", async () => {
  const value = state("ask-result");
  value.model.sessionId = "reading-regression";
  value.model.output = "```text\n" + "line\n".repeat(60) + "```";
  let ui = await mount(value);
  try {
    await ui.click("自动换行");
    const answer = ui.element.querySelector<HTMLElement>(".answer")!;
    const pre = ui.element.querySelector<HTMLElement>(".code-block pre")!;
    answer.scrollTop = 240;
    pre.scrollTop = 120;
    pre.scrollLeft = 30;
    await act(async () => {
      answer.dispatchEvent(new dom.Event("scroll") as unknown as Event);
      pre.dispatchEvent(new dom.Event("scroll") as unknown as Event);
    });
    await ui.close();
    ui = await mount(value);
    expect(ui.element.querySelector<HTMLElement>(".answer")!.scrollTop).toBe(
      240,
    );
    expect(
      ui.element.querySelector<HTMLElement>(".code-block pre")!.scrollTop,
    ).toBe(120);
    expect(
      ui.element.querySelector<HTMLElement>(".code-block pre")!.scrollLeft,
    ).toBe(30);
    expect(ui.element.querySelector(".code-block")?.className).toContain(
      "is-wrapped",
    );
    await ui.render({
      ...value,
      model: { ...value.model, sessionId: "another-reading-session" },
    });
    expect(ui.element.querySelector<HTMLElement>(".answer")!.scrollTop).toBe(0);
    expect(ui.element.querySelector(".code-block")?.className).not.toContain(
      "is-wrapped",
    );
  } finally {
    await ui.close();
  }
});

test("explicit search navigation wins over deferred reading restoration in closed details", async () => {
  saveReading("deferred-reading-test", { top: 120, left: 0 });
  function Probe() {
    const ref = React.useRef<HTMLPreElement>(null);
    useReadingPosition(ref, "deferred-reading-test");
    return React.createElement(
      "details",
      null,
      React.createElement("summary", null, "open"),
      React.createElement(
        "pre",
        { ref },
        React.createElement("span", null, "target"),
      ),
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(Probe)));
  try {
    const details = container.querySelector("details")!;
    const pre = container.querySelector("pre")!;
    await act(async () => {
      details.open = true;
      pre.querySelector("span")!.dispatchEvent(
        new dom.Event("reading-navigation", {
          bubbles: true,
        }) as unknown as Event,
      );
      pre.scrollTop = 42;
      details.dispatchEvent(new dom.Event("toggle") as unknown as Event);
    });
    expect(pre.scrollTop).toBe(42);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("history browsing cannot replace the current answer code position", async () => {
  const value = state("ask-result");
  value.model.sessionId = "separate-reading";
  value.model.sessionReady = true;
  const output = "```text\n" + "line\n".repeat(60) + "```";
  const ui = await mount(
    value,
    catalog,
    undefined,
    undefined,
    undefined,
    async () => ({
      turns: [
        {
          id: "turn",
          question: "Q",
          output,
          thinkingOutput: "",
          toolCalls: [],
        },
      ],
    }),
  );
  try {
    const current = ui.element.querySelector<HTMLElement>(".code-block pre")!;
    current.scrollTop = 120;
    await act(async () =>
      current.dispatchEvent(new dom.Event("scroll") as unknown as Event),
    );
    await ui.click("会话记录 · 0");
    const history = ui.element.querySelector<HTMLElement>(".code-block pre")!;
    expect(history.scrollTop).toBe(0);
    history.scrollTop = 30;
    await act(async () =>
      history.dispatchEvent(new dom.Event("scroll") as unknown as Event),
    );
    await ui.click("当前回答");
    expect(
      ui.element.querySelector<HTMLElement>(".code-block pre")!.scrollTop,
    ).toBe(120);
  } finally {
    await ui.close();
  }
});

test("active task identity keeps cancellation available and blocks followups after a phase change", async () => {
  for (const phase of ["ready", "error"] as const) {
    const value = state("ask-result");
    value.model.phase = phase;
    value.model.taskId = 17;
    const ui = await mount(value);
    try {
      await ui.type("Retained followup");
      await ui.key("Enter");
      expect(ui.calls).toEqual([]);
      expect(
        ui.element.querySelector('[aria-label="停止生成"]'),
      ).not.toBeNull();
      await ui.click("停止生成");
      expect(ui.calls).toEqual([{ command: "cancel_task", args: undefined }]);
      await ui.render({
        ...value,
        model: { ...value.model, taskId: null, phase: "ready" },
      });
      await ui.key("Enter");
      expect(ui.calls.at(-1)).toEqual({
        command: "ask_question",
        args: { question: "Retained followup" },
      });
    } finally {
      await ui.close();
    }
  }
});

test("provider settings retain a failed key for retry and clear it only after success", async () => {
  let saved = false;
  const ui = await mount(state("settings"), catalog, async () => saved);
  try {
    await ui.click("模型与服务商");
    await ui.type("synthetic-retry-key", "#api-key");
    await ui.click("保存凭证");
    expect(ui.element.querySelector<HTMLInputElement>("#api-key")!.value).toBe(
      "synthetic-retry-key",
    );
    expect(ui.element.textContent).not.toContain("synthetic-retry-key");
    saved = true;
    await ui.click("保存凭证");
    expect(ui.element.querySelector<HTMLInputElement>("#api-key")!.value).toBe(
      "",
    );
  } finally {
    await ui.close();
  }
});

test("truncated and incomplete results retain text and show recovery guidance in reading and Ask", async () => {
  for (const phase of ["truncated", "incomplete", "error"]) {
    for (const mode of ["translation", "ask-result"] as const) {
      const value = state("ask-result");
      value.desktop = {
        ...value.desktop,
        mode,
        operation: "translate",
        translation: "PARTIAL_ANSWER",
      };
      value.model = {
        ...value.model,
        phase,
        taskId: null,
        output: "PARTIAL_ANSWER",
        message: "输出未完成，请分段提交。",
      };
      const ui = await mount(value);
      try {
        expect(ui.element.textContent).toContain("PARTIAL_ANSWER");
        expect(ui.element.textContent).toContain("输出未完成，请分段提交。");
        expect(
          [...ui.element.querySelectorAll("button")].some(
            (button) => button.textContent === "停止",
          ),
        ).toBe(false);
      } finally {
        await ui.close();
      }
    }
  }
});
test("history ignores search responses that arrive after the query changes", async () => {
  let finish!: (value: Awaited<ReturnType<LoadSessions>>) => void;
  const delayed = new Promise<Awaited<ReturnType<LoadSessions>>>((resolve) => {
    finish = resolve;
  });
  const item = (id: string) => ({
    id,
    title: id,
    modified: "2026-10-21T00:00:00Z",
    messageCount: 1,
  });
  const load: LoadSessions = async (_offset, query) =>
    query === "old" ? delayed : { sessions: [item("new")], total: 1 };
  const ui = await mount(state("input"), catalog, undefined, undefined, load);
  try {
    await ui.type("/resume old");
    await ui.key("Enter");
    await ui.type("new");
    await act(async () => {
      finish({ sessions: [item("old")], total: 1 });
      await delayed;
    });
    expect(ui.element.querySelector("strong")?.title).toBe("new");
  } finally {
    await ui.close();
  }
});

test("an empty incomplete translation stops loading and preserves the safe failure message", async () => {
  const value = state("ask-result");
  value.desktop = {
    ...value.desktop,
    mode: "translation",
    operation: "translate",
    translation: "",
  };
  value.model = {
    ...value.model,
    phase: "incomplete",
    taskId: null,
    output: "",
    message: "模型未正常结束，请重试。",
  };
  const ui = await mount(value);
  try {
    expect(ui.element.querySelector(".loading")).toBeNull();
    expect(ui.element.textContent).toContain("模型未正常结束，请重试。");
  } finally {
    await ui.close();
  }
});

test("Windows OCR runtime failure offers the official repair link without submitting text", async () => {
  const value = state("input");
  value.shortcuts = { ...value.shortcuts, macos: false, ocr: true };
  const ui = await mount(value, catalog, async (command) => {
    if (command === "capture_ocr") throw "ocr_runtime_unavailable";
  });
  try {
    await ui.type("/ocr");
    await ui.key("Enter");
    expect(ui.element.textContent).toContain("Visual C++");
    await ui.click("下载官方 x64 运行库");
    expect(ui.calls).toEqual([
      { command: "capture_ocr", args: undefined },
      {
        command: "open_external_url",
        args: { url: "https://aka.ms/vs/17/release/vc_redist.x64.exe" },
      },
    ]);
  } finally {
    await ui.close();
  }
});

test("Windows OCR exposes the command, floating menu and six shortcut fields independently of macOS notation", async () => {
  const value = state("input");
  value.shortcuts = {
    ...value.shortcuts,
    macos: false,
    ocr: true,
    registered: [true, true, true, true, true, true],
  };
  const ui = await mount(value);
  try {
    await ui.type("/ocr");
    await ui.key("Enter");
    expect(ui.calls).toEqual([{ command: "capture_ocr", args: undefined }]);
    await ui.render({ ...value, desktop: { ...value.desktop, mode: "menu" } });
    expect(ui.element.textContent).toContain("截图翻译");
    expect(ui.element.textContent).toContain("Alt+Shift+O");
    expect(ui.element.textContent).not.toContain("⌥");
    await ui.click("截图翻译Alt+Shift+O");
    expect(ui.calls.at(-1)?.command).toBe("capture_ocr");
    await ui.render({
      ...value,
      desktop: { ...value.desktop, mode: "settings" },
    });
    await ui.click("快捷键");
    expect(ui.element.querySelectorAll(".shortcut-row")).toHaveLength(6);
    expect(
      ui.element.querySelector<HTMLInputElement>("#shortcut-ocr")?.value,
    ).toBe("Alt+Shift+O");
  } finally {
    await ui.close();
  }
});
function observedFrames() {
  const previousObserver = globalThis.ResizeObserver;
  const previousWindowObserver = window.ResizeObserver;
  const previousRequest = window.requestAnimationFrame;
  const previousCancel = window.cancelAnimationFrame;
  const observers: {
    callback: () => void;
    targets: Element[];
    disconnected: boolean;
  }[] = [];
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  class Observer {
    record: (typeof observers)[number];
    constructor(callback: () => void) {
      this.record = { callback, targets: [], disconnected: false };
      observers.push(this.record);
    }
    observe(target: Element) {
      this.record.targets.push(target);
    }
    unobserve() {}
    disconnect() {
      this.record.disconnected = true;
    }
  }
  globalThis.ResizeObserver = window.ResizeObserver =
    Observer as unknown as typeof ResizeObserver;
  window.requestAnimationFrame = (callback) => {
    frames.set(++sequence, callback);
    return sequence;
  };
  window.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
  return {
    observers,
    frames,
    flush() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    },
    restore() {
      globalThis.ResizeObserver = previousObserver;
      window.ResizeObserver = previousWindowObserver;
      window.requestAnimationFrame = previousRequest;
      window.cancelAnimationFrame = previousCancel;
    },
  };
}

test("Ask observes width only and defers textarea layout outside observer delivery", async () => {
  const scheduler = observedFrames();
  const ui = await mount(state("ask"));
  try {
    const observer = scheduler.observers.find((item) =>
      item.targets.some((target) =>
        target.contains(ui.element.querySelector("textarea")),
      ),
    )!;
    const parent = observer.targets[0]!;
    const field = ui.element.querySelector("textarea")!;
    let width = 0;
    let reads = 0;
    parent.getBoundingClientRect = () => ({ width }) as DOMRect;
    Object.defineProperty(field, "scrollHeight", {
      configurable: true,
      get: () => {
        reads++;
        return 80;
      },
    });
    observer.callback();
    expect(reads).toBe(0);
    expect(scheduler.frames.size).toBe(0);
    width = 360;
    observer.callback();
    observer.callback();
    expect(reads).toBe(0);
    expect(scheduler.frames.size).toBe(1);
    await act(async () => scheduler.flush());
    expect(reads).toBe(1);
    expect(field.style.height).toBe("80px");
    observer.callback();
    expect(scheduler.frames.size).toBe(0);
    width = 400;
    observer.callback();
    const stale = [...scheduler.frames.values()][0]!;
    await ui.close();
    expect(scheduler.frames.size).toBe(0);
    stale(0);
    observer.callback();
    expect(reads).toBe(1);
    expect(observer.disconnected).toBe(true);
  } finally {
    if (ui.element.isConnected) await ui.close();
    scheduler.restore();
  }
});

test("reading coalesces layout feedback and fences stale frames on epoch change and unmount", async () => {
  const scheduler = observedFrames();
  const value = state("ask-result");
  value.desktop.mode = "translation";
  value.desktop.translation = "READING";
  const ui = await mount(value);
  try {
    const root = ui.element.querySelector<HTMLElement>(".reading")!;
    const viewport = ui.element.querySelector<HTMLElement>(".annotation")!;
    const copy = ui.element.querySelector<HTMLElement>(".translation-copy")!;
    root.getBoundingClientRect = () => ({ height: 140.5 }) as DOMRect;
    viewport.getBoundingClientRect = () => ({ height: 100.5 }) as DOMRect;
    Object.defineProperty(copy, "scrollHeight", { get: () => 200 });
    expect(
      ui.calls.filter((call) => call.command === "resize_translation"),
    ).toHaveLength(0);
    await act(async () => scheduler.flush());
    expect(
      ui.calls.filter((call) => call.command === "resize_translation"),
    ).toEqual([
      {
        command: "resize_translation",
        args: { epoch: value.desktop.epoch, height: 240 },
      },
    ]);
    const observer = scheduler.observers[0]!;
    observer.callback();
    observer.callback();
    expect(scheduler.frames.size).toBe(1);
    await act(async () => scheduler.flush());
    expect(
      ui.calls.filter((call) => call.command === "resize_translation"),
    ).toHaveLength(1);
    observer.callback();
    const stale = [...scheduler.frames.values()][0]!;
    await ui.render({
      ...value,
      desktop: { ...value.desktop, epoch: value.desktop.epoch + 1 },
    });
    stale(0);
    expect(
      ui.calls.filter((call) => call.command === "resize_translation"),
    ).toHaveLength(1);
    await act(async () => scheduler.flush());
    expect(
      ui.calls.filter((call) => call.command === "resize_translation").at(-1)
        ?.args,
    ).toEqual({ epoch: value.desktop.epoch + 1, height: 240 });
    const current = scheduler.observers.at(-1)!;
    current.callback();
    const afterUnmount = [...scheduler.frames.values()][0]!;
    await ui.close();
    expect(scheduler.frames.size).toBe(0);
    afterUnmount(0);
    current.callback();
    expect(
      ui.calls.filter((call) => call.command === "resize_translation"),
    ).toHaveLength(2);
  } finally {
    if (ui.element.isConnected) await ui.close();
    scheduler.restore();
  }
});
