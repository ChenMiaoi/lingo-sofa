import { defineContentScript } from "wxt/utils/define-content-script";
import { browser } from "wxt/browser";
import {
  PageTranslator,
  textOf,
  selectedText,
} from "@lingo-sofa/web-extraction";
import type { Reply, TranslationUnit } from "@lingo-sofa/protocol";
export default defineContentScript({
  registration: "runtime",
  main(ctx) {
    const lifecycle = globalThis as typeof globalThis & {
      lingoSofaLoaded?: boolean;
    };
    if (lifecycle.lingoSofaLoaded) return;
    lifecycle.lingoSofaLoaded = true;
    let translator: PageTranslator | undefined;
    let automaticMode = false;
    let selectionController: AbortController | undefined;
    const dialogs = new Set<HTMLDialogElement>();
    function stop() {
      translator?.stop();
      translator = undefined;
      selectionController?.abort();
      for (const dialog of dialogs) dialog.remove();
      dialogs.clear();
    }
    async function translate(
      unit: TranslationUnit,
      signal: AbortSignal,
    ): Promise<string> {
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
        return result.text;
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    }
    function start(targetLanguage: string, automatic = false) {
      stop();
      automaticMode = automatic;
      translator = new PageTranslator(document, {
        targetLanguage,
        translate: (block, id, revision, signal) =>
          translate(
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
    browser.runtime.onMessage.addListener((message: unknown) => {
      if (!message || typeof message !== "object" || !("action" in message))
        return;
      const data = message as { action: string; targetLanguage?: string };
      if (data.action === "stop") {
        stop();
        return Promise.resolve({ ok: true });
      }
      if (data.action === "page") {
        start(data.targetLanguage ?? "简体中文");
        return Promise.resolve({ ok: true });
      }
      if (data.action === "context")
        return Promise.resolve({
          text: (document.querySelector("article,main")
            ? textOf(document.querySelector<HTMLElement>("article,main")!)
            : ""
          ).slice(0, 24_000),
          selection: selectedText(document),
          title: document.title,
        });
      if (data.action === "selection") {
        const text = selectedText(document);
        if (!text)
          return Promise.resolve({
            ok: false,
            error: "请先选中可见正文文本；不翻译表单、代码块或编辑区域",
          });
        selectionController?.abort();
        return translate(
          {
            id: "selection",
            revision: crypto.randomUUID(),
            text,
            sourceKind: "web",
            targetLanguage: data.targetLanguage ?? "简体中文",
            protectedParts: [],
          },
          (selectionController = new AbortController()).signal,
        )
          .then((translation) => {
            const dialog = document.createElement("dialog");
            dialog.setAttribute("data-lingo-sofa", "selection");
            const content = document.createElement("p");
            content.textContent = translation;
            const close = document.createElement("button");
            close.textContent = "关闭译文";
            const remove = () => {
              dialogs.delete(dialog);
              dialog.remove();
            };
            close.onclick = remove;
            dialog.append(content, close);
            dialog.addEventListener("close", remove);
            dialogs.add(dialog);
            document.body.append(dialog);
            dialog.showModal();
            return { ok: true };
          })
          .catch((error: unknown) => ({
            ok: false,
            error: error instanceof Error ? error.message : "翻译失败",
          }));
      }
    });
    ctx.onInvalidated(() => {
      stop();
      delete lifecycle.lingoSofaLoaded;
    });
    void browser.runtime
      .sendMessage({ action: "auto-state" })
      .then((response: { enabled: boolean; targetLanguage: string }) => {
        if (response.enabled) start(response.targetLanguage, true);
      });
  },
});
