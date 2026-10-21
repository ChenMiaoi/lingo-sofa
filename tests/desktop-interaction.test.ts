import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { Desktop, type Perform } from "../apps/desktop/src/view";
import { App } from "../apps/desktop/src/app";
import {
  initialState,
  type DesktopState,
  type ModelCatalog,
  type RequestLogin,
  type LoadSessions,
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
  onPerform?: Perform,
  requestLogin?: RequestLogin,
  loadSessions?: LoadSessions,
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
      "继续追问，或 / 打开命令",
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
    ).toBe("0/3 已启用");
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
    expect(ui.element.querySelector<HTMLInputElement>("input")?.value).toBe("");
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
    expect(ui.element.querySelector<HTMLInputElement>("input")?.value).toBe(
      "/login anthropic",
    );
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
