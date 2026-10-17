import { describe, expect, it } from "vitest";
import { pageStatusLabel } from "../apps/browser-extension/src/page-status.js";
describe("popup availability", () => {
  it("distinguishes unavailable, disabled, working and readable pages", () => {
    expect(pageStatusLabel(undefined)).toContain("正在检查");
    expect(pageStatusLabel({ supported: false })).toContain("不支持");
    expect(
      pageStatusLabel({
        supported: true,
        readingEnabled: false,
        translated: true,
      }),
    ).toContain("已关闭");
    expect(
      pageStatusLabel({ supported: true, pending: true, translated: true }),
    ).toBe("正在翻译");
    expect(pageStatusLabel({ supported: true, translated: true })).toBe(
      "已显示译文",
    );
    expect(pageStatusLabel({ supported: true, hasSelection: true })).toBe(
      "已选中文字",
    );
    expect(pageStatusLabel({ supported: true })).toContain("权限");
  });
});
