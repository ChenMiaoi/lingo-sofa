import { BLOCKS, extract, type PageProgress } from "@lingo-sofa/web-extraction";
export interface PageControlActions {
  page: () => void;
  pause: () => void;
  resume: () => void;
  restore: () => void;
  paragraph: (element: HTMLElement) => void;
  ask: () => void;
  language: (language: string) => Promise<void>;
  options: () => void;
}
export function createPageControls(
  document: Document,
  actions: PageControlActions,
) {
  const host = document.createElement("div");
  host.setAttribute("data-lingo-sofa", "controls");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>
:host{all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;color-scheme:light dark;--bg:light-dark(#ffffff,#26332c);--ink:light-dark(#213d2d,#e4efe7);--line:light-dark(#d7e2da,#485a4e);--soft:light-dark(#edf4ef,#31483a);--accent:light-dark(#34674c,#a4d8b5);--on-accent:light-dark(#ffffff,#172b1e);font:14px/1.5 system-ui,sans-serif;color:var(--ink)}
*{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:7px 10px}button:hover{background:var(--soft)}button:disabled{opacity:.5;cursor:default}:focus-visible{outline:3px solid var(--accent);outline-offset:3px}[hidden]{display:none!important}
.dock{position:fixed;right:16px;top:68%;pointer-events:auto}.launcher{height:44px;width:44px;border-radius:15px;touch-action:none;box-shadow:0 4px 16px #0002;background:var(--soft);font-size:21px}.pane{position:absolute;right:0;bottom:54px;width:280px;max-width:calc(100vw - 32px);padding:16px;background:var(--bg);border:1px solid var(--line);border-radius:12px;box-shadow:0 8px 28px #0002;max-height:calc(100vh - 80px);overflow:auto}.heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.close{border:0;padding:2px 6px;background:transparent}.language{display:block;margin:12px 0}select{display:block;width:100%;padding:7px;margin-top:5px;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:6px}.primary{display:block;width:100%;background:var(--accent);color:var(--on-accent);border-color:var(--accent)}.primary:hover{background:var(--accent)}.primary.restoring,.primary.restoring:hover{background:var(--soft);color:var(--ink);border-color:var(--line)}progress{width:100%;accent-color:var(--accent)}.progress-text{font-size:12px;margin:9px 0 4px}.extras{border-top:1px solid var(--line);margin-top:12px;padding-top:10px}summary{cursor:pointer}.extras button{margin:8px 6px 0 0;font-size:12px}.notice{font-size:12px;overflow-wrap:anywhere;margin:8px 0}.paragraph{position:fixed;pointer-events:auto;padding:4px 7px;border-radius:8px;font-size:12px;box-shadow:0 2px 8px #0002}
</style><div class="dock"><button class="launcher" type="button" aria-label="LingoSofa 页面控制，可拖动或用方向键移动" aria-expanded="false">🛋</button><section class="pane" aria-label="LingoSofa 页面控制" hidden><div class="heading"><strong>LingoSofa</strong><button class="close" type="button" aria-label="收起页面控制">×</button></div><label class="language">目标语言<select aria-label="目标语言"><option>简体中文</option><option>English</option><option>日本語</option><option>한국어</option></select></label><button class="primary" type="button">翻译整页</button><div class="progress-area" hidden><p class="progress-text" role="status"></p><progress aria-label="已发现段落翻译进度" max="1" value="0"></progress></div><p class="notice" role="status"></p><details class="extras"><summary>更多操作</summary><button class="restore" type="button">恢复原文</button><button class="ask" type="button">解释 / Ask Pi</button><button class="options" type="button">设置与用量</button></details></section></div><button class="paragraph" type="button" aria-label="翻译这一段" hidden>译</button>`;
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
  const panel = shadow.querySelector<HTMLElement>(".pane")!;
  const launcher = shadow.querySelector<HTMLButtonElement>(".launcher")!;
  const primary = shadow.querySelector<HTMLButtonElement>(".primary")!;
  const language = shadow.querySelector<HTMLSelectElement>("select")!;
  const paragraph = shadow.querySelector<HTMLButtonElement>(".paragraph")!;
  const notice = shadow.querySelector<HTMLElement>(".notice")!;
  let progress: PageProgress = {
    active: false,
    paused: false,
    total: 0,
    completed: 0,
    pending: 0,
    failed: 0,
  };
  let mode: "page" | "manual" = "manual";
  let hovered: HTMLElement | undefined;
  let dragged = false;
  let origin: { x: number; y: number; top: number } | undefined;
  const view = document.defaultView!;
  function positionPanel() {
    panel.style.left = dock.style.left ? "0" : "auto";
    panel.style.right = dock.style.left ? "auto" : "0";
    const below = dock.getBoundingClientRect().top < panel.offsetHeight + 16;
    panel.style.top = below ? "54px" : "auto";
    panel.style.bottom = below ? "auto" : "54px";
  }
  function toggle(open: boolean) {
    panel.hidden = !open;
    launcher.setAttribute("aria-expanded", String(open));
    if (open) positionPanel();
  }
  launcher.onclick = () => {
    if (!dragged) toggle(panel.hidden);
    dragged = false;
  };
  shadow.querySelector<HTMLButtonElement>(".close")!.onclick = () => {
    toggle(false);
    launcher.focus();
  };
  const primaryAction = () =>
    mode !== "page" || !progress.active
      ? actions.page
      : progress.paused
        ? actions.resume
        : progress.pending > 0
          ? actions.pause
          : actions.restore;
  let pressedAction: (() => void) | undefined;
  primary.onpointerdown = () => {
    pressedAction = primaryAction();
  };
  primary.onkeydown = (event) => {
    if (["Enter", " "].includes(event.key)) pressedAction = primaryAction();
  };
  primary.onpointercancel = () => {
    pressedAction = undefined;
  };
  primary.onclick = () => {
    const action = pressedAction ?? primaryAction();
    pressedAction = undefined;
    action();
  };
  shadow.querySelector<HTMLButtonElement>(".restore")!.onclick =
    actions.restore;
  shadow.querySelector<HTMLButtonElement>(".ask")!.onclick = actions.ask;
  shadow.querySelector<HTMLButtonElement>(".options")!.onclick =
    actions.options;
  language.onchange = () => {
    const value = language.value;
    language.disabled = true;
    void actions
      .language(value)
      .catch((error: unknown) => {
        notice.textContent =
          error instanceof Error ? error.message : "语言更新失败";
      })
      .finally(() => {
        language.disabled = false;
      });
  };
  paragraph.addEventListener("pointerdown", (event) => event.preventDefault());
  paragraph.onclick = () => {
    if (hovered?.isConnected) actions.paragraph(hovered);
  };
  const hover = (event: PointerEvent) => {
    if (
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
      toggle(true);
    },
    update(next: PageProgress, nextMode: "page" | "manual") {
      progress = next;
      mode = nextMode;
      primary.classList.toggle(
        "restoring",
        mode === "page" &&
          progress.active &&
          !progress.pending &&
          !progress.paused,
      );
      primary.textContent =
        mode !== "page" || !progress.active
          ? "翻译整页"
          : progress.paused
            ? "继续翻译"
            : progress.pending > 0
              ? "暂停"
              : "恢复原文";
      shadow.querySelector<HTMLElement>(".progress-area")!.hidden =
        !progress.total;
      shadow.querySelector<HTMLElement>(".progress-text")!.textContent =
        `${progress.completed} / ${progress.total} 个已发现段落${progress.paused ? " · 已暂停" : progress.pending ? " · 翻译中" : ""}${progress.failed ? ` · ${progress.failed} 段失败，可就地重试` : ""}`;
      const bar = shadow.querySelector<HTMLProgressElement>("progress")!;
      bar.max = Math.max(1, progress.total);
      bar.value = progress.completed;
    },
    setLanguage(value: string) {
      if (![...language.options].some((option) => option.value === value)) {
        const option = document.createElement("option");
        option.textContent = value;
        language.append(option);
      }
      language.value = value;
    },
    setNotice(value: string) {
      notice.textContent = value;
    },
    destroy() {
      document.removeEventListener("pointerover", hover);
      view.removeEventListener("scroll", hideHover, true);
      document.removeEventListener("keydown", key);
      host.remove();
    },
  };
}
