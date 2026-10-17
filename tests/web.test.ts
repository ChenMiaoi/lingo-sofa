// @vitest-environment jsdom
import { it, expect } from "vitest";
import { extract, PageTranslator } from "@lingo-sofa/web-extraction";
const wait = () => new Promise((resolve) => setTimeout(resolve, 20));
it("extracts legal leaf blocks and excludes hidden and editable contents", () => {
  document.body.innerHTML = `<nav><p>navigation</p></nav><article><p>Hello <a href="https://x.test">world</a> <code>fetch()</code><span style="display:none">secret</span></p><ul><li><p>nested</p></li></ul><table><tbody><tr><td>cell</td></tr></tbody></table><p hidden>hidden</p><div contenteditable><p>draft</p></div><pre><code>block</code></pre></article>`;
  const blocks = extract(document);
  expect(blocks.map((block) => block.text)).toEqual([
    "Hello world fetch()",
    "nested",
    "cell",
  ]);
  expect(blocks[0]!.protectedParts).toEqual(["⟦LS-WEB-LINK:0⟧", "` fetch() `"]);
  expect(blocks[0]!.markdown).toBe(
    "Hello [world](⟦LS-WEB-LINK:0⟧) ` fetch() `",
  );
  expect(blocks[0]!.links).toEqual({ "⟦LS-WEB-LINK:0⟧": "https://x.test/" });
});
it("distinguishes reading headers from global banners, sidebars and toolbars", () => {
  document.body.innerHTML = `<header><h1>Site banner</h1></header><main><header><h1>Article title</h1><nav><p>Article navigation</p></nav></header><p>Reading body</p><div role="toolbar"><p>Share controls</p></div><div role="complementary"><p>Related links</p></div><header role="banner"><h2>Global banner</h2></header></main><article><header><h2>Nested article</h2></header></article><div role="main"><header><h2>Accessible article</h2></header></div><div class="sphinxsidebar"><ul><li>Sidebar item</li></ul></div><div id="mdbook-menu-bar"><h1>Book menu</h1></div>`;
  expect(extract(document).map((block) => block.text)).toEqual([
    "Article title",
    "Reading body",
    "Nested article",
    "Accessible article",
  ]);
});
it("skips visually hidden accessibility text even when class names are generated", () => {
  document.body.innerHTML = `<h2 class="random-hash" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0px,0px,0px,0px)">Repository navigation</h2><div style="clip-path:inset(50%)"><p>Accessibility helper</p></div><div style="content-visibility:hidden"><p>Hidden region</p></div><h2 style="position:absolute;width:200px;height:40px;overflow:hidden">Visible title</h2><p>Visible text</p>`;
  expect(extract(document).map((block) => block.text)).toEqual([
    "Visible title",
    "Visible text",
  ]);
});
it("keeps repository file navigation and custom timestamps out of translated text", () => {
  document.body.innerHTML = `<main><table aria-labelledby="folders-and-files"><tr><th>File</th><td>README.md</td><td>Update the guide</td><td><relative-time>Oct 18, 2026</relative-time></td></tr></table><h1>The project</h1><p>Updated <relative-time>3 days ago</relative-time></p></main>`;
  expect(extract(document).map((block) => block.text)).toEqual([
    "The project",
    "Updated",
  ]);
});
it("extracts news titles independently of domains, authors, votes and navigation", () => {
  document.body.innerHTML = `<table id="hnmain"><tr><td><span class="pagetop"><a href="/news">News</a> | <a href="/submit">Submit</a></span></td></tr><tr><td><table><tr class="athing"><td><span class="rank">1.</span></td><td class="title"><span class="titleline"><a href="https://example.test/article">A technical story</a><span class="sitebit"> (<a href="/from">example.test</a>)</span></span></td></tr><tr><td class="subtext"><span class="score">42 points</span> by <a href="/user">reader</a> <span class="age">2 hours ago</span> | <a href="/comments">12 comments</a></td></tr></table></td></tr><tr><td><span class="yclinks">Guidelines | FAQ</span><a class="morelink" href="/next">More</a></td></tr></table>`;
  const blocks = extract(document);
  expect(blocks.map((block) => block.text)).toEqual(["A technical story"]);
  expect(blocks[0]!.element.className).toBe("titleline");
  expect(blocks[0]!.presentation).toBe("heading");
  expect(Object.values(blocks[0]!.links)).toEqual([
    "https://example.test/article",
  ]);
});
it("keeps issue activity metadata out of grid rows while translating comment lists", () => {
  document.body.innerHTML = `<main><h1>A compiler issue</h1><ol><li class="Timeline-Item" style="display:grid;grid-template-columns:24px 1fr"><div aria-hidden="true">Label icon</div><div class="TimelineBody"><a href="/user">A contributor</a> added <a href="/labels">Design Notes</a><relative-time>on Jul 29, 2016</relative-time></div></li><li class="Timeline-Item"><div class="TimelineBody"><a href="/user">A contributor</a> referenced a commit<div class="markdown-body"><p>Fix compiler analysis</p></div></div></li><li class="Timeline-Item"><article><h2>Discussion</h2><div class="markdown-body"><p>Explain the compiler behavior.</p><ul><li>A useful example</li></ul></div></article></li></ol></main>`;
  expect(extract(document).map((block) => block.text)).toEqual([
    "A compiler issue",
    "Discussion",
    "Explain the compiler behavior.",
    "A useful example",
  ]);
});
it("keeps encyclopedia metadata and edit/permalink controls out of reading content", () => {
  document.body.innerHTML = `<main><header><h1>LLVM</h1></header><div class="mw-parser-output"><div><h2>History<a class="headerlink" href="#history">¶</a></h2><span class="mw-editsection"><a href="?action=edit">edit</a></span></div><p>A compiler framework.<a href="https://www.wikidata.org/wiki/Example?action=edit">edit this statement</a></p><table class="infobox"><tr><th>Stable release</th><td>23.1.3 / 6 October 2026</td></tr><tr><th>Authors</th><td>Chris Lattner</td></tr></table></div></main>`;
  expect(extract(document).map((block) => block.text)).toEqual([
    "LLVM",
    "History",
    "A compiler framework.",
    "Stable release",
    "Authors",
  ]);
});
it("discards a late result after editing and removes only owned nodes on stop", async () => {
  document.body.innerHTML = "<p>Hello</p>";
  const pending: { text: string; resolve: (text: string) => void }[] = [];
  const translator = new PageTranslator(document, {
    targetLanguage: "中文",
    observeVisibility: false,
    translate: (block) =>
      new Promise((resolve) => pending.push({ text: block.text, resolve })),
  });
  translator.start();
  document.querySelector("p")!.firstChild!.textContent = "Updated";
  await wait();
  pending[0]!.resolve("过期结果");
  pending[1]!.resolve("新译文");
  await wait();
  expect(document.querySelectorAll("[data-lingo-sofa]")).toHaveLength(1);
  expect(document.querySelector("[data-lingo-sofa]")!.textContent).toBe(
    "新译文",
  );
  translator.stop();
  expect(document.querySelector("p")!.textContent).toBe("Updated");
});
it("does not recursively translate generated nodes or accumulate state across 100 SPA changes", async () => {
  document.body.innerHTML = Array.from(
    { length: 1_000 },
    (_, index) => `<p>paragraph ${index}</p>`,
  ).join("");
  let calls = 0;
  const translator = new PageTranslator(document, {
    targetLanguage: "中文",
    observeVisibility: false,
    translate: async (block) => {
      calls++;
      return `译 ${block.text}`;
    },
  });
  translator.start();
  await wait();
  expect(calls).toBe(1_000);
  expect(document.querySelectorAll("[data-lingo-sofa]")).toHaveLength(1_000);
  for (let index = 0; index < 100; index++) {
    document.body.innerHTML = `<p>route ${index}</p>`;
    await wait();
    expect(translator.trackedCount).toBe(1);
    expect(document.querySelectorAll("[data-lingo-sofa]")).toHaveLength(1);
  }
  expect(calls).toBe(1_100);
  translator.stop();
  expect(document.querySelectorAll("[data-lingo-sofa]")).toHaveLength(0);
}, 30_000);
it("omits hidden, form and editable text from a selection spanning regions", async () => {
  const { selectedText, selectedContent } =
    await import("@lingo-sofa/web-extraction");
  document.body.innerHTML = `<article><p>Public <span style="display:none">secret</span><code>fetch()</code></p><form><p>password</p></form><div contenteditable><p>draft</p></div><p>End</p></article>`;
  const range = document.createRange();
  range.selectNodeContents(document.querySelector("article")!);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  expect(selectedText(document)).toBe("Public fetch()End");
  expect(selectedContent(document).protectedParts).toEqual(["fetch()"]);
  range.setStart(document.querySelector("p")!.firstChild!, 2);
  range.setEnd(document.querySelector("p")!.firstChild!, 6);
  expect(selectedText(document)).toBe("blic");
});
it("removes translations when a containing region becomes hidden", async () => {
  document.body.innerHTML = `<article><p>Public</p></article>`;
  const translator = new PageTranslator(document, {
    targetLanguage: "中文",
    observeVisibility: false,
    translate: async () => "公开",
  });
  translator.start();
  await wait();
  document.querySelector("article")!.hidden = true;
  await wait();
  expect(translator.trackedCount).toBe(0);
  expect(document.querySelectorAll("[data-lingo-sofa]")).toHaveLength(0);
  document.querySelector("article")!.hidden = false;
  await wait();
  expect(document.querySelectorAll("[data-lingo-sofa]")).toHaveLength(1);
  translator.stop();
});

