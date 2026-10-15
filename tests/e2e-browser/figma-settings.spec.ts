import { test, expect } from "@playwright/test";
import { build } from "esbuild";

test("automatically saves task models independently, rolls back failures and returns from inline account editing", async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents: `
import React from "react";
import {createRoot} from "react-dom/client";
import {createAISettings} from "./packages/ui-shared/src/index.ts";
const Settings=createAISettings(()=>React);
const base={provider:"deepseek",authMode:"api_key",model:"flash",endpoint:"https://api.deepseek.com",maxOutputTokens:0,timeoutMs:30000,prices:null};
let catalog={model:{...base,accountId:"work"},askModel:{...base,accountId:"personal"},accounts:[{id:"work",name:"Work",model:base,keyConfigured:true},{id:"personal",name:"Personal",model:base,keyConfigured:true}],keyConfigured:true,piAuth:false,providers:[{id:"deepseek",name:"DeepSeek",models:[{id:"flash",endpoint:base.endpoint,api:"openai-completions",thinkingLevels:["low","high"]},{id:"pro",endpoint:base.endpoint,api:"openai-completions",thinkingLevels:["high"]}]}]};
window.saved=[];window.fail=false;
createRoot(document.getElementById("root")).render(<Settings client={{providers:async()=>catalog,configureProvider:async(update)=>{if(window.fail)throw Error("fixture failure");window.saved.push(update);catalog={...catalog,[update.target==="translation"?"model":"askModel"]:update.model};return {ok:true};}}}/>);
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
    '<div id="root" style="max-width:824px;margin:36px auto"></div>',
  );
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  await page.getByLabel("翻译模型", { exact: true }).selectOption("work:pro");
  await expect(page.getByRole("status")).toContainText("不影响 Ask");
  await expect(page.getByLabel("Ask 默认模型", { exact: true })).toHaveValue(
    "personal:flash",
  );
  await page.getByLabel("思考程度").selectOption("high");
  await expect(page.getByRole("status")).toContainText("已有会话保持原配置");
  await expect(page.getByLabel("翻译模型", { exact: true })).toHaveValue(
    "work:pro",
  );
  await page.evaluate(() => {
    (window as unknown as { fail: boolean }).fail = true;
  });
  await page
    .getByLabel("翻译模型", { exact: true })
    .selectOption("personal:flash");
  await expect(page.getByRole("alert")).toContainText("fixture failure");
  await expect(page.getByLabel("翻译模型", { exact: true })).toHaveValue(
    "work:pro",
  );
  const changes = await page.evaluate(
    () =>
      (
        window as unknown as {
          saved: {
            target: string;
            model: { model: string; thinkingLevel?: string };
          }[];
        }
      ).saved,
  );
  expect(changes.map((change) => change.target)).toEqual([
    "translation",
    "ask-default",
  ]);
  expect(changes[1]!.model.thinkingLevel).toBe("high");
  await page.getByRole("button", { name: "供应商", exact: true }).click();
  await expect(page.getByRole("region", { name: "连接服务商" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expect(page.getByRole("region", { name: "连接服务商" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "供应商", exact: true }),
  ).toBeFocused();
});

test("opens a single contextual Ask shell, follows its source and keeps the composer visible", async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents: `
import {askStyles,attachAskWindow,textAnchorRect,registerAskShortcut} from "./packages/ui-shared/src/index.ts";
document.head.insertAdjacentHTML("beforeend", "<style>"+askStyles+"</style>");
const anchor=document.getElementById("source");
let detach;
window.askClosedCount=0;
function open(){
 if(document.querySelector("dialog"))return true;
 const shell=document.createElement("dialog");shell.className="ls-ask-shell";shell.setAttribute("aria-label","Ask Pi");
 shell.innerHTML='<section class="ls-ask"><header class="ls-ask-header" aria-label="会话操作"><button aria-label="关闭">×</button></header><div class="ls-ask-conversation"><div style="height:1600px">Conversation</div></div><div class="ls-ask-composer-area"><form class="ls-ask-composer"><textarea class="ls-ask-question" aria-label="问题"></textarea><div class="ls-ask-composer-bottom"><button>发送</button></div></form></div></section>';
 document.body.append(shell);
 detach=attachAskWindow(shell,()=>anchor.isConnected?textAnchorRect(anchor):null,()=>{detach();shell.remove();window.askClosedCount++;});
 shell.querySelector("textarea").focus();return true;
}
registerAskShortcut(document,open);
`,
      resolveDir: process.cwd(),
      loader: "js",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.setContent(
    '<style>body{margin:0;height:2000px}#source{position:absolute;left:100px;top:180px;width:350px}</style><p id="source">A little context goes a long way.</p><input aria-label="宿主输入框">',
  );
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  await page.evaluate(() =>
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "KeyA",
        altKey: true,
        bubbles: true,
      }),
    ),
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByLabel("宿主输入框").focus();
  await page.keyboard.press("Alt+Shift+KeyA");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.locator("#source").click();
  await page.keyboard.press("Alt+Shift+KeyA");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Ask", exact: true }),
  ).toHaveCount(0);
  await expect(dialog).toHaveAttribute("aria-modal", "false");
  await expect(dialog).toHaveAttribute("data-placement", "right");
  const initial = await dialog.boundingBox();
  await page.evaluate(() => window.scrollBy(0, 80));
  await expect
    .poll(async () => (await dialog.boundingBox())!.y)
    .toBeCloseTo(initial!.y - 80, 0);
  await page.keyboard.press("Alt+Shift+KeyA");
  await expect(dialog).toHaveCount(1);
  for (const viewport of [
    { width: 1261, height: 923 },
    { width: 390, height: 700 },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(async () => {
        const composer = await page
          .locator(".ls-ask-composer-area")
          .boundingBox();
        return composer!.y + composer!.height;
      })
      .toBeLessThanOrEqual(viewport.height - 12);
    expect(
      await dialog.evaluate((node) => node.scrollHeight <= node.clientHeight),
    ).toBe(true);
    expect(
      await page
        .locator(".ls-ask-conversation")
        .evaluate((node) => node.scrollHeight > node.clientHeight),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.locator("#source").click();
  await page.keyboard.press("Alt+Shift+KeyA");
  await expect(dialog).toHaveCount(1);
  await page.locator("#source").evaluate((node) => node.remove());
  await expect(dialog).toHaveCount(0);
});

test("Ask composer grows without a nested focus frame and formats answers safely", async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents: `
import React from "react";
import {createRoot} from "react-dom/client";
import {askStyles,createAskModelSelector,renderTranslationMarkdown} from "./packages/ui-shared/src/index.ts";
const Selector=createAskModelSelector(()=>React);
const model={provider:"deepseek",authMode:"api_key",model:"a-very-long-model-name-that-must-not-push-send-outside",endpoint:"https://api.deepseek.com",maxOutputTokens:0,timeoutMs:30000,prices:null};
const load=async()=>({model,askModel:model,accounts:[],providers:[],keyConfigured:true});
createRoot(document.getElementById("root")).render(<section className="ls-ask" style={{height:660}}><style>{askStyles}</style><header className="ls-ask-header" aria-label="会话操作"><button type="button" aria-label="新建">＋</button><button type="button" aria-label="关闭">×</button></header><div className="ls-ask-conversation"><div className="ls-ask-turn"><p className="ls-ask-user">这里的 goes a long way 是什么意思？</p><span className="ls-ask-badge">✓ 已完成</span><div className="ls-ask-answer" dangerouslySetInnerHTML={{__html:renderTranslationMarkdown('**很有帮助**，也可以理解为「能起很大作用」。\\n\\n- A little kindness goes a long way.\\n- 一点善意，就能带来很大的改变。\\n\\n<script>window.injected=true</script>')}}/></div></div><div className="ls-ask-composer-area"><form className="ls-ask-composer"><div className="ls-ask-context-chips"><button type="button" className="ls-context-chip">所选文本 ×</button></div><textarea aria-label="问题" className="ls-ask-question" rows={2} placeholder="问点什么…"/><div className="ls-ask-composer-bottom"><div className="ls-ask-model-host"><Selector load={load} model={model} onChange={()=>{}}/></div><button type="button" className="ls-ask-send" aria-label="提问">↑</button></div></form></div></section>);
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
  await page.setViewportSize({ width: 480, height: 720 });
  await page.setContent(
    '<style>body{margin:24px;background:#ddd}textarea:focus{outline:5px solid red;box-shadow:0 0 8px red}summary{font-weight:bold}</style><div id="root"></div>',
  );
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  const question = page.getByLabel("问题", { exact: true });
  const initial = (await question.boundingBox())!.height;
  await question.fill("第一行\n第二行\n第三行\n第四行");
  await expect
    .poll(async () => (await question.boundingBox())!.height)
    .toBeGreaterThan(initial);
  expect(
    await question.evaluate((node) => getComputedStyle(node).outlineStyle),
  ).toBe("none");
  expect(await question.evaluate((node) => getComputedStyle(node).resize)).toBe(
    "none",
  );
  const send = (await page
    .getByRole("button", { name: "提问", exact: true })
    .boundingBox())!;
  const composer = (await page.locator(".ls-ask-composer").boundingBox())!;
  expect(send.x + send.width).toBeLessThan(composer.x + composer.width);
  await expect(page.locator(".ls-ask-answer strong")).toHaveText("很有帮助");
  await expect(page.locator(".ls-ask-answer li")).toHaveCount(2);
  await expect(page.locator(".ls-ask-answer script")).toHaveCount(0);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page
      .locator(".ls-ask")
      .screenshot({ path: `.cache/ui/ask-refined-${colorScheme}.png` });
  }
});

