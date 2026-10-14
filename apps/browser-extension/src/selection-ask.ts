import type { Reply, Request } from "@lingo-sofa/protocol";
export function showSelectionAsk(
  document: Document,
  context: string,
  validate: () => boolean,
  send: (request: Request) => Promise<Reply>,
  onClose?: () => void,
): () => void {
  const dialog = document.createElement("dialog");
  dialog.setAttribute("data-lingo-sofa", "ask");
  dialog.style.cssText =
    "width:min(420px,calc(100vw - 40px));box-sizing:border-box;max-height:80vh;overflow:auto;padding:24px;border:1px solid GrayText;border-radius:12px;background:Canvas;color:CanvasText;font:14px/1.6 system-ui";
  const title = document.createElement("h2");
  title.textContent = "Ask Pi · 选中内容";
  title.style.fontSize = "18px";
  const previewLabel = document.createElement("label");
  previewLabel.textContent = "将发送的上下文";
  const preview = document.createElement("textarea");
  preview.value = context;
  preview.readOnly = true;
  preview.rows = 4;
  const privacy = document.createElement("p");
  privacy.textContent = "仅发送这里的选中内容与本次问答，不读取其他页面。";
  const turns = document.createElement("div");
  turns.setAttribute("aria-live", "polite");
  const error = document.createElement("p");
  error.setAttribute("role", "alert");
  const form = document.createElement("form");
  const questionLabel = document.createElement("label");
  questionLabel.textContent = "问题";
  const question = document.createElement("textarea");
  question.rows = 2;
  question.maxLength = 16_000;
  question.required = true;
  const ask = document.createElement("button");
  ask.type = "submit";
  ask.textContent = "提问";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "停止";
  cancel.hidden = true;
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "关闭并清理会话";
  for (const area of [preview, question])
    area.style.cssText =
      "display:block;width:100%;box-sizing:border-box;margin:6px 0 12px;padding:8px;border:1px solid GrayText;border-radius:6px;background:Canvas;color:CanvasText;font:inherit";
  for (const button of [ask, cancel, close])
    button.style.cssText =
      "font:inherit;margin:4px 8px 4px 0;padding:7px 10px;border:1px solid GrayText;border-radius:6px;background:ButtonFace;color:ButtonText;cursor:pointer";
  previewLabel.append(preview);
  questionLabel.append(question);
  form.append(questionLabel, ask, cancel);
  dialog.append(title, previewLabel, privacy, turns, error, form, close);
  let closed = false;
  let running: string | undefined;
  const sessionId = crypto.randomUUID();
  const stop = () => {
    if (running)
      void send({ kind: "cancel", requestId: running }).catch(() => undefined);
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    stop();
    void send({ kind: "clear-session", sessionId }).catch(() => undefined);
    dialog.remove();
    onClose?.();
  };
  cancel.onclick = stop;
  close.onclick = cleanup;
  dialog.addEventListener("close", cleanup);
  dialog.addEventListener("cancel", cleanup);
  form.onsubmit = (event) => {
    event.preventDefault();
    if (!event.isTrusted) return;
    if (running || !question.value.trim()) return;
    if (!validate()) {
      error.textContent = "所选内容或页面已变化，请重新选择并预览";
      return;
    }
    const prompt = question.value.trim();
    const requestId = crypto.randomUUID();
    running = requestId;
    ask.disabled = true;
    cancel.hidden = false;
    error.textContent = "";
    void send({ kind: "ask", requestId, sessionId, context, question: prompt })
      .then((reply) => {
        if (closed) return;
        if (!validate())
          throw new Error("所选内容或页面已变化，请重新选择并预览");
        if (!reply.ok) throw new Error(reply.error);
        const user = document.createElement("p");
        user.textContent = `你：${prompt}`;
        const answer = document.createElement("p");
        answer.textContent = reply.text ?? "";
        answer.style.whiteSpace = "pre-wrap";
        turns.append(user, answer);
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
          ask.disabled = false;
          cancel.hidden = true;
        }
      });
  };
  document.body.append(dialog);
  dialog.showModal();
  question.focus();
  return cleanup;
}
