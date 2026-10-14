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
  expect(blocks[0]!.protectedParts).toEqual(["world", "fetch()"]);
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
