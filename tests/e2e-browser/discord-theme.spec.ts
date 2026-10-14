import { test, expect } from "@playwright/test";
import { pluginStyles } from "../../apps/discord-vencord/src/styles.js";

test("keeps Discord translations and controls readable across current and legacy theme changes", async ({
  page,
}) => {
  await page.setContent(
    `<style>body { color: black } p { color: black }</style><style>${pluginStyles}</style><section class="lingo-sofa-accessory"><p>译文</p></section><div class="lingo-sofa-dock"><button class="lingo-sofa-launcher">入口</button><section class="lingo-sofa-channel-panel lingo-sofa-panel"><h3>频道控制</h3><label>目标语言<input value="draft"></label><button>提问</button></section></div>`,
  );
  for (const legacy of [false, true]) {
    for (const dark of [true, false]) {
      const foreground = dark ? "rgb(219, 222, 225)" : "rgb(49, 51, 56)";
      const background = dark ? "rgb(30, 31, 34)" : "rgb(255, 255, 255)";
      await page.evaluate(
        ({ legacy, foreground, background, dark }) => {
          const root = document.documentElement.style;
          root.colorScheme = dark ? "dark" : "light";
          root.setProperty("--text-normal", legacy ? foreground : "black");
          root.setProperty("--background-secondary", background);
          if (legacy) {
            root.removeProperty("--text-default");
            root.removeProperty("--background-base-lowest");
          } else {
            root.setProperty("--text-default", foreground);
            root.setProperty("--background-base-lowest", background);
          }
        },
        { legacy, foreground, background, dark },
      );
      for (const selector of [
        ".lingo-sofa-accessory > p",
        ".lingo-sofa-launcher",
        ".lingo-sofa-panel h3",
        ".lingo-sofa-panel input",
        ".lingo-sofa-panel button",
      ]) {
        expect(
          await page
            .locator(selector)
            .evaluate((node) => getComputedStyle(node).color),
        ).toBe(foreground);
      }
      expect(
        await page
          .locator(".lingo-sofa-accessory > p")
          .evaluate((node) => getComputedStyle(node).opacity),
      ).toBe("1");
      for (const selector of [
        ".lingo-sofa-channel-panel",
        ".lingo-sofa-panel input",
      ]) {
        expect(
          await page
            .locator(selector)
            .evaluate((node) => getComputedStyle(node).backgroundColor),
        ).toBe(background);
      }
    }
  }
});