it("translates only the requested paragraph and keeps its inline layout", async () => {
  document.body.innerHTML =
    "<article><p>First <code>fetch()</code></p><p>Second</p></article>";
  const requests: string[] = [];
  const translator = new PageTranslator(document, {
    targetLanguage: "中文",
    manual: true,
    observeVisibility: false,
    translate: async (block) => {
      requests.push(block.text);
      return "第一段 fetch()";
    },
  });
  translator.start();
  expect(requests).toEqual([]);
  translator.translateElement(document.querySelector("p")!);
  await wait();
  expect(requests).toEqual(["First fetch()"]);
  expect(
    document.querySelectorAll("[data-lingo-sofa='translation']"),
  ).toHaveLength(1);
  expect(document.querySelector("code")!.textContent).toBe("fetch()");
  const node = document.querySelector<HTMLElement>(
    "[data-lingo-sofa='translation']",
  )!;
  expect(node.parentElement).toBe(document.querySelector("p"));
  expect(node.style.borderInlineStart).toBe("");
  expect(translator.progress).toMatchObject({
    completed: 1,
    pending: 0,
    total: 1,
  });
  translator.stop();
});

it("pauses pending work without removing completed text and rejects late results before resume", async () => {
  document.body.innerHTML = "<p>First</p><p>Second</p>";
  const pending: { text: string; resolve: (text: string) => void }[] = [];
  const translator = new PageTranslator(document, {
    targetLanguage: "中文",
    observeVisibility: false,
    translate: (block) =>
      new Promise((resolve) => pending.push({ text: block.text, resolve })),
  });
  translator.start();
  pending[0]!.resolve("第一段");
  await wait();
  translator.pause();
  expect(translator.progress).toMatchObject({
    paused: true,
    completed: 1,
    pending: 0,
  });
  pending[1]!.resolve("取消后的旧结果");
  await wait();
  expect(
    document.querySelectorAll("[data-lingo-sofa='translation']"),
  ).toHaveLength(1);
  document.querySelectorAll("p")[1]!.firstChild!.textContent = "Updated";
  await wait();
  expect(pending).toHaveLength(2);
  translator.resume();
  expect(pending[2]!.text).toBe("Updated");
  pending[2]!.resolve("更新后的译文");
  await wait();
  expect(translator.progress).toMatchObject({
    paused: false,
    completed: 2,
    pending: 0,
  });
  expect(document.body.textContent).not.toContain("取消后的旧结果");
  translator.stop();
});

