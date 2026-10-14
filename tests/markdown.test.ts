// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  renderTranslationMarkdown,
  inlineTranslationStyle,
} from "@lingo-sofa/ui-shared";
import {
  codeFragments,
  protect,
  restore,
  withoutCode,
} from "@lingo-sofa/translation-core";
import { extract, PageTranslator } from "@lingo-sofa/web-extraction";

function rendered(text: string): HTMLDivElement {
  const element = document.createElement("div");
  element.innerHTML = renderTranslationMarkdown(text);
  return element;
}

describe("translation Markdown", () => {
  it("renders emphasis, lists, links, tables and literal code", () => {
    const element = rendered(
      '**重点** *说明* ~~删除~~ `fetch()`\n\n- 第一项\n- 第二项\n\n[文档](https://example.com/docs)\n\n| 名称 | 值 |\n| --- | --- |\n| A | B |\n\n```js\nconst x = "<img>";\n```',
    );
    expect(element.querySelector("strong")?.textContent).toBe("重点");
    expect(element.querySelectorAll("li")).toHaveLength(2);
    expect(element.querySelector("em")?.textContent).toBe("说明");
    expect(element.querySelector("del")?.textContent).toBe("删除");
    expect(element.querySelector("a")?.getAttribute("rel")).toBe(
      "noopener noreferrer",
    );
    expect(element.querySelectorAll("td")).toHaveLength(2);
    expect(element.querySelector("pre code")?.textContent).toContain(
      'const x = "<img>";',
    );
    expect(element.querySelector("img")).toBeNull();
  });
  it("treats model HTML as text and blocks active URLs and remote images", () => {
    const element = rendered(
      "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29) [data](data:text/html,evil) [encoded](jav&#x61;script:alert%281%29) ![label](https://tracker.test/pixel)\n\n<input autofocus onfocus=alert(1)>",
    );
    expect(element.querySelector("script,img,input,iframe,svg")).toBeNull();
    expect(element.querySelector("a")).toBeNull();
    expect(element.textContent).toContain("<script>");
    expect(element.textContent).toContain("label");
  });
  it("renders Markdown below the original with a theme-inherited separator", async () => {
    document.body.innerHTML =
      "<article><p>Original <code>fetch()</code></p><p><code>const x = 1</code></p><pre>private code</pre></article>";
    expect(extract(document.body)).toHaveLength(1);
    const translator = new PageTranslator(document, {
      translate: async () => "**译文** `fetch()`",
      targetLanguage: "简体中文",
      observeVisibility: false,
    });
    translator.translatePage();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const translation = document.querySelector<HTMLElement>(
      '[data-lingo-sofa="translation"]',
    )!;
    expect(translation.querySelector("strong")?.textContent).toBe("译文");
    expect(translation.querySelector("code")?.textContent).toBe("fetch()");
    expect(inlineTranslationStyle).toContain("border-block-start");
    expect(translation.style.color).toBe("inherit");
    translator.stop();
    expect(
      document.querySelector('[data-lingo-sofa="translation"]'),
    ).toBeNull();
    expect(document.querySelector("p")?.textContent).toBe("Original fetch()");
  });
});

describe("code protection", () => {
  it("preserves multi-backtick spans, both fences, indented and unclosed blocks", () => {
    for (const code of [
      "``a ` b``",
      '```js\nconst x = "private";\n```',
      '~~~~py\nprint("private")\n~~~~',
      "    const x = 1;\n",
      "```js\nunfinished",
    ]) {
      const source = code.startsWith("    ")
        ? `Hello\n\n${code}`
        : `Hello\n${code}`;
      expect(codeFragments(source)).not.toHaveLength(0);
      const protectedText = protect(source);
      expect(protectedText.text).not.toContain("private");
      expect(
        restore(protectedText.text.replace("Hello", "你好"), protectedText),
      ).toBe(source.replace("Hello", "你好"));
    }
  });
  it("skips code-only content and rejects modified protection markers", () => {
    expect(withoutCode("```js\nconst x = 1;\n```")).toBe("");
    expect(withoutCode("``fetch(`x`)``")).toBe("");
    const content = protect("Use ``fetch(`x`)`` now");
    expect(() => restore("使用", content)).toThrow("Protected content");
  });
});

it("flows web soft line breaks while preserving explicit breaks and Discord lines", () => {
  const text = "First\nsecond\nthird  \nnext";
  const web = document.createElement("div");
  web.innerHTML = renderTranslationMarkdown(text, [], { breaks: false });
  expect(web.querySelectorAll("br")).toHaveLength(1);
  const discord = rendered(text);
  expect(discord.querySelectorAll("br")).toHaveLength(3);
});
it("restores local source URLs safely without changing escaped destinations", () => {
  const web = document.createElement("div");
  web.innerHTML = renderTranslationMarkdown(
    "[指南](⟦LS-WEB-LINK:0⟧) [拒绝](⟦LS-WEB-LINK:1⟧)",
    [],
    {
      breaks: false,
      links: {
        "⟦LS-WEB-LINK:0⟧": "https://example.test/a_(b)?q=%22x%22",
        "⟦LS-WEB-LINK:1⟧": "javascript:evil()",
      },
    },
  );
  expect(web.querySelectorAll("a")).toHaveLength(1);
  expect(web.querySelector("a")?.href).toBe(
    "https://example.test/a_(b)?q=%22x%22",
  );
});

it("does not parse local destination dollar signs as mathematical formulas", () => {
  const node = document.createElement("div");
  node.innerHTML = renderTranslationMarkdown("[指南](⟦LS-WEB-LINK:0⟧)", [], {
    breaks: false,
    links: { "⟦LS-WEB-LINK:0⟧": "https://example.test/$token$/a_(b)" },
  });
  expect(node.querySelector("a")?.href).toBe(
    "https://example.test/$token$/a_(b)",
  );
  expect(node.querySelector("math")).toBeNull();
});