test("Discord settings, provider authentication and Ask share the host's explicit theme", async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents: `
import {askStyles,providerAuthStyles} from "./packages/ui-shared/src/index.ts";
import {pluginStyles} from "./apps/discord-vencord/src/styles.ts";
document.head.insertAdjacentHTML("beforeend","<style>"+askStyles+providerAuthStyles+pluginStyles+"</style>");
`,
      resolveDir: process.cwd(),
      loader: "js",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
  });
  await page.setContent(
    '<div id="host"><section class="lingo-sofa-panel"><button class="lingo-sofa-primary">保存设置</button><div class="lingo-sofa-auth"><div class="lingo-sofa-auth-modes"><button aria-pressed="true">账户</button></div></div><div class="ls-intelligence">连接</div></section><section class="ls-ask"><div class="ls-ask-composer-area"><div class="ls-ask-composer">问题</div></div></section><div class="lingo-sofa-dock"><div class="lingo-sofa-channel-panel">频道阅读设置</div></div></div>',
  );
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  for (const [theme, scheme, canvas] of [
    ["light", "dark", "#fafafa"],
    ["dark", "light", "#1e1f22"],
  ] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page
      .locator("#host")
      .evaluate(
        (node, theme) => node.setAttribute("class", `theme-${theme}`),
        theme,
      );
    for (const selector of [
      ".lingo-sofa-panel",
      ".lingo-sofa-auth",
      ".ls-intelligence",
      ".ls-ask",
      ".lingo-sofa-dock",
    ]) {
      expect(
        await page
          .locator(selector)
          .evaluate((node) =>
            getComputedStyle(node).getPropertyValue("--ls-canvas").trim(),
          ),
      ).toBe(canvas);
    }
    const primary = await page
      .getByRole("button", { name: "保存设置" })
      .evaluate((node) => ({
        foreground: getComputedStyle(node).color,
        background: getComputedStyle(node).backgroundColor,
      }));
    expect(primary.foreground).not.toBe(primary.background);
  }
});