it("allows an explicit paragraph translation while automatic work is paused", async () => {
  document.body.innerHTML =
    '<article><p id="one">First</p><p id="two">Second</p></article>';
  const calls: string[] = [];
  const translator = new PageTranslator(document, {
    targetLanguage: "中文",
    translate: async (block) => {
      calls.push(block.text);
      return `译文 ${block.text}`;
    },
  });
  translator.start();
  await wait();
  translator.pause();
  calls.length = 0;
  document.querySelector("#two")!.textContent = "Changed";
  await wait();
  expect(calls).toEqual([]);
  translator.translateElement(document.querySelector<HTMLElement>("#two")!);
  await wait();
  expect(calls).toEqual(["Changed"]);
  expect(
    document.querySelector("#one [data-lingo-sofa=translation]")?.textContent,
  ).toBe("译文 First");
  expect(translator.progress.paused).toBe(true);
  translator.stop();
});

it("preserves inline structure, translates link labels and collapses HTML source wrapping", async () => {
  document.body.innerHTML = `<article><p>Read
    <strong>the guide</strong> with <a href="https://example.test/docs?private=never-send">useful instructions</a> and <em>care</em>.<br>Next <code>fetch(\`x\`)</code><span hidden>secret</span>.</p></article>`;
  const original = document.querySelector("p")!.innerHTML;
  const block = extract(document)[0]!;
  expect(block.markdown).toContain("Read **the guide**");
  expect(block.markdown).not.toContain("never-send");
  expect(block.markdown).not.toContain("secret");
  expect(block.markdown).toContain("  \nNext");
  const { protect, restore } = await import("@lingo-sofa/translation-core");
  const protectedText = protect(block.markdown, block.protectedParts);
  expect(protectedText.text).toContain("useful instructions");
  expect(protectedText.text).not.toContain("fetch(");
  expect(protectedText.text).not.toContain("never-send");
  const translator = new PageTranslator(document, {
    targetLanguage: "简体中文",
    observeVisibility: false,
    translate: async () =>
      restore(
        protectedText.text
          .replace("the guide", "指南")
          .replace("useful instructions", "使用说明")
          .replace("care", "仔细"),
        protectedText,
      ),
  });
  translator.start();
  await wait();
  const result = document.querySelector('[data-lingo-sofa="translation"]')!;
  expect(result.querySelector("strong")?.textContent).toBe("指南");
  expect(result.querySelector("em")?.textContent).toBe("仔细");
  expect(result.querySelector("a")?.textContent).toBe("使用说明");
  expect(result.querySelector("a")?.href).toBe(
    "https://example.test/docs?private=never-send",
  );
  expect(result.querySelector("code")?.textContent).toBe("fetch(`x`)");
  expect(result.querySelectorAll("br")).toHaveLength(1);
  translator.stop();
  expect(document.querySelector("p")!.innerHTML).toBe(original);
});
it("invalidates results when a source destination or emphasis changes without a text edit", async () => {
  document.body.innerHTML = '<p>Read <a href="https://one.test">guide</a></p>';
  const pending: {
    block: ReturnType<typeof extract>[number];
    done: (text: string) => void;
  }[] = [];
  const translator = new PageTranslator(document, {
    targetLanguage: "中文",
    observeVisibility: false,
    translate: (block) =>
      new Promise((resolve) => pending.push({ block, done: resolve })),
  });
  translator.start();
  document.querySelector("a")!.href = "https://two.test";
  await wait();
  expect(pending).toHaveLength(2);
  pending[0]!.done(pending[0]!.block.markdown);
  pending[1]!.done(pending[1]!.block.markdown);
  await wait();
  expect(
    document
      .querySelector('[data-lingo-sofa="translation"] a')
      ?.getAttribute("href"),
  ).toBe("https://two.test/");
  document.querySelector("p > a")!.innerHTML = "<strong>guide</strong>";
  await wait();
  expect(pending).toHaveLength(3);
  pending[2]!.done(pending[2]!.block.markdown);
  await wait();
  expect(
    document.querySelector('[data-lingo-sofa="translation"] a strong')
      ?.textContent,
  ).toBe("guide");
  translator.stop();
});
it("does not include hidden code children, unsafe destinations or alter formulas", () => {
  document.body.innerHTML =
    '<p>Keep $x_1$ <code>safe<span hidden>secret</span></code> <a href="javascript:evil()">read me</a> *literal* [brackets]</p>';
  const block = extract(document)[0]!;
  expect(block.markdown).toContain("$x_1$");
  expect(block.markdown).not.toContain("secret");
  expect(block.links).toEqual({});
  expect(block.markdown).toContain("read me");
  expect(block.markdown).toContain("\\*literal\\*");
  expect(block.markdown).toContain("&#91;brackets&#93;");
});

