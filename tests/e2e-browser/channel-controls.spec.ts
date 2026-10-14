import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { pluginStyles } from "../../apps/discord-vencord/src/styles.js";

test("keeps the reading switch independent of automatic translation", async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "js",
      contents: `import React from "react";
import {createRoot} from "react-dom/client";
import {ChannelControls} from "./apps/discord-vencord/src/channel-controls.tsx";
const catalog={model:{provider:"fixture",model:"flash",endpoint:"https://fixture.example",maxOutputTokens:512,timeoutMs:30000,prices:null},keyConfigured:true,piAuth:false,providers:[{id:"fixture",name:"Fixture",models:[{id:"flash",endpoint:"https://fixture.example",api:"openai-completions"},{id:"pro",endpoint:"https://fixture.example",api:"openai-completions"}]}]};
window.events=[];
function App(){const [enabled,setEnabled]=React.useState(true);const [language,setLanguage]=React.useState("简体中文");const [automatic,setAutomatic]=React.useState(false);const [model,setModel]=React.useState("flash");const [busy,setBusy]=React.useState(false);window.setBusy=setBusy;
return React.createElement(ChannelControls,{enabled,onEnabled:()=>setEnabled(!enabled),channel:"a-long-channel-name-that-should-never-break-the-panel-layout",language,automatic,catalog:{...catalog,model:{...catalog.model,model}},busy,notice:"",onLanguage:value=>{window.events.push(["language",value]);setLanguage(value);},onModel:value=>{window.events.push(["model",value]);setModel(value);},onAutomatic:()=>{window.events.push(["automatic",!automatic]);setAutomatic(!automatic);},onClose:()=>window.events.push(["close"])});}
createRoot(document.getElementById("root")).render(React.createElement(App));`,
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
    `<style>${pluginStyles}</style><section class="lingo-sofa-channel-panel lingo-sofa-panel" id="root"></section>`,
  );
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  await expect(page.getByRole("combobox")).toHaveCount(2);
  await expect(page.getByRole("switch")).toHaveCount(2);
  await expect(
    page.getByText(/更多操作|只显示原文|Ask Pi|供应商设置|用量与草稿/),
  ).toHaveCount(0);
  await page.getByLabel("目标语言", { exact: true }).selectOption("日本語");
  await expect(page.getByLabel("目标语言", { exact: true })).toHaveValue(
    "日本語",
  );
  await page.getByLabel("模型", { exact: true }).selectOption("pro");
  await expect(page.getByLabel("模型", { exact: true })).toHaveValue("pro");
  await page.getByRole("switch", { name: "自动翻译此频道" }).check();
  await expect(
    page.getByRole("switch", { name: "自动翻译此频道" }),
  ).toBeChecked();
  await page.getByRole("switch", { name: "开启双语阅读" }).uncheck();
  await expect(
    page.getByRole("switch", { name: "自动翻译此频道" }),
  ).toBeChecked();
  await expect(
    page.getByRole("switch", { name: "自动翻译此频道" }),
  ).toBeDisabled();
  await expect(page.getByLabel("目标语言", { exact: true })).toBeDisabled();
  await page.getByRole("switch", { name: "开启双语阅读" }).check();
  await expect(
    page.getByRole("switch", { name: "自动翻译此频道" }),
  ).toBeChecked();
  await page.getByRole("switch", { name: "自动翻译此频道" }).uncheck();
  expect(
    await page.evaluate(
      () => (window as unknown as { events: unknown[] }).events,
    ),
  ).toEqual([
    ["language", "日本語"],
    ["model", "pro"],
    ["automatic", true],
    ["automatic", false],
  ]);
  await page.evaluate(() =>
    (window as unknown as { setBusy: (busy: boolean) => void }).setBusy(true),
  );
  await expect(page.getByLabel("模型", { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("switch", { name: "自动翻译此频道" }),
  ).toBeDisabled();
  for (const dark of [true, false]) {
    const foreground = dark ? "rgb(219, 222, 225)" : "rgb(49, 51, 56)";
    await page.evaluate(
      ({ foreground, dark }) => {
        document.documentElement.style.setProperty(
          "--text-default",
          foreground,
        );
        document.documentElement.style.setProperty(
          "--background-base-lowest",
          dark ? "#1e1f22" : "#ffffff",
        );
      },
      { foreground, dark },
    );
    expect(
      await page
        .getByLabel("目标语言", { exact: true })
        .evaluate((node) => getComputedStyle(node).color),
    ).toBe(foreground);
    await page.setViewportSize({ width: 280, height: 400 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(280);
  }
});
