// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { extract, PageTranslator } from "@lingo-sofa/web-extraction";
import { protect, restore } from "@lingo-sofa/translation-core";

const wait = () => new Promise((resolve) => setTimeout(resolve, 20));
const fixture = readFileSync("tests/fixtures/forum.html", "utf8");
function forum() {
  document.body.innerHTML = new DOMParser().parseFromString(
    fixture,
    "text/html",
  ).body.innerHTML;
}
it("extracts semantic forum headings independently of metadata, badges and utility lists", () => {
  forum();
  const blocks = extract(document);
  const headings = blocks
    .filter((block) => block.presentation === "heading")
    .map((block) => block.text.replace(/\s+/g, " "));
  expect(headings).toEqual([
    "[RFC] Adding Chromium C++ code to CTMark",
    "[RFC] Reducing release note merge conflicts with per-change fragments",
    "[LoadStoreVectorizer] CPU store-packing opportunities and default pipeline scheduling",
  ]);
  expect(blocks.map((block) => block.text.replace(/\s+/g, " "))).toEqual([
    "Topic",
    ...headings,
    "I think some maintenance cost is unavoidable. We can settle on the design and metadata before implementing the workflow.",
  ]);
});
it("skips nonlinguistic values while retaining short labels and technical headings", () => {
  document.body.innerHTML = `<table><tr>${["19", "620", "1,292", "4.9k", "1h", "3 h ago", "12m 30s", "2026-10-18", "C++26", "IR"].map((value) => `<td>${value}</td>`).join("")}</tr></table><h2>C++26</h2><p translate="no">Keep this</p><div role="navigation"><p>Navigation</p></div>`;
  expect(extract(document).map((block) => block.text)).toEqual([
    "C++26",
    "IR",
    "C++26",
  ]);
});
it("renders forum prefixes as text, keeps compact usage in tooltips and restores original DOM", async () => {
  forum();
  const original = document.body.innerHTML;
  const badge = document.querySelector(".topic-post-badges");
  const category = document.querySelector(".link-bottom-line");
  const page = new PageTranslator(document, {
    targetLanguage: "简体中文",
    observeVisibility: false,
    translate: async (block) => {
      const hidden = protect(block.markdown, block.protectedParts);
      return {
        text: restore(`译文 ${hidden.text}`, hidden),
        billing: {
          source: "request",
          batchSize: 4,
          tokens: 100,
          cost: 0.000048,
        },
      };
    },
  });
  try {
    page.start();
    await wait();
    const titles = document.querySelectorAll<HTMLElement>(
      '[role="heading"] > [data-lingo-sofa="translation"]',
    );
    expect(titles).toHaveLength(3);
    expect(titles[0]!.textContent).toBe(
      "译文 [RFC] Adding Chromium C++ code to CTMark",
    );
    expect(titles[2]!.textContent).toContain("[LoadStoreVectorizer]");
    for (const title of titles) {
      expect(title.querySelector("math,.lingo-sofa-inline-usage")).toBeNull();
      expect(title.querySelector("span[style*='display:block']")).toBeNull();
      expect(title.style.borderBlockStartWidth).toBe("");
      expect(title.title).toContain("同批 4 段合计 · 100 Tokens");
      expect(title.title).toContain("不能逐段累加");
    }
    expect(document.querySelector(".topic-post-badges")).toBe(badge);
    expect(document.querySelector(".link-bottom-line")).toBe(category);
    expect(
      document.querySelectorAll(
        ".num [data-lingo-sofa],.link-bottom-line [data-lingo-sofa],#navigation-bar [data-lingo-sofa]",
      ),
    ).toHaveLength(0);
    expect(
      document.querySelector("article .lingo-sofa-inline-usage"),
    ).toBeNull();
    expect(
      document.querySelector<HTMLElement>(
        "article [data-lingo-sofa=translation]",
      )!.title,
    ).toContain("100 Tokens");
    expect(
      document.querySelector<HTMLElement>("th [data-lingo-sofa]")!.style
        .display,
    ).toBe("block");
  } finally {
    page.stop();
  }
  expect(document.body.innerHTML).toBe(original);
});
it("updates a live topic title without translating unread counts or losing real formulas", async () => {
  document.body.innerHTML =
    '<span role="heading"><a href="/topic">[RFC] Explain $x^2$</a><span class="topic-post-badges">6</span></span>';
  const calls: string[] = [];
  const page = new PageTranslator(document, {
    targetLanguage: "中文",
    observeVisibility: false,
    translate: async (block) => {
      calls.push(block.text);
      return block.markdown;
    },
  });
  try {
    page.start();
    await wait();
    expect(
      document.querySelectorAll('[data-lingo-sofa="translation"] math'),
    ).toHaveLength(1);
    document.querySelector(".topic-post-badges")!.textContent = "7";
    await wait();
    expect(calls).toEqual(["[RFC] Explain $x^2$"]);
    document.querySelector("a")!.firstChild!.textContent =
      "[RFC] Updated title";
    await wait();
    expect(calls).toEqual(["[RFC] Explain $x^2$", "[RFC] Updated title"]);
    expect(
      document.querySelectorAll('[data-lingo-sofa="translation"]'),
    ).toHaveLength(1);
    expect(
      document.querySelector('[data-lingo-sofa="translation"]')!.textContent,
    ).toBe("[RFC] Updated title");
    document.querySelector('[role="heading"]')!.setAttribute("translate", "no");
    await wait();
    expect(page.trackedCount).toBe(0);
    expect(document.querySelector("[data-lingo-sofa]")).toBeNull();
  } finally {
    page.stop();
  }
});
