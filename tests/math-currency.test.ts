// @vitest-environment jsdom
import { it, expect } from "vitest";
import {
  renderTranslationMarkdown,
  formatCost,
  formatExchangeRate,
  formatTranslationBilling,
  usdCnySnapshot,
} from "@lingo-sofa/ui-shared";
import { protect, restore } from "@lingo-sofa/translation-core";
import { mathFragments } from "@lingo-sofa/translation-core/math";
import { extract, PageTranslator } from "@lingo-sofa/web-extraction";
function render(text: string, codes: string[] = []): HTMLElement {
  const node = document.createElement("div");
  node.innerHTML = renderTranslationMarkdown(text, codes);
  return node;
}
it("converts only displayed USD cost into CNY using a sourced dated snapshot", () => {
  expect(usdCnySnapshot.rate).toBe(6.7249);
  expect(formatCost(1)).toBe("¥6.724900");
  expect(formatCost(0.0001596)).toBe("¥0.001073");
  expect(formatCost(null)).toBe("未知");
  expect(formatCost(0)).toBe("¥0.000000");
  expect(formatCost(0.00000001)).toBe("< ¥0.000001");
  const billing = {
    source: "request" as const,
    batchSize: 1,
    tokens: 265,
    cost: 0.0001596,
  };
  expect(formatTranslationBilling(billing).text).toBe("265 Tokens · ¥0.001073");
  expect(formatTranslationBilling(billing).title).toContain("USD");
  expect(formatTranslationBilling(billing).title).toContain(
    "费用按 API 实际用量与请求单价计算",
  );
  expect(formatTranslationBilling(billing).title).not.toMatch(
    /估算|不代表.*实扣/,
  );
  expect(formatExchangeRate()).toContain("2026-10-14");
  expect(formatExchangeRate()).toContain("https://www.safe.gov.cn/");
  expect(billing.cost).toBe(0.0001596);
});
it("renders all supported delimiters as native MathML while preserving Markdown", () => {
  const node = render(
    String.raw`**Energy** $E=mc^2$; \(x_1 + x_2\).\n\n$$\frac{a}{b}$$\n\n\[\sum_{i=1}^{n} i\]`,
  );
  expect(node.querySelectorAll("math")).toHaveLength(4);
  expect(node.querySelector("msup")).not.toBeNull();
  expect(node.querySelector("mfrac")).not.toBeNull();
  expect(node.querySelectorAll('math[display="block"]')).toHaveLength(2);
  expect(node.querySelector("strong")?.textContent).toBe("Energy");
  expect(
    node.querySelector('annotation[encoding="application/x-tex"]')?.textContent,
  ).toBe("E=mc^2");
});
it("does not treat amounts, escapes, code or formulas inside HTML code as math", () => {
  expect(
    mathFragments(String.raw`Pay $5 and $10; \$20; \$x$; $$unclosed`),
  ).toEqual([]);
  const node = render("Use `$x$` and\n```tex\n$$x^2$$\n```\nPay $5 and $10.");
  expect(node.querySelector("math")).toBeNull();
  expect(node.querySelector("code")?.textContent).toBe("$x$");
  const repeated = render("Code `$x$`, formula $x$, code `$x$`.");
  expect(repeated.querySelectorAll("math")).toHaveLength(1);
  expect(
    [...repeated.querySelectorAll("code")].map((code) => code.textContent),
  ).toEqual(["$x$", "$x$"]);
  expect(
    render("Literal price=$x$, formula $y^2$.", ["price=$x$"]).querySelectorAll(
      "math",
    ),
  ).toHaveLength(1);
});
it("keeps formulas byte-for-byte and rejects changed protection markers", () => {
  const source = String.raw`Use $x_i=\frac{a}{b}$ and \[\int_0^1 x\,dx\], not code.`;
  const hidden = protect(source);
  expect(hidden.text).not.toContain("\\frac");
  expect(hidden.text).not.toContain("\\int");
  expect(restore(hidden.text.replace("Use", "使用"), hidden)).toBe(
    source.replace("Use", "使用"),
  );
  expect(() => restore("改写", hidden)).toThrow("Protected content");
});
it("handles table pipes, malformed TeX, forbidden resources, macros and expansions safely", () => {
  expect(
    render("| Value |\n| --- |\n| $|x|$ |").querySelector("td math"),
  ).not.toBeNull();
  for (const formula of [
    String.raw`$\href{javascript:alert(1)}{x}$`,
    String.raw`$\includegraphics{https://tracker.test/a}$`,
    String.raw`$\htmlStyle{position:fixed}{x}$`,
    String.raw`$\badcommand{<img src=x onerror=alert(1)>}$`,
    String.raw`$\def\a{\a}\a$`,
  ]) {
    const node = render(formula);
    expect(node.querySelector("a,img,script,iframe")).toBeNull();
  }
  render(String.raw`$\gdef\leak{abc}\leak$`);
  expect(render(String.raw`$\leak$`).querySelector("math")).toBeNull();
  expect(render(String.raw`$\badcommand$`).textContent).toBe(
    String.raw`$\badcommand$`,
  );
});
it("preserves existing MathML and KaTeX source nodes without translating their internals", async () => {
  document.body.innerHTML =
    '<p id="mixed">Review <math><mi>x</mi></math> please.</p><p><math><mi>y</mi></math></p><p><span class="katex">z</span></p><p id="raw">Explain $x^2$ and <code>value=$y$</code>.</p>';
  expect(extract(document.body).map((x) => x.text)).toEqual([
    "Review  please.",
    "Explain $x^2$ and value=$y$.",
  ]);
  const page = new PageTranslator(document, {
    targetLanguage: "中文",
    observeVisibility: false,
    translate: async (block) => block.text,
  });
  page.start();
  await new Promise((r) => setTimeout(r, 30));
  expect(document.querySelectorAll("#raw [data-lingo-sofa] math")).toHaveLength(
    1,
  );
  expect(document.querySelector("#raw code")?.textContent).toBe("value=$y$");
  page.stop();
  expect(document.querySelectorAll("math")).toHaveLength(2);
});
