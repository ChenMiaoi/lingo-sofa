import { test, expect } from "@playwright/test";
import { build } from "esbuild";

interface AccessFixture {
  allow: boolean;
  serviceGranted: boolean;
  engine: "llm" | "bing";
  events: { kind: string; [key: string]: unknown }[];
}

async function popupFixture(
  page: import("@playwright/test").Page,
  engine: AccessFixture["engine"] = "llm",
) {
  const bundle = await build({
    stdin: {
      contents: `import React from "react";
import {createRoot} from "react-dom/client";
import {settingsSchema} from "./packages/protocol/src/index.ts";
import {QuickPopup} from "./apps/browser-extension/src/QuickPopup.tsx";
const settings=settingsSchema.parse({mode:"direct"});
window.access={allow:true,serviceGranted:false,engine:${JSON.stringify(engine)},events:[]};
const access=window.access;
window.browser={
  permissions:{onAdded:{addListener(){},removeListener(){}},onRemoved:{addListener(){},removeListener(){}},contains:async request=>access.serviceGranted&&request.origins.every(origin=>origin==="https://edge.microsoft.com/*"),request:request=>{access.events.push({kind:"permission",...request});return Promise.resolve(access.allow);}},
  runtime:{getManifest:()=>({version:"0.1.9"}),getURL:path=>"chrome-extension://fixture"+path,sendMessage:async message=>{access.events.push({kind:"message",...message});if(message.action==="page-status")return {supported:true,origin:"https://reading.test",hostname:"reading.test",hasSelection:true,translated:false,pending:false,readingEnabled:true};if(message.action==="state")return {settings};if(message.action==="provider-catalog")return {model:settings.model,translationEngine:access.engine,keyConfigured:true,piAuth:false,providers:[]};return {ok:true};}}
};
createRoot(document.getElementById("root")).render(<QuickPopup/>);`,
      resolveDir: process.cwd(),
      loader: "tsx",
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
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  await expect(
    page.getByRole("button", { name: "翻译页面", exact: true }),
  ).toBeEnabled();
}

function actions(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    (window as unknown as { access: AccessFixture }).access.events.filter(
      (event) =>
        event.kind === "permission" ||
        !["state", "provider-catalog", "page-status"].includes(
          String(event.action),
        ),
    ),
  );
}

test("persists only the current site's launcher access from the popup without enabling automatic translation", async ({
  page,
}) => {
  await popupFixture(page);
  expect(await actions(page)).toEqual([]);
  await page
    .getByRole("button", { name: "显示网页悬浮球", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("重开浏览器后自动显示");
  expect(await actions(page)).toEqual([
    { kind: "permission", origins: ["https://reading.test/*"] },
    { kind: "message", action: "reading-access-sync" },
    { kind: "message", action: "page", command: "controls" },
  ]);
  await page.getByRole("button", { name: "翻译页面", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("翻译已开始");
  expect((await actions(page)).slice(-3)).toEqual([
    { kind: "permission", origins: ["https://reading.test/*"] },
    { kind: "message", action: "reading-access-sync" },
    { kind: "message", action: "page", command: "page" },
  ]);
});

test("keeps temporary reading usable after persistent site access is declined", async ({
  page,
}) => {
  await popupFixture(page);
  await page.evaluate(() => {
    (window as unknown as { access: AccessFixture }).access.allow = false;
  });
  await page
    .getByRole("button", { name: "显示网页悬浮球", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("本次为临时启用");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await actions(page)).toEqual([
    { kind: "permission", origins: ["https://reading.test/*"] },
    { kind: "message", action: "page", command: "controls" },
  ]);
});

test("combines site and free-service authorization and blocks unavailable service access", async ({
  page,
}) => {
  await popupFixture(page, "bing");
  await page.evaluate(() => {
    (window as unknown as { access: AccessFixture }).access.allow = false;
  });
  await page.getByRole("button", { name: "翻译页面", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "需要允许访问所选翻译服务",
  );
  expect(await actions(page)).toEqual([
    {
      kind: "permission",
      origins: ["https://reading.test/*", "https://edge.microsoft.com/*"],
    },
  ]);
  await page.evaluate(() => {
    (window as unknown as { access: AccessFixture }).access.serviceGranted =
      true;
  });
  await page.getByRole("button", { name: "翻译页面", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("翻译已开始");
  expect((await actions(page)).at(-1)).toEqual({
    kind: "message",
    action: "page",
    command: "page",
  });
  await page.evaluate(() => {
    (window as unknown as { access: AccessFixture }).access.allow = true;
  });
  await page
    .getByRole("button", { name: "显示网页悬浮球", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("重开浏览器后自动显示");
  expect((await actions(page)).slice(-3)).toEqual([
    {
      kind: "permission",
      origins: ["https://reading.test/*", "https://edge.microsoft.com/*"],
    },
    { kind: "message", action: "reading-access-sync" },
    { kind: "message", action: "page", command: "controls" },
  ]);
});
