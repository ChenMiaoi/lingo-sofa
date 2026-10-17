import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BilingualPreview } from "../apps/browser-extension/src/BilingualPreview.js";
describe("bilingual preview", () => {
  it("shows selected languages and labels unsupported custom language examples", () => {
    const render = (language: string) =>
      renderToStaticMarkup(createElement(BilingualPreview, { language }));
    expect(render("日本語")).toContain("少しの文脈");
    expect(render("English")).toContain("效果预览");
    for (const language of ["Italiano", "__proto__", "constructor"]) {
      expect(render(language)).toContain("简体中文示例");
      expect(render(language)).toContain("此语言暂无静态示例");
    }
  });
});
