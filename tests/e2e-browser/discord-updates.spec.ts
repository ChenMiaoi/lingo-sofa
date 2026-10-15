import { test, expect } from "@playwright/test";
import { build } from "esbuild";

test("checks, downloads and applies updates only after successful verification, with retry on failure", async ({
  page,
}, testInfo) => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "js",
      contents: `
import React from "react";
import {createRoot} from "react-dom/client";
import {UpdateSettings} from "./apps/discord-vencord/src/update-settings.tsx";
import {pluginStyles} from "./apps/discord-vencord/src/styles.ts";
document.head.appendChild(Object.assign(document.createElement('style'),{textContent:pluginStyles}));
window.events=[]; window.downloadFails=true;
const native={checkUpdate:async()=>{window.events.push('check'); return {version:'0.2.0'};},
downloadUpdate:async()=>{window.events.push('download'); await new Promise(r=>window.finishDownload=r); if(window.downloadFails)throw new Error('安装包校验失败');},
applyUpdate:async()=>{window.events.push('apply');}};
createRoot(document.getElementById('root')).render(React.createElement(UpdateSettings,{native}));`,
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "transform",
    jsxFactory: "React.createElement",
    plugins: [
      {
        name: "host-react",
        setup(builder) {
          builder.onResolve({ filter: /^@webpack\/common$/ }, () => ({
            path: "host",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: 'export {default as React} from "react";',
            resolveDir: process.cwd(),
          }));
        },
      },
    ],
  });
  await page.setContent(
    '<main id="root" style="max-width:600px;font:16px sans-serif"></main>',
  );
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  await expect(
    page.getByRole("button", { name: "退出 Discord 并安装更新" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "检查更新" }).click();
  await page.setViewportSize({ width: 320, height: 640 });
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.body.className = `theme-${theme}`;
    }, theme);
    const download = page.getByRole("button", { name: "下载 0.2.0" });
    const background = await download.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    await download.hover();
    expect(
      await download.evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe(background);
    const box = await download.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    expect(
      await download.evaluate((el) => getComputedStyle(el).color),
    ).not.toBe(
      await download.evaluate((el) => getComputedStyle(el).backgroundColor),
    );
    await page.screenshot({ path: testInfo.outputPath(`update-${theme}.png`) });
  }
  await page.getByRole("button", { name: "下载 0.2.0" }).click();
  await expect(
    page.getByRole("button", { name: "正在下载并校验…" }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "检查更新" })).toBeDisabled();
  await page.evaluate(() =>
    (window as unknown as { finishDownload: () => void }).finishDownload(),
  );
  await expect(page.getByRole("alert")).toHaveText("安装包校验失败");
  await expect(
    page.getByRole("button", { name: "退出 Discord 并安装更新" }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    (window as unknown as { downloadFails: boolean }).downloadFails = false;
  });
  await page.getByRole("button", { name: "下载 0.2.0" }).click();
  await page.evaluate(() =>
    (window as unknown as { finishDownload: () => void }).finishDownload(),
  );
  await expect(page.getByRole("status")).toContainText("下载和校验完成");
  await page.getByRole("button", { name: "退出 Discord 并安装更新" }).click();
  await expect(page.getByRole("status")).toContainText("Discord 即将退出");
  expect(
    await page.evaluate(
      () => (window as unknown as { events: string[] }).events,
    ),
  ).toEqual(["check", "download", "download", "apply"]);
});
