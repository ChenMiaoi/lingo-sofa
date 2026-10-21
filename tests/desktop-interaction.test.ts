import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { Desktop } from "../apps/desktop/src/view";
import {
  initialState,
  type DesktopState,
  type ModelCatalog,
} from "../apps/desktop/src/api";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
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
) {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const perform = async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
  };
  const render = async (value: DesktopState) => {
    await act(async () =>
      root.render(
        React.createElement(Desktop, {
          state: value,
          perform,
          loadModelCatalog: loadCatalog,
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
    expect(ui.element.querySelector("input")!.value).toBe("");
    expect(ui.element.querySelector("input")!.placeholder).toBe(
      "继续追问这段内容",
    );
    await ui.key("Enter");
    expect(ui.calls).toHaveLength(1);
    await ui.type("Keep this follow-up draft.");
    await ui.render({
      ...answer,
      model: { ...answer.model, phase: "running", output: "MAPLE" },
    });
    expect(ui.element.querySelector("input")!.value).toBe(
      "Keep this follow-up draft.",
    );
    await ui.render(state("ask-result", 3));
    expect(ui.element.querySelector("input")!.value).toBe("");
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
      expect(input.value).toBe(
        mode === "input"
          ? "Keep my unsent draft.\n第二行"
          : "Keep my unsent draft.第二行",
      );
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
