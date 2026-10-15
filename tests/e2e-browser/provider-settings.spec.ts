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
let catalog = {model:{provider:"deepseek",model:"deepseek-flash",endpoint:"https://api.deepseek.com",maxOutputTokens:512,timeoutMs:30000,prices:null},keyConfigured:true,piAuth:false,oauth:{connected:false,phase:"idle"},providers:[{id:"deepseek",name:"DeepSeek",models:[{id:"deepseek-flash",endpoint:"https://api.deepseek.com",api:"openai-completions",thinkingLevels:["off","low","high","max"]}]},{id:"openai",name:"OpenAI",models:[{id:"gpt-4o",endpoint:"https://api.openai.com/v1",api:"openai-completions"}]}]};
window.saved=[]; window.fail=false; window.oauth={connected:false,phase:"idle"};
createRoot(document.getElementById("root")).render(React.createElement(ProviderSettings,{client:{oauth:async(action)=>{if(action==="start")window.oauth={connected:false,phase:"pending",authorizationUrl:"https://auth.openai.com/api/accounts/authorize?state=fixture"};if(action==="logout"||action==="cancel")window.oauth={connected:false,phase:"idle"};return window.oauth;},providers:async()=>catalog,configureProvider:async(value)=>{if(window.fail)throw Error("fixture failure");window.saved.push(value);catalog={...catalog,model:value.model,keyConfigured:true};return {ok:true};}},onSaved:()=>{window.cleared=true;}}));`,
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
  await expect(page.getByLabel("翻译模型", { exact: true })).toHaveValue(
    "current:deepseek-flash",
  );
  await expect(
    page.getByRole("button", { name: "管理连接", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "翻译模型", exact: true }).click();
  const settings = page.getByRole("region", { name: "连接服务商" });
  await expect(settings.getByLabel("API Key")).toHaveCount(0);
  await expect(
    settings.getByLabel(
      /Local Bridge port|Translation language|Explicitly enabled/,
    ),
  ).toHaveCount(0);
  await settings.getByLabel("思考强度", { exact: true }).selectOption("high");
  await expect(settings.getByLabel("思考强度", { exact: true })).toHaveValue(
    "high",
  );
  await settings.getByLabel("查找供应商或模型").fill("OpenAI");
  await settings.getByLabel("供应商", { exact: true }).selectOption("openai");
  await expect(settings.getByLabel("查找供应商或模型")).toHaveValue("");
  await expect(settings.getByLabel("思考强度", { exact: true })).toHaveValue(
    "",
  );
  await expect(settings.getByLabel("思考强度", { exact: true })).toBeDisabled();
  await expect(settings.getByLabel("模型", { exact: true })).toHaveValue(
    "gpt-4o",
  );
  await expect(
    settings.getByRole("button", { name: "保存配置" }),
  ).toBeDisabled();
  await expect(settings.getByLabel("API Key")).toHaveAttribute(
    "type",
    "password",
  );
  await settings.getByLabel("API Key").fill("fixture-openai-key");
  await page.evaluate(() => {
    (window as unknown as { fail: boolean }).fail = true;
  });
  await settings.getByRole("button", { name: "保存配置" }).click();
  await expect(settings.getByRole("alert")).toContainText("保存失败");
  await page.evaluate(() => {
    (window as unknown as { fail: boolean }).fail = false;
  });
  await settings.getByRole("button", { name: "保存配置" }).click();
  await expect(settings.getByRole("status")).toContainText("已保存");
  await expect(settings.getByLabel("API Key")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { saved: unknown[] }).saved,
    ),
  ).toEqual([
    {
      target: "translation",
      model: {
        provider: "openai",
        authMode: "api_key",
        model: "gpt-4o",
        endpoint: "https://api.openai.com/v1",
        maxOutputTokens: 512,
        timeoutMs: 30000,
        prices: null,
      },
      apiKey: "fixture-openai-key",
    },
  ]);
  await settings
    .getByRole("button", { name: "ChatGPT 订阅", exact: true })
    .click();
  await expect(settings.getByLabel("API Key")).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "保存配置" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "使用 ChatGPT 登录", exact: true })
    .click();
  await expect(settings.getByRole("link", { name: /继续前往/ })).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { oauth: unknown }).oauth = {
      connected: true,
      phase: "idle",
    };
  });
  await expect(
    settings.getByRole("button", { name: "保存配置" }),
  ).toBeEnabled();
  await settings.getByRole("button", { name: "保存配置" }).click();
  await expect(
    settings.getByText("翻译配置已保存，不影响 Ask 会话", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as { saved: { model: { authMode: string } }[] }
        ).saved.at(-1)?.model.authMode,
    ),
  ).toBe("subscription");
  await settings
    .getByRole("button", { name: "退出本机登录", exact: true })
    .click();
  await expect(
    settings.getByRole("button", { name: "保存配置" }),
  ).toBeDisabled();
  await page
    .getByLabel("供应商", { exact: true })
    .selectOption("openai-compatible");
  await expect(settings.getByLabel("API 地址")).toBeVisible();
  await expect(settings.getByLabel("模型", { exact: true })).toHaveValue("");
  await page.setViewportSize({ width: 400, height: 800 });
  const provider = await settings
    .getByLabel("供应商", { exact: true })
    .boundingBox();
  const model = await settings
    .getByLabel("模型", { exact: true })
    .boundingBox();
  expect(model!.y).toBeGreaterThan(provider!.y + provider!.height);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(400);
});
