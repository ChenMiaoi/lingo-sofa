import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";

async function mount(page: Page, contents: string) {
  const bundle = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: "tsx" },
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
}

test("keeps newer preferences when startup snapshots return late", async ({
  page,
}) => {
  await mount(
    page,
    `
import React from "react";
import {createRoot} from "react-dom/client";
import {settingsSchema} from "./packages/protocol/src/index.ts";
import {useSettingsPreferences} from "./apps/browser-extension/src/useSettingsPreferences.ts";
const listeners=new Set();
let initialSettings,initialTheme;
window.browser={storage:{local:{get:()=>new Promise(resolve=>{initialTheme=resolve;})},onChanged:{addListener:listener=>listeners.add(listener),removeListener:listener=>listeners.delete(listener)}},runtime:{sendMessage:()=>new Promise(resolve=>{initialSettings=resolve;})}};
window.newPreferences=()=>{for(const listener of listeners)listener({uiTheme:{newValue:"light"},settings:{newValue:settingsSchema.parse({mode:"direct",targetLanguage:"English"})}},"local");};
window.oldSnapshot=()=>{initialTheme({uiTheme:"dark"});initialSettings({settings:settingsSchema.parse({mode:"direct",targetLanguage:"简体中文"})});};
function Host(){const preferences=useSettingsPreferences();return <><output aria-label="已保存语言">{preferences.settings?.targetLanguage??"正在读取"}</output><output aria-label="已保存主题">{preferences.theme}</output></>;}
createRoot(document.getElementById("root")).render(<Host/>);`,
  );
  await expect(page.getByLabel("已保存语言")).toHaveText("正在读取");
  await page.evaluate(() =>
    (window as unknown as { newPreferences: () => void }).newPreferences(),
  );
  await expect(page.getByLabel("已保存语言")).toHaveText("English");
  await page.evaluate(async () => {
    (window as unknown as { oldSnapshot: () => void }).oldSnapshot();
    await new Promise(requestAnimationFrame);
  });
  await expect(page.getByLabel("已保存语言")).toHaveText("English");
  await expect(page.getByLabel("已保存主题")).toHaveText("light");
});

test("restores a failed language choice and rejects a stale page-controls snapshot", async ({
  page,
}) => {
  await mount(
    page,
    `
import {createPageControls} from "./apps/browser-extension/src/page-controls.ts";
const event={addListener(){},removeListener(){}};
window.browser={runtime:{getURL:path=>"chrome-extension://fixture"+path,onMessage:event,sendMessage:async message=>message.action==="appearance"?{uiTheme:"light"}:{ok:true,preferences:{side:"right",y:.68,autoHide:false}}},storage:{onChanged:event}};
const pending=[];
const state=window.fixture={language:"English",fail:false,delay:false,release:()=>{for(const resolve of pending.splice(0))resolve();}};
window.reader=createPageControls(document,{translateSelection:async()=>{},translatePage:async()=>{},stop(){},pause(){},usage:async()=>({}),usageSettings(){},ask(){},settings(){},enabled:async()=>{},model:async()=>{},automatic:async()=>({ok:true}),language:async value=>{if(state.fail)throw Error("语言保存失败");state.language=value;},configuration:()=>{const snapshot={readingEnabled:true,automatic:false,targetLanguage:state.language,model:"fixture",models:["fixture"],providerName:"Fixture"};return state.delay?new Promise(resolve=>{pending.push(()=>resolve(snapshot));}):Promise.resolve(snapshot);}});
window.reader.setEnabled(true);window.reader.setLanguage("English");window.reader.setAutomatic(false);
window.reader.open();`,
  );
  const language = page.getByRole("combobox", {
    name: "目标语言",
    exact: true,
  });
  await expect(language).toHaveValue("English");
  await page.evaluate(() => {
    (window as unknown as { fixture: { fail: boolean } }).fixture.fail = true;
  });
  await language.focus();
  await language.press("ArrowDown");
  await expect(page.getByText("语言保存失败", { exact: true })).toBeVisible();
  await expect(language).toHaveValue("English");
  await page.evaluate(() => {
    const host = window as unknown as {
      fixture: { fail: boolean; delay: boolean };
      reader: { open: () => void };
    };
    host.fixture.fail = false;
    host.fixture.delay = true;
    host.reader.open();
  });
  await language.focus();
  await language.press("ArrowDown");
  await expect(language).toBeEnabled();
  await page.evaluate(async () => {
    (
      window as unknown as { fixture: { release: () => void } }
    ).fixture.release();
    await new Promise(requestAnimationFrame);
  });
  await expect(language).toHaveValue("日本語");
});

test("loads saved settings even when reading the initial theme fails", async ({
  page,
}) => {
  await mount(
    page,
    `
import React from "react";
import {createRoot} from "react-dom/client";
import {settingsSchema} from "./packages/protocol/src/index.ts";
import {useSettingsPreferences} from "./apps/browser-extension/src/useSettingsPreferences.ts";
const event={addListener(){},removeListener(){}};
window.browser={storage:{local:{get:async()=>{throw Error("Theme read failed");}},onChanged:event},runtime:{sendMessage:async()=>({settings:settingsSchema.parse({mode:"direct",targetLanguage:"English"})})}};
function Host(){const preferences=useSettingsPreferences();return <><output aria-label="已保存语言">{preferences.settings?.targetLanguage??"正在读取"}</output>{preferences.failure&&<p role="alert">{preferences.failure}</p>}</>;}
createRoot(document.getElementById("root")).render(<Host/>);`,
  );
  await expect(page.getByLabel("已保存语言")).toHaveText("English");
  await expect(page.getByRole("alert")).toContainText("无法读取外观偏好");
});
