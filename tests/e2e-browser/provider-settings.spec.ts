import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { pluginStyles } from "../../apps/discord-vencord/src/styles.js";

test("configures multiple providers in the actual compact settings component", async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents: `import React from "react";
import {createRoot} from "react-dom/client";
import {ProviderSettings} from "./apps/discord-vencord/src/provider-settings.tsx";
let catalog = {model:{provider:"deepseek",model:"deepseek-flash",endpoint:"https://api.deepseek.com",maxOutputTokens:512,timeoutMs:30000,prices:null},keyConfigured:true,piAuth:false,providers:[{id:"deepseek",name:"DeepSeek",models:[{id:"deepseek-flash",endpoint:"https://api.deepseek.com",api:"openai-completions"}]},{id:"openai",name:"OpenAI",models:[{id:"gpt-4o",endpoint:"https://api.openai.com/v1",api:"openai-completions"}]}]};
window.saved=[]; window.fail=false;
createRoot(document.getElementById("root")).render(React.createElement(ProviderSettings,{client:{providers:async()=>catalog,configureProvider:async(value)=>{if(window.fail)throw Error("fixture failure");window.saved.push(value);catalog={...catalog,model:value.model,keyConfigured:true};return {ok:true};}},onSaved:()=>{window.cleared=true;}}));`,
      resolveDir: process.cwd(),
      loader: "js",
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
            contents: 'export { default as React } from "react";',
            resolveDir: process.cwd(),
          }));
        },
      },
    ],
  });
  await page.setContent(
    `<style>:root {--text-default:#dbdee1; --background-base-lowest:#1e1f22} body{background:#1e1f22}${pluginStyles}</style><div id="root"></div>`,
  );
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  await expect(page.getByText("本地助手已连接", { exact: true })).toBeVisible();
  await expect(page.getByLabel("API Key")).toHaveAttribute("type", "password");
  await expect(page.getByLabel("API Key")).toHaveValue("");
  await expect(
    page.getByLabel(
      /Local Bridge port|Translation language|Explicitly enabled/,
    ),
  ).toHaveCount(0);
  await page.getByLabel("供应商", { exact: true }).selectOption("openai");
  await expect(page.getByLabel("模型", { exact: true })).toHaveValue("gpt-4o");
  await expect(page.getByRole("button", { name: "保存配置" })).toBeDisabled();
  await page.getByLabel("API Key").fill("fixture-openai-key");
  await page.evaluate(() => {
    (window as unknown as { fail: boolean }).fail = true;
  });
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByRole("alert")).toContainText("保存失败");
  await page.evaluate(() => {
    (window as unknown as { fail: boolean }).fail = false;
  });
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByRole("status")).toContainText("已保存");
  await expect(page.getByLabel("API Key")).toHaveValue("");
  expect(
    await page.evaluate(
      () => (window as unknown as { saved: unknown[] }).saved,
    ),
  ).toEqual([
    {
      model: {
        provider: "openai",
        model: "gpt-4o",
        endpoint: "https://api.openai.com/v1",
        maxOutputTokens: 512,
        timeoutMs: 30000,
        prices: null,
      },
      apiKey: "fixture-openai-key",
    },
  ]);
  await page
    .getByLabel("供应商", { exact: true })
    .selectOption("openai-compatible");
  await expect(page.getByLabel("API 地址")).toBeVisible();
  await expect(page.getByLabel("模型", { exact: true })).toHaveValue("");
  await page.setViewportSize({ width: 400, height: 800 });
  const provider = await page
    .getByLabel("供应商", { exact: true })
    .boundingBox();
  const model = await page.getByLabel("模型", { exact: true }).boundingBox();
  expect(model!.y).toBeGreaterThan(provider!.y + provider!.height);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(400);
});
