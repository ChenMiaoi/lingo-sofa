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
