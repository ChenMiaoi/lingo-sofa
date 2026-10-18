import { textAnchorRect, registerAskShortcut } from "@lingo-sofa/ui-shared";
import { defineContentScript } from "wxt/utils/define-content-script";
import { browser } from "wxt/browser";
import {
  PageTranslator,
  BLOCKS,
  extract,
  textOf,
  selectedText,
  selectedContent,
  renderBlockTranslation,
} from "@lingo-sofa/web-extraction";
import { TranslationBatcher } from "@lingo-sofa/translation-core/batch";
import {
  createPageControls,
  type PageControlActions,
} from "../src/page-controls.js";
import { createSelectionActions } from "../src/selection-actions.js";
import { showSelectionAsk } from "../src/selection-ask.js";
import {
  providerCatalogSchema,
  type Reply,
  type TranslationUnit,
  type TranslationResult,
} from "@lingo-sofa/protocol";
export default defineContentScript({
  registration: "runtime",
  main(ctx) {
    if (ctx.isInvalid) return;
    const restoringReader =
      document.documentElement.hasAttribute("data-lingo-sofa-reader") ||
      Boolean(document.querySelector('[data-lingo-sofa="controls"]'));
    // Keep this document marker across context replacement, including successful cleanup.
    document.documentElement.setAttribute("data-lingo-sofa-reader", "");
    // A previous installation may have left UI behind after losing its APIs.
    for (const node of document.querySelectorAll("[data-lingo-sofa]"))
      node.remove();
    const documentToken = crypto.randomUUID();
    async function send(message: unknown) {
      const expired = () => new Error("扩展已更新或关闭，请刷新页面后重试。");
      const cleanup =
        message &&
        typeof message === "object" &&
        "kind" in message &&
        (message.kind === "cancel" || message.kind === "clear-session");
      // Reinjection aborts this context while its background can still accept cancellation.
      if (ctx.isInvalid && !cleanup) throw expired();
      try {
        return await browser.runtime?.sendMessage(message);
      } catch (error) {
        if (ctx.isInvalid) throw expired();
        throw error;
      }
    }
    let translator: PageTranslator | undefined;
    let automaticMode = false;
    let readingEnabled = false;
    let selectionController: AbortController | undefined;
    const selectionNodes = new Map<
      HTMLElement,
      { node: HTMLElement; original: string }
    >();
    const selectionObserver = new MutationObserver(() => {
      for (const [anchor, state] of selectionNodes)
        if (
          !anchor.isConnected ||
          textOf(anchor) !== state.original ||
          !extract(anchor).some((block) => block.element === anchor)
        ) {
          state.node.remove();
          selectionNodes.delete(anchor);
        }
    });
    const askCleanups = new Set<() => void>();
    let targetLanguage = "简体中文";
    let maxOutputTokens = Number.MAX_SAFE_INTEGER;
    async function readConfiguration() {
      const reply = await send({
        action: "page-controls",
      });
      if (!reply.ok) throw new Error(reply.error);
      maxOutputTokens = reply.maxOutputTokens || Number.MAX_SAFE_INTEGER;
      return reply as Awaited<ReturnType<PageControlActions["configuration"]>>;
    }
    let configurationReady = readConfiguration()
      .then(() => undefined)
      .catch(() => undefined);
    let mode: "page" | "manual" = "manual";
    let selectedPreview:
      | {
          text: string;
          root: HTMLElement;
          original: string;
          url: string;
          range?: Range;
        }
      | undefined;
    function captureSelection() {
      const text = selectedContent(document).text;
      if (!text) {
        if (!document.activeElement?.closest("[data-lingo-sofa=controls]"))
          selectedPreview = undefined;
        return;
      }
      const range = document.getSelection()!.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const root = node instanceof HTMLElement ? node : node.parentElement;
      if (root)
        selectedPreview = {
          text,
          root,
          original: textOf(root),
          url: location.href,
          range: range.cloneRange(),
        };
    }
    document.addEventListener("selectionchange", captureSelection);
    let pageCommandRevision = 0;
    function stop() {
      pageCommandRevision++;
      if (!translator)
        controls.update({
          active: false,
          paused: false,
          total: 0,
          completed: 0,
          pending: 0,
          failed: 0,
        });
      translator?.stop();
      translator = undefined;
      selectionController?.abort();
      for (const state of selectionNodes.values()) state.node.remove();
      selectionNodes.clear();
      selectionObserver.disconnect();
      for (const cleanup of askCleanups) cleanup();
      askCleanups.clear();
    }
    async function translate(
      unit: TranslationUnit,
      signal: AbortSignal,
    ): Promise<TranslationResult> {
      const requestId = crypto.randomUUID();
      const cancel = () => {
        void send({ kind: "cancel", requestId }).catch(() => undefined);
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        signal.throwIfAborted();
        const reply = (await send({
          kind: "translate",
          requestId,
          units: [unit],
          automatic: unit.id !== "selection" && automaticMode,
        })) as Reply;
        if (!reply.ok) throw new Error(reply.error);
        signal.throwIfAborted();
        const result = reply.results?.find(
          (result) =>
            result.id === unit.id && result.revision === unit.revision,
        );
        if (!result) throw new Error("收到不匹配的段落版本");
        return result;
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    }
    function start(language: string, automatic = false, manual = false) {
      if (ctx.isInvalid || !readingEnabled) return;
      targetLanguage = language;
      if (translator && mode === "manual" && !manual) {
        automaticMode = automatic;
        mode = "page";
        translator.translatePage();
        return;
      }
      mode = manual ? "manual" : "page";
      stop();
      automaticMode = automatic;
      const batcher = new TranslationBatcher(
        async (units, signal) => {
          const requestId = crypto.randomUUID();
          const cancel = () => {
            void send({ kind: "cancel", requestId }).catch(() => undefined);
          };
          signal.addEventListener("abort", cancel, { once: true });
          try {
            signal.throwIfAborted();
            const reply = (await send({
              kind: "translate",
              requestId,
              units,
              automatic: automaticMode,
            })) as Reply;
            if (!reply.ok) throw new Error(reply.error);
            signal.throwIfAborted();
            return reply.results ?? [];
          } finally {
            signal.removeEventListener("abort", cancel);
          }
        },
        1_000,
        4_000,
        () => maxOutputTokens,
      );
      translator = new PageTranslator(document, {
        targetLanguage,
        manual,
        onChange: (progress) => controls.update(progress),
        onError: (reason) =>
          controls.setNotice(
            reason instanceof Error ? reason.message : "翻译失败",
          ),
        translate: (block, id, revision, signal) =>
          batcher.translateResult(
            {
              id,
              revision,
              sourceKind: "web",
              text: block.markdown,
              targetLanguage,
              protectedParts: block.protectedParts,
            },
            signal,
          ),
      });
      translator.start();
    }
    let hoveredParagraph: HTMLElement | undefined;
    function trackAskParagraph(event: PointerEvent) {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-lingo-sofa]")) return;
      const element = target?.closest<HTMLElement>(BLOCKS);
      hoveredParagraph =
        element && extract(element).some((block) => block.element === element)
          ? element
          : undefined;
    }
    function askSelection(fallback?: HTMLElement) {
      if (ctx.isInvalid || !readingEnabled) return false;
      captureSelection();
      const preview =
        selectedPreview ??
        (fallback
          ? {
              text: textOf(fallback),
              root: fallback,
              original: textOf(fallback),
              url: location.href,
            }
          : undefined);
      for (const cleanup of askCleanups) cleanup();
      const text = preview?.text ?? "";
      const url = preview?.url ?? location.href;
      const cleanup = showSelectionAsk(
        document,
        text,
        () =>
          location.href === url &&
          (!preview ||
            (preview.root.isConnected &&
              textOf(preview.root) === preview.original)),
        async (request) => (await send(request)) as Reply,
        () => askCleanups.delete(cleanup),
        async () =>
          providerCatalogSchema.parse(await send({ action: "ask-catalog" })),
        preview
          ? () =>
              preview.root.isConnected
                ? "range" in preview && preview.range
                  ? preview.range.getBoundingClientRect()
                  : textAnchorRect(preview.root)
                : null
          : undefined,
      );
      askCleanups.add(cleanup);
      return true;
    }
    document.addEventListener("pointerover", trackAskParagraph);
    const removeAskShortcut = registerAskShortcut(document, () => {
      captureSelection();
      if (!selectedPreview && !hoveredParagraph) return false;
      return askSelection(hoveredParagraph);
    });
    const controls = createPageControls(document, {
      translateSelection: async () => {
        const reply = await onMessage({ action: "selection" });
        if (reply && "ok" in reply && !reply.ok)
          controls.setNotice(
            "error" in reply ? String(reply.error) : "翻译失败",
          );
        return reply;
      },
      translatePage: async () => {
        const revision = pageCommandRevision;
        await readingReady;
        await configurationReady;
        if (revision !== pageCommandRevision) return;
        if (!readingEnabled)
          throw new Error("双语阅读已关闭，请先在阅读偏好中开启。");
        if (translator?.progress.paused) translator.resume();
        else start(targetLanguage);
      },
      stop,
      pause: () => {
        pageCommandRevision++;
        if (translator) translator.pause();
        else
          controls.update({
            active: true,
            paused: true,
            total: 0,
            completed: 0,
            pending: 0,
            failed: 0,
          });
      },
      usage: async () => {
        const reply = await send({
          action: "usage-summary",
        });
        if (!reply.ok) throw new Error(reply.error);
        return reply;
      },
      usageSettings: () =>
        send({
          action: "open-options",
          section: "usage",
        }),
      ask: async () => {
        const revision = pageCommandRevision;
        await readingReady;
        if (revision === pageCommandRevision) askSelection();
      },
      settings: () => send({ action: "open-options" }),
      enabled: async (enabled) => {
        const reply = await send({
          action: "page-enabled",
          enabled,
        });
        if (!reply.ok) throw new Error(reply.error);
      },
      paragraph: async (element) => {
        const revision = pageCommandRevision;
        await readingReady;
        await configurationReady;
        if (
          revision !== pageCommandRevision ||
          ctx.isInvalid ||
          !readingEnabled ||
          !element.isConnected
        )
          return;
        if (!translator) start(targetLanguage, false, true);
        translator?.translateElement(element);
      },
      language: async (language) => {
        const reply = (await send({
          action: "page-language",
          targetLanguage: language,
        })) as Reply;
        if (!reply.ok) throw new Error(reply.error);
        const active = Boolean(translator);
        const manual = mode === "manual";
        stop();
        targetLanguage = language;
        if (active && !manual) start(language, automaticMode);
      },
      configuration: readConfiguration,
      model: async (model) => {
        const reply = await send({
          action: "page-model",
          model,
        });
        if (!reply.ok) throw new Error(reply.error);
      },
      automatic: async (enabled) => {
        const reply = await send({
          action: "page-auto",
          enabled,
        });
        if (!reply.ok) throw new Error(reply.error);
        return reply;
      },
    });
    const readingReady = send({ action: "auto-state" }).then(
      async (response: {
        enabled: boolean;
        readingEnabled: boolean;
        targetLanguage: string;
      }) => {
        await configurationReady;
        if (ctx.isInvalid) return;
        readingEnabled = response.readingEnabled !== false;
        controls.setEnabled(readingEnabled);
        if (!readingEnabled) stop();
        targetLanguage = response.targetLanguage;
        controls.setLanguage(targetLanguage);
        controls.setAutomatic(response.enabled);
        if (restoringReader)
          controls.setNotice("扩展连接已恢复。点击“翻译整页”继续翻译。");
        else if (response.enabled) start(targetLanguage, true);
      },
    );
    const onMessage = async (message: unknown) => {
      if (ctx.isInvalid) return;
      if (!message || typeof message !== "object" || !("action" in message))
        return;
      const data = message as {
        action: string;
        targetLanguage?: string;
        automatic?: boolean;
        readingEnabled?: boolean;
      };
      // Liveness must not wait for model settings or cause translation to start.
      if (data.action === "context-token")
        return controls.connected ? { documentToken } : undefined;
      await readingReady;
      if (ctx.isInvalid) return;
      if (data.action === "reading-changed") {
        readingEnabled = data.readingEnabled !== false;
        controls.setEnabled(readingEnabled);
        stop();
        if (readingEnabled && data.automatic) start(targetLanguage, true);
        return Promise.resolve({ ok: true });
      }
      if (
        !readingEnabled &&
        ["page", "selection", "ask-selection", "automatic-changed"].includes(
          data.action,
        )
      )
        return Promise.resolve({ ok: false, error: "双语阅读已关闭" });
      if (data.action === "disable") {
        ctx.abort();
        return Promise.resolve({ ok: true });
      }
      if (data.action === "controls") {
        controls.setLanguage(data.targetLanguage ?? targetLanguage);
        controls.open();
        return Promise.resolve({ ok: true });
      }
      if (data.action === "ask-selection") {
        askSelection();
        return Promise.resolve({ ok: true });
      }
      if (data.action === "automatic-changed") {
        controls.setAutomatic(Boolean(data.automatic));
        if (data.automatic) {
          if (translator) {
            mode = "page";
            automaticMode = true;
            translator.translatePage();
            translator.resume();
          } else start(targetLanguage, true);
        } else {
          translator?.pause();
          automaticMode = false;
        }
        return Promise.resolve({ ok: true });
      }
      if (data.action === "settings-changed") {
        configurationReady = readConfiguration()
          .then(() => undefined)
          .catch(() => undefined);
        await configurationReady;
        targetLanguage = data.targetLanguage ?? "简体中文";
        controls.setLanguage(targetLanguage);
        stop();
        controls.setAutomatic(Boolean(data.automatic));
        if (data.automatic) start(data.targetLanguage ?? "简体中文", true);
        return Promise.resolve({ ok: true });
      }
      if (data.action === "stop") {
        stop();
        return Promise.resolve({ ok: true });
      }
      if (data.action === "page") {
        start(data.targetLanguage ?? "简体中文");
        return Promise.resolve({ ok: true });
      }
      if (data.action === "page-status")
        return {
          hasSelection: Boolean(selectedContent(document).text),
          translated: Boolean(
            translator?.progress.completed || selectionNodes.size,
          ),
          pending: Boolean(translator?.progress.pending),
          readingEnabled,
        };
      if (data.action === "context")
        return Promise.resolve({
          text: (document.querySelector("article,main")
            ? textOf(document.querySelector<HTMLElement>("article,main")!)
            : ""
          ).slice(0, 24_000),
          selection: selectedText(document),
          title: document.title,
          documentToken,
        });
      if (data.action === "selection") {
        const { text, protectedParts } = selectedContent(document);
        if (!text)
          return Promise.resolve({
            ok: false,
            error: "请先选中可见正文文本；不翻译表单、代码块或编辑区域",
          });
        const range = document.getSelection()?.getRangeAt(0);
        const end = range?.endContainer;
        const anchor = (
          end instanceof HTMLElement ? end : end?.parentElement
        )?.closest<HTMLElement>(BLOCKS);
        if (!anchor || !anchor.isConnected)
          return Promise.resolve({
            ok: false,
            error: "请选中正文段落中的内容",
          });
        const original = textOf(anchor);
        const pageUrl = location.href;
        selectionController?.abort();
        const controller = (selectionController = new AbortController());
        return translate(
          {
            id: "selection",
            revision: crypto.randomUUID(),
            text,
            sourceKind: "web",
            targetLanguage: data.targetLanguage ?? "简体中文",
            protectedParts,
          },
          controller.signal,
        )
          .then((translation) => {
            const block = extract(anchor).find(
              (block) => block.element === anchor,
            );
            if (
              controller.signal.aborted ||
              !anchor.isConnected ||
              textOf(anchor) !== original ||
              location.href !== pageUrl ||
              !block
            )
              return { ok: false, error: "选中内容已变化，请重新选择" };
            const node = renderBlockTranslation(
              block,
              translation,
              data.targetLanguage ?? "简体中文",
            );
            node.setAttribute("data-lingo-sofa", "selection");
            node.setAttribute("aria-label", "LingoSofa 选区译文");
            selectionNodes.get(anchor)?.node.remove();
            anchor.append(node);
            selectionNodes.set(anchor, { node, original });
            selectionObserver.observe(document.body, {
              childList: true,
              characterData: true,
              subtree: true,
              attributes: true,
              attributeFilter: [
                "hidden",
                "aria-hidden",
                "class",
                "style",
                "contenteditable",
                "role",
                "translate",
              ],
            });
            return { ok: true };
          })
          .catch((error: unknown) => ({
            ok: false,
            error: error instanceof Error ? error.message : "翻译失败",
          }));
      }
    };
    const selectionActions = createSelectionActions(document, {
      enabled: () => readingEnabled,
      translate: () => controlsSelection(),
      ask: () => {
        askSelection();
      },
    });
    async function controlsSelection() {
      const reply = await onMessage({ action: "selection" });
      if (reply && "ok" in reply && !reply.ok)
        controls.setNotice("error" in reply ? String(reply.error) : "翻译失败");
    }
    browser.runtime.onMessage.addListener(onMessage);
    ctx.onInvalidated(() => {
      try {
        browser.runtime?.onMessage.removeListener(onMessage);
      } catch {
        // Browser APIs may disappear before invalidation is observed.
      }
      stop();
      controls.destroy();
      selectionActions.destroy();
      document.removeEventListener("selectionchange", captureSelection);
      document.removeEventListener("pointerover", trackAskParagraph);
      removeAskShortcut();
      selectedPreview = undefined;
    });
    // WXT notices API invalidation when a managed timer checks the context.
    ctx.setInterval(() => undefined, 1_000);
  },
});
