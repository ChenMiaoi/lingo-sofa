import { test, expect } from "@playwright/test";
import { build } from "esbuild";

test("opens Ask for exactly one Discord message and cleans up its hover action", async ({
  page,
}) => {
  const fixtures: Record<string, string> = {
    "@api/Settings": `export function definePluginSettings(definitions){const store=Object.fromEntries(Object.entries(definitions).map(([key,value])=>[key,value.default]));window.fixtureSettings=store;return {store,use:()=>store};}`,
    "@api/ContextMenu": "export const findGroupChildrenByChildId=()=>[];",
    "@api/MessagePopover": `export function addMessagePopoverButton(id,render,icon){window.popovers.set(id,{render,icon});}export function removeMessagePopoverButton(id){window.popovers.delete(id);}`,
    "@utils/types":
      "export default value=>value;export const OptionType={BOOLEAN:1,NUMBER:2,STRING:3};",
    "@webpack/common": `import React from 'react';export {React};export {createRoot} from 'react-dom/client';export const useStateFromStores=(_,read)=>read();export const Menu={};export const UserStore={getCurrentUser:()=>({id:'account'})};export const ChannelStore={getChannel:id=>id==='channel'?{id}:undefined};export const SelectedChannelStore={getChannelId:()=>'channel'};export const MessageStore={getMessage:(_,id)=>window.messages[id]};`,
    "fixture-client": `const model={provider:'deepseek',authMode:'api_key',model:'deepseek-flash',endpoint:'https://api.deepseek.com',maxOutputTokens:512,timeoutMs:30000,prices:null};export class DiscordBridgeClient{async providers(){return {model,askModel:model,accounts:[],providers:[],keyConfigured:true};}async request(scope,request){window.calls.push({scope,request});return {ok:true,text:'Answer for this message'};}}`,
  };
  const bundle = await build({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import plugin from './apps/discord-vencord/src/index.tsx';
window.plugin=plugin;plugin.start();
window.popovers.set('LingoSofa',plugin.messagePopoverButton);
for(const message of Object.values(window.messages)){
 const element=document.getElementById('actions-'+message.id);
 createRoot(element).render(React.createElement(React.Fragment,null,...[...window.popovers.values()].map(({render})=>{const action=render(message);return action?React.createElement('button',{key:action.label,'aria-label':action.label,onClick:action.onClick},action.label):null;})));
}`,
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
        name: "discord-host",
        setup(builder) {
          builder.onResolve(
            { filter: /^@api\/|^@utils\/|^@webpack\// },
            ({ path }) => ({ path, namespace: "fixture" }),
          );
          builder.onResolve({ filter: /^\.\/client\.js$/ }, () => ({
            path: "fixture-client",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => {
            if (!fixtures[path])
              throw new Error(`Missing host fixture: ${path}`);
            return { contents: fixtures[path], resolveDir: process.cwd() };
          });
        },
      },
    ],
  });
  await page.route("https://discord.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("https://discord.test/channels/channel");
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.setContent(`<style>article{width:420px;margin:120px 80px}p{font:16px/1.6 sans-serif}</style><article>
    <p id="message-content-first">First message with its own complete context.</p><div id="actions-first"></div>
    <p id="message-content-second">Second message must remain separate.</p><div id="actions-second"></div>
  </article>`);
  await page.evaluate(() => {
    Object.assign(window, {
      VencordNative: {
        pluginHelpers: { LingoSofa: { start() {}, stop() {} } },
      },
      messages: {
        first: {
          id: "first",
          channel_id: "channel",
          content: "First message with its own complete context.",
        },
        second: {
          id: "second",
          channel_id: "channel",
          content: "Second message must remain separate.",
        },
      },
      popovers: new Map(),
      calls: [],
    });
  });
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  const first = page.locator("#actions-first");
  await expect(
    first.getByRole("button", { name: "LingoSofa 翻译" }),
  ).toBeVisible();
  await expect(
    first.getByRole("button", { name: "LingoSofa Ask" }),
  ).toBeVisible();
  // A hover action targets the complete message even if only one word is selected.
  await page.locator("#message-content-first").evaluate((source) => {
    const range = document.createRange();
    range.setStart(source.firstChild!, 0);
    range.setEnd(source.firstChild!, 5);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  await first.getByRole("button", { name: "LingoSofa Ask" }).click();
  const dialog = page.locator("dialog.ls-ask-shell");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".ls-ask-context")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { calls: unknown[] }).calls,
    ),
  ).toEqual([]);
  const sourceBox = await page
    .locator("#message-content-first")
    .evaluate((source) => {
      const range = document.createRange();
      range.selectNodeContents(source);
      const box = range.getBoundingClientRect();
      return { x: box.x, width: box.width };
    });
  const dialogBox = (await dialog.boundingBox())!;
  expect(dialogBox.x).toBeGreaterThanOrEqual(sourceBox.x + sourceBox.width);
  await dialog.getByLabel("问题", { exact: true }).fill("Explain this message");
  await dialog.getByRole("button", { name: "提问", exact: true }).click();
  await expect(dialog).toContainText("Answer for this message");
  const sent = await page.evaluate(() =>
    (
      window as unknown as {
        calls: { scope: string; request: { kind: string; context: string } }[];
      }
    ).calls.filter((call) => call.request.kind === "ask"),
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]!.scope).toBe("discord:account:channel");
  expect(sent[0]!.request.context).toBe(
    "First message with its own complete context.",
  );
  await dialog.getByRole("button", { name: "关闭并清理会话" }).click();
  await page.locator("#message-content-second").evaluate((source) => {
    const range = document.createRange();
    range.setStart(source.firstChild!, 0);
    range.setEnd(source.firstChild!, 6);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  await page.keyboard.press("Alt+Shift+KeyA");
  await expect(dialog).toBeVisible();
  await dialog
    .getByLabel("问题", { exact: true })
    .fill("Explain the selected word");
  await dialog.getByRole("button", { name: "提问", exact: true }).click();
  await expect(dialog).toContainText("Answer for this message");
  expect(
    await page.evaluate(() =>
      (
        window as unknown as {
          calls: { request: { kind: string; context: string } }[];
        }
      ).calls
        .filter((call) => call.request.kind === "ask")
        .map((call) => call.request.context),
    ),
  ).toEqual(["First message with its own complete context.", "Second"]);
  await page.evaluate(() =>
    (window as unknown as { plugin: { stop(): void } }).plugin.stop(),
  );
  await expect(dialog).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      (window as unknown as { popovers: Map<string, unknown> }).popovers.has(
        "LingoSofaAsk",
      ),
    ),
  ).toBe(false);
});
