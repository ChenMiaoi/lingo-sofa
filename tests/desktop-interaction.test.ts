import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { Desktop } from "../apps/desktop/src/view";
import { initialState, type DesktopState } from "../apps/desktop/src/api";

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
async function mount(initial: DesktopState) {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const perform = async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
  };
  const render = async (value: DesktopState) => {
    await act(async () =>
      root.render(React.createElement(Desktop, { state: value, perform })),
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
    async type(value: string, selector = "input, textarea") {
      const input = element.querySelector(selector)!;
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
      const input = element.querySelector("input, textarea")!;
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
