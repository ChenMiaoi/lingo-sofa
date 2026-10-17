import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

test("guides first website access without enabling translation and supports retry after denial", async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents: `import React from "react";
import {createRoot} from "react-dom/client";
import {ReadingAccess} from "./apps/browser-extension/src/ReadingAccess.tsx";
window.access={allow:false,granted:false,requests:[],messages:[]};
window.saved={};
window.permissionListeners={added:new Set(),removed:new Set()};
const event=listeners=>({addListener:listener=>listeners.add(listener),removeListener:listener=>listeners.delete(listener)});
window.browser={storage:{local:{get:async key=>({[key]:window.saved[key]}),set:async value=>{Object.assign(window.saved,value);}}},permissions:{onAdded:event(window.permissionListeners.added),onRemoved:event(window.permissionListeners.removed),contains:async()=>window.access.granted,request:async(value)=>{window.access.requests.push(value);window.access.granted=window.access.allow;return window.access.allow;}},runtime:{sendMessage:async(value)=>{window.access.messages.push(value);return {ok:true};}}};
createRoot(document.getElementById("root")).render(React.createElement(ReadingAccess));`,
      resolveDir: process.cwd(),
      loader: "js",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    plugins: [
      {
        name: "fixture-browser",
        setup(builder) {
          builder.onResolve({ filter: /^wxt\/browser$/ }, () => ({
            path: "browser",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents:
              "export const browser=new Proxy({}, {get:(_,key)=>window.browser[key]});",
          }));
        },
      },
    ],
  });
  const css = (
    await Promise.all(
      [
        "apps/browser-extension/src/base.css",
        "apps/browser-extension/src/settings-workspace.css",
      ].map((path) => readFile(path, "utf8")),
    )
  ).join("\n");
  await page.setContent(
    `<style>${css}</style><body class="options-page"><main><div id="root"></div></main></body>`,
  );
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  const access = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            access: {
              allow: boolean;
              requests: unknown[];
              messages: unknown[];
            };
          }
        ).access,
    );
  await expect(
    page.getByRole("heading", { name: "让悬浮球自动出现在网页上" }),
  ).toBeVisible();
  expect((await access()).requests).toEqual([]);
  expect((await access()).messages).toEqual([]);
  await page.getByRole("button", { name: "启用网页悬浮球" }).click();
  await expect(page.getByRole("alert")).toContainText("尚未获得网页访问权限");
  expect((await access()).messages).toEqual([]);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 360, height: 800 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(360);
    await page.screenshot({
      path: `.cache/ui/reading-access-${colorScheme}.png`,
    });
  }
  await page.evaluate(() => {
    (window as unknown as { access: { allow: boolean } }).access.allow = true;
  });
  await page.getByRole("button", { name: "启用网页悬浮球" }).click();
  await expect(
    page.getByRole("region", { name: "网页悬浮入口授权" }),
  ).toHaveCount(0);
  expect((await access()).requests).toEqual([
    { origins: ["https://*/*", "http://*/*"] },
    { origins: ["https://*/*", "http://*/*"] },
  ]);
  expect((await access()).messages).toEqual([
    { action: "reading-access-sync" },
  ]);
  await page.evaluate(() => {
    const fixture = window as unknown as {
      access: { granted: boolean };
      permissionListeners: { removed: Set<() => void> };
    };
    fixture.access.granted = false;
    for (const listener of fixture.permissionListeners.removed) listener();
  });
  await expect(
    page.getByRole("button", { name: "启用网页悬浮球" }),
  ).toBeVisible();
  expect((await access()).requests).toHaveLength(2);
  await page.evaluate(async () => {
    const fixture = window as unknown as {
      browser: { permissions: { contains: () => Promise<boolean> } };
      permissionListeners: { added: Set<() => void>; removed: Set<() => void> };
    };
    const pending: ((value: boolean) => void)[] = [];
    fixture.browser.permissions.contains = () =>
      new Promise((resolve) => pending.push(resolve));
    for (const listener of fixture.permissionListeners.added) listener();
    for (const listener of fixture.permissionListeners.removed) listener();
    pending[1]!(false);
    pending[0]!(true);
    await new Promise(requestAnimationFrame);
  });
  await expect(
    page.getByRole("button", { name: "启用网页悬浮球" }),
  ).toBeVisible();
});
