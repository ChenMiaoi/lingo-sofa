import { test, expect } from "@playwright/test";
import { build } from "esbuild";

test("retains account edits, distinguishes committed saves from failed refreshes and refreshes without resaving", async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents: `
import React from "react";
import {createRoot} from "react-dom/client";
import {createProviderEditor} from "./packages/ui-shared/src/index.ts";
const Editor=createProviderEditor(()=>React);
const model={provider:"deepseek",authMode:"api_key",model:"flash",accountId:"work",endpoint:"https://api.deepseek.com",maxOutputTokens:0,timeoutMs:30000,prices:null};
let catalog={model,accounts:[{id:"work",name:"Work",model,keyConfigured:true}],keyConfigured:true,piAuth:false,providers:[{id:"deepseek",name:"DeepSeek",models:[{id:"flash",endpoint:model.endpoint,api:"openai-completions"}]}]};
window.saved=[];window.failRefresh=false;window.closedCount=0;
const client={providers:async()=>{if(window.failRefresh)throw Error("refresh failed");return catalog;},configureProvider:async(update)=>{window.saved.push(update);catalog={...catalog,accounts:[{...catalog.accounts[0],name:update.accountName,model:update.model}]};window.failRefresh=true;return {ok:true};}};
createRoot(document.getElementById("root")).render(<Editor client={client} onClose={()=>{window.closedCount=(window.closedCount??0)+1;}}/>);
`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "transform",
    jsxFactory: "React.createElement",
  });
  await page.setContent(
    '<div id="root" style="max-width:960px;margin:auto"></div>',
  );
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  await page.getByLabel("连接名称").fill("工作账户");
  await page.getByRole("button", { name: "返回", exact: true }).click();
  const guard = page.getByRole("alertdialog", { name: "未保存的更改" });
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "继续编辑" }).click();
  await expect(page.getByLabel("连接名称")).toHaveValue("工作账户");
  await page.getByLabel("API Key").fill("synthetic-replacement");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "配置已保存，但列表刷新失败",
  );
  await expect(page.getByRole("status")).toContainText("供应商已保存");
  await expect(page.getByLabel("API Key")).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "保存配置", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => {
    Object.assign(window, { failRefresh: false });
  });
  await page.getByRole("button", { name: "刷新列表", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("连接名称")).toHaveValue("工作账户");
  expect(
    await page.evaluate(
      () => (window as unknown as { saved: unknown[] }).saved.length,
    ),
  ).toBe(1);
  await page.getByLabel("连接名称").fill("待放弃名称");
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await guard.getByRole("button", { name: "放弃更改并继续" }).click();
  await expect(page.getByLabel("连接名称")).toHaveValue("工作账户");
});

test("shows per-source cleanup results and retries only the failed source", async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents: `
import React from "react";
import {createRoot} from "react-dom/client";
import {PrivacyPreferences} from "./apps/browser-extension/src/PrivacyPreferences.tsx";
import {settingsSchema} from "./packages/protocol/src/index.ts";
import {designStyles} from "./packages/ui-shared/src/index.ts";
import baseCss from "./apps/browser-extension/src/base.css";
import workspaceCss from "./apps/browser-extension/src/settings-workspace.css";
window.calls=[];
const clearData=async(targets)=>{window.calls.push(targets??null);return targets?targets.map(target=>({target,ok:true})):[{target:"browser-data",ok:true},{target:"translation-cache",ok:true},{target:"assistant-data",ok:false,error:"本地助手暂时无法连接"}];};
createRoot(document.getElementById("root")).render(<section className="ls-product-settings"><style>{baseCss+workspaceCss+designStyles}</style><div className="ls-product-content"><header className="ls-design-heading"><h1>隐私与数据</h1></header><PrivacyPreferences preferences={{settings:settingsSchema.parse({mode:"bridge"}),busy:false,update:async()=>true,clearData}}/></div></section>);
`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".css": "text" },
    plugins: [
      {
        name: "browser-fixture",
        setup(builder) {
          builder.onResolve({ filter: /^wxt\/browser$/ }, () => ({
            path: "browser",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents:
              "export const browser={runtime:{sendMessage:async()=>({ok:true,preferences:{enabled:true,days:7}})},storage:{onChanged:{addListener(){},removeListener(){}}}};",
          }));
        },
      },
    ],
  });
  await page.setContent(
    '<div id="root" style="max-width:960px;margin:auto"></div>',
  );
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  await page
    .getByRole("button", { name: "清除缓存、会话与用量", exact: true })
    .click();
  await page.getByRole("button", { name: "确认清除", exact: true }).click();
  const results = page.getByRole("list", { name: "数据清理结果" });
  await expect(results).toContainText("浏览器会话与用量 · 已清除");
  await expect(results).toContainText("本地助手中的浏览器会话与用量 · 未完成");
  await page.screenshot({
    path: ".cache/ui/cleanup-partial-light.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "仅重试未完成项目", exact: true })
    .click();
  await expect(results).toContainText("本地助手中的浏览器会话与用量 · 已清除");
  await expect(
    page.getByRole("button", { name: "仅重试未完成项目", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { calls: unknown[] }).calls,
    ),
  ).toEqual([null, ["assistant-data"]]);
});
