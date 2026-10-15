import { it, expect } from "vitest";
import { pageScope } from "../apps/browser-extension/src/page-scope.js";
it("isolates page instances and SPA URLs without storing private query strings", async () => {
  const original = new URL(
    "https://example.test/article?id=private-value#section",
  );
  const one = await pageScope(1, original, "document-one");
  expect(one).not.toContain("private-value");
  expect(one).toBe(await pageScope(1, original, "document-one"));
  expect(one).not.toBe(await pageScope(2, original, "document-one"));
  expect(one).not.toBe(await pageScope(1, original, "document-two"));
  expect(one).not.toBe(
    await pageScope(
      1,
      new URL("https://example.test/article?id=other#section"),
      "document-one",
    ),
  );
});
