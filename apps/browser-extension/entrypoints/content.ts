import {
  renderTranslationMarkdown,
  inlineTranslationStyle,
  appendTranslationBilling,
} from "@lingo-sofa/ui-shared";
import { defineContentScript } from "wxt/utils/define-content-script";
import { browser } from "wxt/browser";
import {
  PageTranslator,
  BLOCKS,
  extract,
  textOf,
  selectedText,
  selectedContent,
} from "@lingo-sofa/web-extraction";
import { TranslationBatcher } from "@lingo-sofa/translation-core/batch";
import { createPageControls } from "../src/page-controls.js";
import { showSelectionAsk } from "../src/selection-ask.js";
import type {
  Reply,
  TranslationUnit,
  TranslationResult,
} from "@lingo-sofa/protocol";
export default defineContentScript({
  registration: "runtime",
  main(ctx) {
    const lifecycle = globalThis as typeof globalThis & {
      lingoSofaLoaded?: boolean;
    };
    if (lifecycle.lingoSofaLoaded) return;
    lifecycle.lingoSofaLoaded = true;
    const documentToken = crypto.randomUUID();
    let translator: PageTranslator | undefined;
    let automaticMode = false;
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
    let mode: "page" | "manual" = "manual";
    let selectedPreview:
      | { text: string; root: HTMLElement; original: string; url: string }
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
        };
    }
    document.addEventListener("selectionchange", captureSelection);
    function stop() {
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
        void browser.runtime.sendMessage({ kind: "cancel", requestId });
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        signal.throwIfAborted();
        const reply = (await browser.runtime.sendMessage({
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
      const batcher = new TranslationBatcher(async (units, signal) => {
        const requestId = crypto.randomUUID();
        const cancel = () => {
          void browser.runtime.sendMessage({ kind: "cancel", requestId });
        };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          signal.throwIfAborted();
          const reply = (await browser.runtime.sendMessage({
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
      });
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
              text: block.text,
              targetLanguage,
              protectedParts: block.protectedParts,
            },
            signal,
          ),
      });
      translator.start();
    }
    function askSelection() {
      captureSelection();
      const preview = selectedPreview;
      if (!preview) {
        controls.setNotice("请先选中要解释或询问的正文");
        return;
      }
      const { text, root, original, url } = preview;
      const cleanup = showSelectionAsk(
        document,
        text,
        () =>
          location.href === url &&
          root.isConnected &&
          textOf(root) === original,
        async (request) =>
          (await browser.runtime.sendMessage(request)) as Reply,
        () => askCleanups.delete(cleanup),
      );
      askCleanups.add(cleanup);
    }
    const controls = createPageControls(document, {
      paragraph: (element) => {
        if (!translator) start(targetLanguage, false, true);
        translator?.translateElement(element);
      },
      language: async (language) => {
        const reply = (await browser.runtime.sendMessage({
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
      configuration: async () => {
        const reply = await browser.runtime.sendMessage({
          action: "page-controls",
        });
        if (!reply.ok) throw new Error(reply.error);
        return reply;
      },
      model: async (model) => {
        const reply = await browser.runtime.sendMessage({
          action: "page-model",
          model,
        });
        if (!reply.ok) throw new Error(reply.error);
      },
      automatic: async (enabled) => {
        const reply = await browser.runtime.sendMessage({
          action: "page-auto",
          enabled,
        });
        if (!reply.ok) throw new Error(reply.error);
        return reply;
      },
    });
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object" || !("action" in message))
        return;
      const data = message as {
        action: string;
        targetLanguage?: string;
        automatic?: boolean;
      };
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
      if (data.action === "context-token")
        return Promise.resolve({ documentToken });
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
            if (
              controller.signal.aborted ||
              !anchor.isConnected ||
              textOf(anchor) !== original ||
              location.href !== pageUrl ||
              !extract(anchor).some((block) => block.element === anchor)
            )
              return { ok: false, error: "选中内容已变化，请重新选择" };
            const node = document.createElement("span");
            node.setAttribute("data-lingo-sofa", "selection");
            node.setAttribute("aria-label", "LingoSofa 选区译文");
            node.style.cssText = inlineTranslationStyle;
            node.innerHTML = renderTranslationMarkdown(
              translation.text,
              [...anchor.querySelectorAll<HTMLElement>("code")]
                .filter((code) => !code.closest("[data-lingo-sofa]"))
                .map((code) => textOf(code)),
            );
            appendTranslationBilling(node, translation.billing);
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
    browser.runtime.onMessage.addListener(onMessage);
    ctx.onInvalidated(() => {
      browser.runtime.onMessage.removeListener(onMessage);
      stop();
      controls.destroy();
      document.removeEventListener("selectionchange", captureSelection);
      selectedPreview = undefined;
      delete lifecycle.lingoSofaLoaded;
    });
    void browser.runtime
      .sendMessage({ action: "auto-state" })
      .then((response: { enabled: boolean; targetLanguage: string }) => {
        if (ctx.isInvalid) return;
        targetLanguage = response.targetLanguage;
        controls.setLanguage(targetLanguage);
        controls.setAutomatic(response.enabled);
        if (response.enabled) start(targetLanguage, true);
      });
  },
});
