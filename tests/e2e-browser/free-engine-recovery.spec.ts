import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";

async function loadSettings(page: Page) {
  const bundle = await build({
    stdin: {
      contents: `
import React from "react";
import {createRoot} from "react-dom/client";
import {createAISettings,designStyles} from "./packages/ui-shared/src/index.ts";
const Settings=createAISettings(()=>React);
const model={provider:"openai-compatible",model:"saved-model",authMode:"api_key",endpoint:"https://unavailable.test/v1",maxOutputTokens:0,timeoutMs:30000,prices:null};
const catalog={translationEngine:"llm",model,keyConfigured:true,piAuth:false,accounts:[],providers:[{id:"openai-compatible",name:"Custom",models:[{id:"saved-model"},{id:"another-model"}]}]};
window.loads=[];window.saved=[];window.failSave=false;
window.complete=(index,engine)=>window.loads[index].resolve({...catalog,translationEngine:engine});
window.reject=(index)=>window.loads[index].reject(Error("Model connection unavailable"));
const client={providers:()=>new Promise((resolve,reject)=>window.loads.push({resolve,reject})),configureProvider:async(update)=>{if(window.failSave)return {ok:false,error:"保存失败"};window.saved.push(update);return {ok:true};}};
createRoot(document.getElementById("root")).render(<><style>{designStyles}</style><Settings client={client} section="translation"/></>);
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
    '<div id="root" style="max-width:960px;margin:32px auto"></div>',
  );
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
}

type FixtureWindow = typeof window & {
  complete: (index: number, engine: string) => void;
  reject: (index: number) => void;
  loads: unknown[];
  saved: unknown[];
  failSave: boolean;
};

test("switches free engines while model settings are pending and ignores stale refreshes", async ({
  page,
}) => {
  await loadSettings(page);
  const bing = page.getByRole("button", { name: "必应翻译 免 Key" });
  const google = page.getByRole("button", { name: "谷歌翻译 免 Key" });
  const llm = page.getByRole("button", { name: "大模型翻译 使用模型账户" });
  await expect(bing).toBeEnabled();
  await expect(google).toBeEnabled();
  await expect(llm).toBeDisabled();
  await expect(llm).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByText("正在读取已保存的翻译配置…", { exact: true }),
  ).toBeVisible();
  await bing.click();
  await expect(bing).toHaveAttribute("aria-pressed", "true");
  await expect(google).toBeEnabled();
  await google.click();
  await expect(google).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => {
    const fixture = window as FixtureWindow;
    fixture.complete(0, "llm");
    fixture.complete(1, "bing");
    fixture.reject(2);
  });
  await expect(page.getByRole("alert")).toContainText("仍可切换免 Key 翻译");
  await expect(google).toHaveAttribute("aria-pressed", "true");
  await expect(bing).toBeEnabled();
  await expect(page.getByRole("status")).toHaveText(
    "翻译引擎已保存，不影响 Ask 会话",
  );
  expect(await page.evaluate(() => (window as FixtureWindow).saved)).toEqual([
    { target: "translation-engine", engine: "bing" },
    { target: "translation-engine", engine: "google" },
  ]);
});

test("keeps free engines usable after model settings fail and preserves the selection when saving fails", async ({
  page,
}) => {
  await loadSettings(page);
  await expect
    .poll(() => page.evaluate(() => (window as FixtureWindow).loads.length))
    .toBe(1);
  await page.evaluate(() => (window as FixtureWindow).reject(0));
  await expect(page.getByRole("alert")).toContainText("仍可切换免 Key 翻译");
  const google = page.getByRole("button", { name: "谷歌翻译 免 Key" });
  const bing = page.getByRole("button", { name: "必应翻译 免 Key" });
  await google.click();
  await expect(google).toHaveAttribute("aria-pressed", "true");
  await expect(bing).toBeEnabled();
  await page.evaluate(() => {
    (window as FixtureWindow).failSave = true;
    (window as FixtureWindow).reject(1);
  });
  await bing.click();
  await expect(page.getByRole("alert")).toContainText("保存失败");
  await expect(google).toHaveAttribute("aria-pressed", "true");
  await expect(bing).toHaveAttribute("aria-pressed", "false");
});

test("allows free translation while the model list refreshes after saving a model", async ({
  page,
}) => {
  await loadSettings(page);
  await expect
    .poll(() => page.evaluate(() => (window as FixtureWindow).loads.length))
    .toBe(1);
  await page.evaluate(() => (window as FixtureWindow).complete(0, "llm"));
  await page
    .getByLabel("翻译模型", { exact: true })
    .selectOption("current:another-model");
  await expect(page.getByRole("status")).toHaveText(
    "翻译模型已保存，不影响 Ask 会话",
  );
  const google = page.getByRole("button", { name: "谷歌翻译 免 Key" });
  await expect(google).toBeEnabled();
  await google.click();
  await expect(google).toHaveAttribute("aria-pressed", "true");
  await expect(google).toBeEnabled();
});
