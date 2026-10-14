import { test, expect } from "@playwright/test";
import {
  renderTranslationMarkdown,
  formatTranslationBilling,
} from "@lingo-sofa/ui-shared";
import { pluginStyles } from "../../apps/discord-vencord/src/styles.js";

test("keeps Discord translations and controls readable across current and legacy theme changes", async ({
  page,
}) => {
  await page.setContent(
    `<style>body { color: black } p { color: black } ul,ol { list-style:none } li { display:block;list-style:none } strong { font-weight:inherit } em { font-style:normal } del { text-decoration:none }</style><style>${pluginStyles}</style><section class="lingo-sofa-accessory"><div>${renderTranslationMarkdown("**译文** *说明* ~~旧文~~ `fetch()` $x^2$\n\n$$\\frac{1}{2}$$\n\n- 第一项\n- 第二项\n\n1. 按顺序\n2. 阅读")}</div><div class="lingo-sofa-inline-usage">${formatTranslationBilling({ source: "request", batchSize: 1, tokens: 265, cost: 0.0001596 }).text}</div></section><div class="lingo-sofa-dock"><button class="lingo-sofa-launcher">入口</button><section class="lingo-sofa-channel-panel lingo-sofa-panel"><h3>频道控制</h3><label>目标语言<input value="draft"></label><button>提问</button></section></div>`,
  );
  await expect(page.locator(".lingo-sofa-accessory li")).toHaveCount(4);
  await expect(page.locator(".lingo-sofa-accessory code")).toHaveText(
    "fetch()",
  );
  expect(
    await page
      .locator(".lingo-sofa-accessory")
      .evaluate((node) => getComputedStyle(node).borderBlockStartWidth),
  ).toBe("1px");
  expect(
    await page
      .locator(".lingo-sofa-accessory ul")
      .evaluate((node) => getComputedStyle(node).listStyleType),
  ).toBe("disc");
  expect(
    await page
      .locator(".lingo-sofa-accessory ol")
      .evaluate((node) => getComputedStyle(node).listStyleType),
  ).toBe("decimal");
  expect(
    await page
      .locator(".lingo-sofa-accessory li")
      .first()
      .evaluate((node) => getComputedStyle(node).display),
  ).toBe("list-item");
  expect(
    await page
      .locator(".lingo-sofa-accessory strong")
      .evaluate((node) => getComputedStyle(node).fontWeight),
  ).toBe("700");
  expect(
    await page
      .locator(".lingo-sofa-accessory em")
      .evaluate((node) => getComputedStyle(node).fontStyle),
  ).toBe("italic");
  expect(
    await page
      .locator(".lingo-sofa-accessory del")
      .evaluate((node) => getComputedStyle(node).textDecorationLine),
  ).toBe("line-through");
  expect(
    await page
      .locator(".lingo-sofa-accessory")
      .evaluate(
        (node) =>
          Number.parseFloat(getComputedStyle(node).lineHeight) /
          Number.parseFloat(getComputedStyle(node).fontSize),
      ),
  ).toBe(1.5);
  await expect(page.locator(".lingo-sofa-accessory math")).toHaveCount(2);
  const numerator = await page
    .locator(".lingo-sofa-accessory mfrac > mn")
    .nth(0)
    .boundingBox();
  const denominator = await page
    .locator(".lingo-sofa-accessory mfrac > mn")
    .nth(1)
    .boundingBox();
  expect(numerator!.y).toBeLessThan(denominator!.y);
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
        ".lingo-sofa-accessory strong",
        ".lingo-sofa-inline-usage",
        ".lingo-sofa-math",
        ".lingo-sofa-launcher",
        ".lingo-sofa-panel h3",
        ".lingo-sofa-panel input",
        ".lingo-sofa-panel button",
      ]) {
        expect(
          await page
            .locator(selector)
            .first()
            .evaluate((node) => getComputedStyle(node).color),
        ).toBe(foreground);
      }
      expect(
        await page
          .locator(".lingo-sofa-accessory strong")
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
