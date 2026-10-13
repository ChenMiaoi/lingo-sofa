import { defineContentScript } from "wxt/utils/define-content-script";
import { browser } from "wxt/browser";
import { PageTranslator, textOf } from "@lingo-sofa/web-extraction";
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
    function stop() {
      translator?.stop();
      translator = undefined;
      document
        .querySelectorAll("[data-lingo-sofa='selection']")
        .forEach((node) => node.remove());
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
        })) as Reply;
        if (!reply.ok) throw new Error(reply.error);
        signal.throwIfAborted();
        return reply.results?.[0]?.text ?? "";
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    }
    function start(targetLanguage: string) {
      stop();
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
          selection: getSelection()?.toString().slice(0, 16_000) ?? "",
          title: document.title,
        });
      if (data.action === "selection") {
        const selection = getSelection();
        if (!selection?.rangeCount || !selection.toString().trim())
          return Promise.resolve({ ok: false, error: "请先选中正文文本" });
        const range = selection.getRangeAt(0);
        const ancestor =
          range.commonAncestorContainer instanceof Element
            ? range.commonAncestorContainer
            : range.commonAncestorContainer.parentElement;
        if (
          ancestor?.closest(
            "input,textarea,pre,[contenteditable]:not([contenteditable='false']),form,[data-lingo-sofa]",
          )
        )
          return Promise.resolve({
            ok: false,
            error: "不翻译表单、代码块或编辑区域",
          });
        const fragment = range.cloneContents();
        fragment
          .querySelectorAll(
            "input,textarea,pre,script,style,[hidden],[aria-hidden='true'],[data-lingo-sofa]",
          )
          .forEach((node) => node.remove());
        const text = fragment.textContent?.trim() ?? "";
        return translate(
          {
            id: "selection",
            revision: crypto.randomUUID(),
            text,
            sourceKind: "web",
            targetLanguage: data.targetLanguage ?? "简体中文",
            protectedParts: [...fragment.querySelectorAll("code,a")]
              .map((node) => node.textContent ?? "")
              .filter(Boolean),
          },
          new AbortController().signal,
        )
          .then((translation) => {
            const dialog = document.createElement("dialog");
            dialog.setAttribute("data-lingo-sofa", "selection");
            const content = document.createElement("p");
            content.textContent = translation;
            const close = document.createElement("button");
            close.textContent = "关闭译文";
            close.onclick = () => dialog.remove();
            dialog.append(content, close);
            dialog.addEventListener("close", () => dialog.remove());
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
        if (response.enabled) start(response.targetLanguage);
      });
  },
});
