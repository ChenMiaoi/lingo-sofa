import React from "react";
import { format } from "prettier";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Desktop } from "../apps/desktop/src/view";
import {
  initialState,
  type DesktopState,
  type Mode,
} from "../apps/desktop/src/api";
import { root } from "./process";
const context = {
  text: "Good design is as little design as possible. It helps us focus on what matters, without getting in the way of what we're trying to do.",
  origin: "Margin · Design notes",
  kind: "selection" as const,
  anchor: { x: 300, y: 400, width: 476, height: 75 },
  anchorValid: true,
};
const translation =
  "好的设计，是尽可能少的设计。\n它帮助我们专注于真正重要的事，\n而不干扰我们正在做的事。";
const previews: [Mode, number, number, string][] = [
  ["idle", 120, 70, "普通阅读 · 边缘入口"],
  ["translation", 500, 178, "轻量译文 · 悬停 / 键盘聚焦显示操作"],
  ["ask", 660, 390, "主动 Ask · 沿用当前原文"],
  ["ask-result", 660, 558, "Ask 回答 · 固定示例内容"],
  ["input", 620, 324, "输入 / 新问题 · 复用 Ask 面板"],
  ["settings", 550, 480, "独立账户设置"],
];
const cards = previews
  .map(([mode, width, height, title]) => {
    const state: DesktopState = {
      ...initialState,
      desktop: {
        ...initialState.desktop,
        mode,
        context,
        translation,
        modelRevision: 1,
      },
      model: {
        ...initialState.model,
        revision: 1,
        keyConfigured: true,
        sessionReady: true,
        phase: "ready",
        message: "已完成",
        output:
          "示例回答：这段话强调设计应帮助读者专注于内容。\n\n“as little design as possible”强调克制；“getting in the way”指造成干扰。",
        reportedTokens: 1280,
      },
    };
    return `<section><h2>${title}</h2><div class="preview-scene" style="width:${width}px;height:${height}px">${renderToStaticMarkup(React.createElement(Desktop, { state, perform: async () => {} }))}</div></section>`;
  })
  .join("");
const css = await readFile(resolve(root, "apps/desktop/src/style.css"), "utf8");
const directory = resolve(root, "docs/validation/v3-ui");
await mkdir(directory, { recursive: true });
await writeFile(
  resolve(directory, "component-preview.html"),
  await format(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>LingoSofa v3 · 实现组件静态预览</title><style>${css}body{height:auto;overflow:auto;background:#f5f5ef;padding:32px}body>h1{font-size:28px;font-weight:400}body>p{font-size:12px;color:#8a9c84}#previews{display:flex;flex-wrap:wrap;gap:30px;align-items:flex-start}#previews>section>h2{font-size:13px;font-weight:400;margin:22px 0 12px}.preview-scene{background:#e6ede1;border-radius:12px;position:relative;overflow:hidden}.preview-scene:has(.reading){background:#f5f5ef}</style><h1>LingoSofa / Desktop v3</h1><p>当前 React 组件的静态渲染 · 固定示例数据 · 按钮不执行操作 · 不代表原生窗口或真实模型验收</p><div id="previews">${cards}</div></html>`,
    { parser: "html" },
  ),
);
