import { themeStyles, themeAliases } from "@lingo-sofa/ui-shared";
import { bindAppearance } from "./appearance.js";
import { browser } from "wxt/browser";
import { BLOCKS, extract, type PageProgress } from "@lingo-sofa/web-extraction";
export interface PageControlActions {
  translateSelection: () => Promise<unknown>;
  translatePage: () => void;
  ask: () => void;
  settings: () => Promise<unknown>;
  enabled: (enabled: boolean) => Promise<void>;
  paragraph: (element: HTMLElement) => void;
  language: (language: string) => Promise<void>;
  model: (model: string) => Promise<void>;
  automatic: (enabled: boolean) => Promise<unknown>;
  configuration: () => Promise<{
    maxOutputTokens?: number;
    readingEnabled: boolean;
    model: string;
    providerName: string;
    models: string[];
    automatic: boolean;
    targetLanguage: string;
  }>;
}
export function createPageControls(
  document: Document,
  actions: PageControlActions,
) {
  const host = document.createElement("div");
  host.setAttribute("data-lingo-sofa", "controls");
  const unbindAppearance = bindAppearance(host);
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>

:host{all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;${themeAliases}font:14px/1.6 system-ui,sans-serif;color:var(--ink)}
*{box-sizing:border-box}button,input,select{font:inherit;color:inherit}button{cursor:pointer;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:7px 10px}button:hover{background:var(--soft)}button:disabled,input:disabled,select:disabled{opacity:.5;cursor:wait}:focus-visible{outline:3px solid var(--accent);outline-offset:3px}[hidden]{display:none!important}
.dock{position:fixed;right:16px;top:68%;pointer-events:auto}.launcher img{filter:grayscale(1)}.launcher{height:48px;width:48px;border-radius:50%;display:grid;place-items:center;padding:0;touch-action:none;box-shadow:0 2px 8px #00000008;font-size:21px}.pane{position:absolute;right:0;bottom:54px;width:320px;max-width:calc(100vw - 32px);padding:18px;background:var(--bg);border:1px solid var(--line);border-radius:14px;box-shadow:0 8px 28px #0002;overflow:auto}.heading{display:flex;gap:12px;align-items:center;justify-content:space-between;padding-bottom:14px;border-bottom:1px solid var(--line)}.heading>div{min-width:0}.heading strong{display:block;font-size:16px}.site{display:block;font-size:12px;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.close{border:0;width:30px;height:30px;padding:0;background:transparent;font-size:22px;flex-shrink:0}.field{display:block;margin:14px 0 0;font-size:13px;font-weight:600}.field-heading{display:flex;justify-content:space-between;gap:12px}.provider{font-size:12px;font-weight:400;opacity:.75}select{display:block;width:100%;min-height:40px;padding:8px 10px;margin-top:6px;background:var(--bg);border:1px solid var(--line);border-radius:8px;font-size:14px;font-weight:400}.auto-row{display:flex;justify-content:space-between;align-items:center;gap:16px;border-top:1px solid var(--line);margin-top:14px;padding-top:14px}.auto-row strong,.hint{display:block}.hint,.notice{font-size:12px;opacity:.8}.automatic{appearance:none;width:38px;height:22px;margin:0;padding:2px;border:1px solid var(--line);border-radius:20px;background:var(--ls-muted);flex-shrink:0;cursor:pointer}.automatic:before{content:"";display:block;width:16px;height:16px;border-radius:50%;background:var(--ls-toggle-knob);transition:transform .15s ease}.automatic:checked{background:var(--accent);border-color:transparent}.automatic:checked:before{background:var(--ls-on-accent);transform:translateX(16px)}.notice{overflow-wrap:anywhere;margin:12px 0 0}.notice:empty{display:none}.paragraph{position:fixed;pointer-events:auto;padding:4px 7px;border-radius:8px;font-size:12px;box-shadow:0 2px 8px #0002}@media(prefers-reduced-motion:reduce){.automatic:before{transition:none}}
${themeStyles(":host")}
</style><div class="dock"><button class="launcher" type="button" aria-label="LingoSofa 页面控制，可拖动或用方向键移动" aria-keyshortcuts="Alt+L" title="打开 LingoSofa · Alt L" aria-expanded="false"><img src="${browser.runtime.getURL("/brand/figma/orb.svg")}" alt=""></button><section class="pane" aria-label="LingoSofa 页面控制" hidden><div class="heading"><div><strong>LingoSofa</strong><span class="site"></span></div><button class="close" type="button" aria-label="收起页面控制">×</button></div><label class="auto-row"><span><strong>双语阅读</strong><span class="hint reading-hint">已开启 · 译文显示在原文下方</span></span><input class="reading automatic" type="checkbox" role="switch" aria-label="开启双语阅读" checked></label><label class="field">目标语言<select class="language" aria-label="目标语言"></select></label><label class="field"><span class="field-heading">模型<span class="provider"></span></span><select class="model" aria-label="模型"><option>连接中…</option></select></label><label class="auto-row"><span><strong>自动翻译</strong><span class="hint">此网站的可见正文与新内容</span></span><input class="automatic" type="checkbox" role="switch" aria-label="自动翻译此网站"></label><p class="notice" role="status"></p></section></div><button class="paragraph" type="button" aria-label="翻译这一段" hidden>译</button>`;
  const menu = document.createElement("section");
  menu.className = "pane command-menu";
  menu.hidden = true;
  menu.setAttribute("aria-label", "LingoSofa 快捷菜单");
  const menuStyle = document.createElement("style");
  menuStyle.textContent = `.command-menu{width:240px;padding:8px}.menu-brand{display:flex;align-items:center;gap:10px;padding:6px;font-size:13px;color:var(--accent);border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:6px}.menu-brand img,.command-menu button img{filter:grayscale(1);display:block;flex-shrink:0}.command-menu .command{display:flex;align-items:flex-start;gap:12px;width:100%;padding:10px;border:0;background:transparent;text-align:left;min-height:60px}.command strong{display:block;font-size:14px;font-weight:500;line-height:21px}.command small{display:block;font-size:12px;line-height:18px;color:var(--ls-muted);margin-top:3px}.command-menu .reading-preferences{width:100%;font-size:11px;border:0;border-top:1px solid var(--line);border-radius:0;margin-top:6px;background:transparent;color:var(--ls-muted)}`;
  const brand = document.createElement("div");
  brand.className = "menu-brand";
  const mark = document.createElement("img");
  mark.src = browser.runtime.getURL("/brand/figma/menu-mark.svg");
  mark.alt = "";
  brand.append(mark, "LingoSofa");
  menu.append(brand);
  const menuNotice = document.createElement("p");
  menuNotice.className = "notice";
  menuNotice.setAttribute("role", "status");
  const menuButtons: HTMLButtonElement[] = [];
  const items = [
    ["翻译选中内容", "先选中文字", "globe", actions.translateSelection],
    ["翻译整页", "保留原文 · 译文在下", "globe", actions.translatePage],
    ["Ask", "带着所选内容开始对话", "menu-chat", actions.ask],
    ["设置", "模型、语言与快捷键", "settings", actions.settings],
  ] as const;
  for (const [title, hint, icon, action] of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "command";
    button.setAttribute("aria-label", title);
    const img = document.createElement("img");
    img.src = browser.runtime.getURL(`/brand/figma/${icon}.svg`);
    img.alt = "";
    const text = document.createElement("span");
    const label = document.createElement("strong");
    label.textContent = title;
    const description = document.createElement("small");
    description.textContent = hint;
    text.append(label, description);
    button.append(img, text);
    button.onpointerdown = (event) => event.preventDefault();
    button.onclick = () => {
      toggle(false);
      void Promise.resolve()
        .then(action)
        .catch(() => {
          toggle(true);
          menuNotice.textContent = "操作失败，请重试。";
        });
    };
    menu.append(button);
    menuButtons.push(button);
  }
  const preferences = document.createElement("button");
  preferences.type = "button";
  preferences.className = "reading-preferences";
  preferences.textContent = "阅读偏好";
  preferences.onclick = () => {
    panel.hidden = true;
    panel = readingPanel;
    toggle(true);
  };
  menu.append(preferences, menuNotice);
  shadow.append(menuStyle);
  shadow.querySelector(".dock")!.append(menu);
  shadow.addEventListener(
    "click",
    (event) => {
      if (!event.isTrusted) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  shadow.addEventListener(
    "change",
    (event) => {
      if (!event.isTrusted) event.stopImmediatePropagation();
    },
    true,
  );
  document.body.append(host);
  const dock = shadow.querySelector<HTMLElement>(".dock")!;
  const readingPanel = shadow.querySelector<HTMLElement>(".pane")!;
  let panel: HTMLElement = menu;
  const launcher = shadow.querySelector<HTMLButtonElement>(".launcher")!;
  const model = shadow.querySelector<HTMLSelectElement>(".model")!;
  const reading = shadow.querySelector<HTMLInputElement>(".reading")!;
  const automatic = shadow.querySelector<HTMLInputElement>(
    ".auto-row:not(:has(.reading)) .automatic",
  )!;
  let readingEnabled = true;
  function setEnabled(value: boolean) {
    readingEnabled = value;
    reading.checked = value;
    language.disabled = model.disabled = automatic.disabled = !value;
    shadow.querySelector<HTMLElement>(".reading-hint")!.textContent = value
      ? "已开启 · 译文显示在原文下方"
      : "已关闭 · 仅显示原文";
    menuButtons[0]!.disabled =
      !value || !document.getSelection()?.toString().trim();
    menuButtons[1]!.disabled = menuButtons[2]!.disabled = !value;
    if (!value) paragraph.hidden = true;
  }
  const language = shadow.querySelector<HTMLSelectElement>(".language")!;
  for (const name of [
    "简体中文",
    "繁體中文",
    "English",
    "日本語",
    "한국어",
    "Français",
    "Deutsch",
    "Español",
    "Português",
    "Italiano",
    "Русский",
    "العربية",
    "हिन्दी",
    "ไทย",
    "Tiếng Việt",
    "Bahasa Indonesia",
  ]) {
    const option = document.createElement("option");
    option.textContent = name;
    language.append(option);
  }
  shadow.querySelector<HTMLElement>(".site")!.textContent =
    document.location.hostname;
  const paragraph = shadow.querySelector<HTMLButtonElement>(".paragraph")!;
  const notice = shadow.querySelector<HTMLElement>(".notice")!;
  let hovered: HTMLElement | undefined;
  let dragged = false;
  let origin: { x: number; y: number; top: number } | undefined;
  const view = document.defaultView!;
  function positionPanel() {
    panel.style.left = dock.style.left ? "0" : "auto";
    panel.style.right = dock.style.left ? "auto" : "0";
    const top = dock.getBoundingClientRect().top;
    const below = top < view.innerHeight / 2;
    panel.style.maxHeight = `${Math.max(64, below ? view.innerHeight - top - 70 : top - 70)}px`;
    panel.style.top = below ? "54px" : "auto";
    panel.style.bottom = below ? "auto" : "54px";
  }
  function toggle(open: boolean) {
    panel.hidden = !open;
    launcher.setAttribute("aria-expanded", String(open));
    if (open) {
      const selected = Boolean(document.getSelection()?.toString().trim());
      menuButtons[0]!.disabled = !readingEnabled || !selected;
      menuButtons[1]!.disabled = menuButtons[2]!.disabled = !readingEnabled;
      menuButtons[0]!.querySelector("small")!.textContent = selected
        ? "仅翻译所选文字"
        : "先选中文字";
      positionPanel();
      model.disabled = true;
      void actions
        .configuration()
        .then((info) => {
          if (!host.isConnected) return;
          model.replaceChildren();
          for (const id of [...new Set([info.model, ...info.models])]) {
            const option = document.createElement("option");
            option.textContent = id;
            model.append(option);
          }
          model.value = info.model;
          automatic.checked = info.automatic;
          language.value = info.targetLanguage;
          shadow.querySelector<HTMLElement>(".provider")!.textContent =
            info.providerName;
          setEnabled(info.readingEnabled);
          notice.textContent = "";
        })
        .catch(() => {
          notice.textContent = "模型连接不可用，请检查扩展的供应商设置。";
        });
    }
  }
  launcher.onclick = () => {
    if (!dragged) {
      const opening = panel.hidden;
      panel.hidden = true;
      panel = menu;
      toggle(opening);
    }
    dragged = false;
  };
  shadow.querySelector<HTMLButtonElement>(".close")!.onclick = () => {
    toggle(false);
    launcher.focus();
  };
  model.addEventListener("change", () => {
    model.disabled = true;
    void actions
      .model(model.value)
      .then(() => {
        notice.textContent = "模型已切换";
      })
      .catch(() => {
        notice.textContent = "切换失败，请等当前翻译完成后重试。";
        void actions
          .configuration()
          .then((info) => {
            model.value = info.model;
          })
          .catch(() => undefined);
      })
      .finally(() => {
        model.disabled = !readingEnabled;
      });
  });
  reading.addEventListener("change", () => {
    const value = reading.checked;
    reading.disabled = true;
    void actions
      .enabled(value)
      .then(() => {
        setEnabled(value);
        notice.textContent = value
          ? "双语阅读已开启"
          : "双语阅读已关闭，已恢复原文";
      })
      .catch(() => {
        reading.checked = readingEnabled;
        notice.textContent = "更新失败，请重试";
      })
      .finally(() => {
        reading.disabled = false;
      });
  });
  automatic.addEventListener("change", () => {
    const enabled = automatic.checked;
    automatic.disabled = true;
    void actions
      .automatic(enabled)
      .then(() => {
        notice.textContent = enabled
          ? "自动翻译已开启"
          : "自动翻译已暂停，已有译文保留";
      })
      .catch((reason: unknown) => {
        automatic.checked = !enabled;
        notice.textContent =
          reason instanceof Error
            ? reason.message
            : "自动翻译更新失败，请重试。";
      })
      .finally(() => {
        automatic.disabled = !readingEnabled;
      });
  });
  language.addEventListener("change", () => {
    const value = language.value;
    language.disabled = true;
    void actions
      .language(value)
      .catch((error: unknown) => {
        notice.textContent =
          error instanceof Error ? error.message : "语言更新失败";
      })
      .finally(() => {
        language.disabled = !readingEnabled;
      });
  });
  paragraph.addEventListener("pointerdown", (event) => event.preventDefault());
  paragraph.addEventListener("click", () => {
    if (hovered?.isConnected) actions.paragraph(hovered);
  });
  const hover = (event: PointerEvent) => {
    if (
      !readingEnabled ||
      !(event.target instanceof Element) ||
      event.target.closest("[data-lingo-sofa]")
    )
      return;
    const element = event.target.closest<HTMLElement>(BLOCKS);
    if (
      !element ||
      !extract(element).some((block) => block.element === element)
    ) {
      paragraph.hidden = true;
      hovered = undefined;
      return;
    }
    hovered = element;
    const bounds = element.getBoundingClientRect();
    paragraph.style.top = `${Math.max(8, Math.min(bounds.top, view.innerHeight - 34))}px`;
    paragraph.style.left = `${Math.max(8, Math.min(bounds.right - 28, view.innerWidth - 36))}px`;
    paragraph.hidden = false;
  };
  const hideHover = () => {
    paragraph.hidden = true;
  };
  const key = (event: KeyboardEvent) => {
    if (event.altKey && event.code === "KeyL") {
      event.preventDefault();
      const opening = panel.hidden;
      panel.hidden = true;
      panel = menu;
      toggle(opening);
      if (opening)
        menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
      else launcher.focus();
    }
    if (event.key === "Escape" && !panel.hidden) {
      toggle(false);
      launcher.focus();
    }
  };
  document.addEventListener("pointerover", hover);
  view.addEventListener("scroll", hideHover, true);
  document.addEventListener("keydown", key);
  launcher.onpointerdown = (event) => {
    origin = {
      x: event.clientX,
      y: event.clientY,
      top: dock.getBoundingClientRect().top,
    };
    dragged = false;
    launcher.setPointerCapture(event.pointerId);
  };
  launcher.onpointermove = (event) => {
    if (
      !origin ||
      Math.abs(event.clientX - origin.x) + Math.abs(event.clientY - origin.y) <
        6
    )
      return;
    dragged = true;
    toggle(false);
    dock.style.top = `${Math.max(16, Math.min(origin.top + event.clientY - origin.y, view.innerHeight - 60))}px`;
    dock.style.left = event.clientX < view.innerWidth / 2 ? "16px" : "";
    dock.style.right = dock.style.left ? "auto" : "16px";
  };
  launcher.onpointerup = () => {
    origin = undefined;
  };
  launcher.onpointercancel = () => {
    origin = undefined;
  };
  launcher.onkeydown = (event) => {
    if (["ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      dock.style.top = `${Math.max(16, Math.min(dock.getBoundingClientRect().top + (event.key === "ArrowUp" ? -24 : 24), view.innerHeight - 60))}px`;
      positionPanel();
    }
  };
  return {
    open() {
      panel.hidden = true;
      panel = readingPanel;
      toggle(true);
    },
    update(next: PageProgress) {
      if (next.failed)
        notice.textContent = `${next.failed} 段未能翻译${next.error ? `：${next.error}` : ""}。可悬停段落重试。`;
    },
    setEnabled,
    setLanguage(value: string) {
      if (![...language.options].some((option) => option.value === value)) {
        const option = document.createElement("option");
        option.textContent = value;
        language.append(option);
      }
      language.value = value;
    },
    setAutomatic(value: boolean) {
      automatic.checked = value;
    },
    setNotice(value: string) {
      notice.textContent = value;
    },
    destroy() {
      document.removeEventListener("pointerover", hover);
      view.removeEventListener("scroll", hideHover, true);
      document.removeEventListener("keydown", key);
      unbindAppearance();
      host.remove();
    },
  };
}