it("retains visible URL and formula spelling when escaping plain Markdown characters", () => {
  document.body.innerHTML =
    "<p>Visit https://example.test/a_b?q=(x) and keep $x_1$ with **literal stars**.</p>";
  const block = extract(document)[0]!;
  expect(block.markdown).toContain("https://example.test/a_b?q=(x)");
  expect(block.markdown).toContain("$x_1$");
  expect(block.markdown).toContain("\\*\\*literal stars\\*\\*");
});

it("keeps page failures out of the original layout and retries a paragraph explicitly while paused", async () => {
  document.body.innerHTML = "<p>First</p><p>Second</p>";
  let fail = true;
  const translator = new PageTranslator(document, {
    targetLanguage: "中文",
    observeVisibility: false,
    translate: async () => {
      if (fail) throw new Error("Model response invalid");
      return "译文";
    },
  });
  translator.start();
  await wait();
  expect(translator.progress.failed).toBe(2);
  expect(translator.progress.error).toBe("Model response invalid");
  expect(document.querySelectorAll("[data-lingo-sofa]")).toHaveLength(0);
  expect(document.body.textContent).toBe("FirstSecond");
  translator.pause();
  fail = false;
  translator.translateElement(document.querySelector("p")!);
  await wait();
  expect(translator.progress.completed).toBe(1);
  expect(translator.progress.failed).toBe(1);
  translator.stop();
});

it("shows a small accessible retry for explicit failure and retries even after pausing", async () => {
  document.body.innerHTML = "<p>First</p>";
  let fail = true;
  const translator = new PageTranslator(document, {
    targetLanguage: "中文",
    observeVisibility: false,
    manual: true,
    translate: async () => {
      if (fail) throw new Error("Offline");
      return "译文";
    },
  });
  const paragraph = document.querySelector("p")!;
  translator.translateElement(paragraph);
  await wait();
  const button = paragraph.querySelector("button")!;
  expect(button.title).toBe("Offline");
  translator.pause();
  fail = false;
  button.click();
  await wait();
  expect(translator.progress.completed).toBe(1);
  expect(paragraph.querySelector("button")).toBeNull();
  translator.stop();
});
