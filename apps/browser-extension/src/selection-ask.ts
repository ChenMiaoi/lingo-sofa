import { bindAppearance } from "./appearance.js";
import * as React from "react";
import { browser } from "wxt/browser";
import { createRoot } from "react-dom/client";
import {
  createAskModelSelector,
  askStyles,
  renderTranslationMarkdown,
  attachAskWindow,
  type AskAnchorRect,
} from "@lingo-sofa/ui-shared";
import type {
  ModelConfig,
  ProviderCatalog,
  Reply,
  Request,
} from "@lingo-sofa/protocol";
const AskModelSelector = createAskModelSelector(() => React);
export function showSelectionAsk(
  document: Document,
  context: string,
  validate: () => boolean,
  send: (request: Request) => Promise<Reply>,
  onClose?: () => void,
  loadModels?: () => Promise<ProviderCatalog>,
  anchor?: () => AskAnchorRect | null,
): () => void {
  const dialog = document.createElement("dialog");
  dialog.setAttribute("data-lingo-sofa", "ask");
  dialog.className = "ls-ask";
  dialog.setAttribute("aria-label", "Ask Pi · 选中内容");
  dialog.setAttribute("aria-keyshortcuts", "Alt+Shift+A");
  const style = document.createElement("style");
  style.textContent = askStyles;
  function icon(name: "chat" | "plus" | "close" | "send") {
    const img = document.createElement("img");
    img.src = browser.runtime.getURL(`/brand/figma/${name}.svg`);
    img.alt = "";
    if (name !== "chat" && name !== "send") return img;
    const picture = document.createElement("picture");
    const source = document.createElement("source");
    source.media = "(prefers-color-scheme: dark)";
    source.srcset =
      name === "chat"
        ? browser.runtime.getURL("/brand/figma/chat-dark.svg")
        : browser.runtime.getURL("/brand/figma/send-dark.svg");
    picture.append(source, img);
    return picture;
  }
  const header = document.createElement("header");
  header.className = "ls-ask-header";
  const fresh = document.createElement("button");
  fresh.type = "button";
  fresh.setAttribute("aria-label", "新建 / 清理会话");
  fresh.append(icon("plus"));
  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", "关闭并清理会话");
  close.append(icon("close"));
  header.setAttribute("aria-label", "会话操作");
  header.append(fresh, close);
  const conversation = document.createElement("div");
  conversation.className = "ls-ask-conversation";
  const empty = document.createElement("div");
  empty.className = "ls-ask-empty";
  const suggestions = document.createElement("div");
  suggestions.className = "ls-ask-suggestions";
  empty.append(suggestions);
  const turns = document.createElement("div");
  turns.setAttribute("aria-live", "polite");
  const status = document.createElement("p");
  status.className = "ls-ask-status";
  status.setAttribute("role", "status");
  const error = document.createElement("p");
  error.className = "ls-ask-error";
  error.setAttribute("role", "alert");
  conversation.append(empty, turns, status, error);
  dialog.dataset.askState = "empty";
  const composerArea = document.createElement("div");
  composerArea.className = "ls-ask-composer-area";
  const form = document.createElement("form");
  form.className = "ls-ask-composer";
  const chips = document.createElement("div");
  chips.className = "ls-ask-context-chips";
  const contextChip = document.createElement("button");
  contextChip.className = "ls-context-chip";
  contextChip.type = "button";
  contextChip.textContent = "所选文本 ×";
  contextChip.setAttribute("aria-label", "移除所选上下文");
  contextChip.setAttribute("aria-pressed", "true");
  let includeContext = Boolean(context);
  contextChip.hidden = !includeContext;
  chips.append(contextChip);
  const questionLabel = document.createElement("label");
  questionLabel.textContent = "问题";
  questionLabel.className = "ls-ask-form-label";
  const question = document.createElement("textarea");
  question.className = "ls-ask-question";
  question.setAttribute("aria-label", "问题");
  question.placeholder = context ? "针对这段内容，问点什么…" : "问点什么…";
  question.rows = 2;
  question.maxLength = 16_000;
  question.required = true;
  const ask = document.createElement("button");
  ask.type = "submit";
  ask.className = "ls-ask-send";
  ask.setAttribute("aria-label", "提问");
  ask.append(icon("send"));
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "停止";
  cancel.hidden = true;
  const bottom = document.createElement("div");
  bottom.className = "ls-ask-composer-bottom";
  for (const text of [
    "解释这段话的含义",
    "用三句话总结所选内容",
    "帮我写一条自然的回复",
  ]) {
    const suggestion = document.createElement("button");
    suggestion.type = "button";
    suggestion.textContent = `${text}  ↗`;
    suggestion.onclick = () => {
      question.value = text;
      question.focus();
    };
    suggestions.append(suggestion);
  }
  let selectedModel: ModelConfig | undefined;
  const modelHost = document.createElement("div");
  const modelRoot = createRoot(modelHost);
  function ModelPanel({ disabled }: { disabled: boolean }) {
    const [model, setModel] = React.useState<ModelConfig | undefined>(
      undefined,
    );
    return loadModels
      ? React.createElement(AskModelSelector, {
          load: loadModels,
          model,
          disabled,
          onChange: (next: ModelConfig) => {
            selectedModel = next;
            setModel(next);
            ask.disabled = Boolean(running);
          },
        })
      : null;
  }
  const renderModel = (disabled: boolean) =>
    modelRoot.render(React.createElement(ModelPanel, { disabled }));
  ask.disabled = Boolean(loadModels);
  modelHost.className = "ls-ask-model-host";
  bottom.append(modelHost, cancel, ask);
  form.append(chips, questionLabel, question, bottom);
  composerArea.append(form);
  dialog.append(style, header, conversation, composerArea);
  const unbindAppearance = bindAppearance(dialog);
  let closed = false;
  let running: string | undefined;
  let sessionId = crypto.randomUUID();
  const stop = () => {
    if (running)
      void send({ kind: "cancel", requestId: running }).catch(() => undefined);
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    unbindAppearance();
    stop();
    void send({ kind: "clear-session", sessionId }).catch(() => undefined);
    modelRoot.unmount();
    dialog.remove();
    detachWindow();
    onClose?.();
  };
  cancel.onclick = stop;
  fresh.onclick = () => {
    if (running) return;
    void send({ kind: "clear-session", sessionId }).catch(() => undefined);
    sessionId = crypto.randomUUID();
    turns.replaceChildren();
    empty.hidden = false;
    dialog.dataset.askState = "empty";
    status.textContent = error.textContent = question.value = "";
    contextChip.disabled = false;
    question.focus();
  };
  contextChip.onclick = () => {
    includeContext = !includeContext;
    contextChip.textContent = includeContext ? "所选文本 ×" : "+ 添加所选文本";
    contextChip.setAttribute(
      "aria-label",
      includeContext ? "移除所选上下文" : "添加所选上下文",
    );
    contextChip.setAttribute("aria-pressed", String(includeContext));
  };
  let submitAuthorized = false;
  ask.addEventListener("click", (event) => {
    submitAuthorized = event.isTrusted;
  });
  question.onkeydown = (event) => {
    if (!event.isTrusted) return;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!ask.disabled && question.value.trim()) {
        submitAuthorized = true;
        form.requestSubmit();
      }
    }
  };
  close.onclick = cleanup;
  dialog.addEventListener("close", cleanup);
  dialog.addEventListener("cancel", cleanup);
  form.onsubmit = (event) => {
    event.preventDefault();
    // requestSubmit() itself produces a trusted submit event, even when called
    // by the host page. Require a trusted button or keyboard gesture as well.
    const authorized = submitAuthorized;
    submitAuthorized = false;
    if (!event.isTrusted || !authorized) return;
    if (running || !question.value.trim()) return;
    if (!validate()) {
      error.textContent = "所选内容或页面已变化，请重新选择并预览";
      return;
    }
    const prompt = question.value.trim();
    const requestId = crypto.randomUUID();
    running = requestId;
    ask.disabled = fresh.disabled = contextChip.disabled = true;
    empty.hidden = true;
    dialog.dataset.askState = "conversation";
    status.textContent = "正在生成回答…";
    renderModel(true);
    cancel.hidden = false;
    error.textContent = "";
    void send({
      kind: "ask",
      requestId,
      sessionId,
      context: includeContext ? context : "",
      question: prompt,
      ...(selectedModel ? { model: selectedModel } : {}),
    })
      .then((reply) => {
        if (closed) return;
        if (!validate())
          throw new Error("所选内容或页面已变化，请重新选择并预览");
        if (!reply.ok) throw new Error(reply.error);
        const user = document.createElement("p");
        user.textContent = prompt;
        user.className = "ls-ask-user";
        const answer = document.createElement("div");
        answer.innerHTML = renderTranslationMarkdown(reply.text ?? "");
        answer.className = "ls-ask-answer";
        const turn = document.createElement("div");
        turn.className = "ls-ask-turn";
        const completed = document.createElement("span");
        completed.className = "ls-ask-badge";
        completed.textContent = "✓ 已完成";
        const actions = document.createElement("div");
        actions.className = "ls-ask-answer-actions";
        const copy = document.createElement("button");
        copy.type = "button";
        copy.textContent = "复制";
        copy.onclick = () => {
          void document.defaultView?.navigator.clipboard
            .writeText(reply.text ?? "")
            .then(() => {
              copy.textContent = "已复制";
            })
            .catch(() => {
              error.textContent = "无法复制，请手动选择回答文本。";
            });
        };
        actions.append(copy);
        turn.append(user, completed, answer, actions);
        turns.append(turn);
        turn.scrollIntoView({ block: "nearest" });
        question.value = "";
      })
      .catch((reason: unknown) => {
        if (!closed)
          error.textContent =
            reason instanceof Error ? reason.message : "问答失败";
      })
      .finally(() => {
        running = undefined;
        if (!closed) {
          fresh.disabled = false;
          contextChip.disabled = turns.childElementCount > 0;
          status.textContent = "";
          ask.disabled = Boolean(loadModels && !selectedModel);
          renderModel(false);
          cancel.hidden = true;
        }
      });
  };
  renderModel(false);
  document.body.append(dialog);
  const detachWindow = attachAskWindow(dialog, anchor, cleanup);
  question.focus();
  return cleanup;
}
