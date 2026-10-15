import { test, expect } from "@playwright/test";
import { build } from "esbuild";

test("shares the same subscription auth card across clients, themes and narrow layouts", async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents: `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{createProviderAuth}from'./packages/ui-shared/src/provider-auth.tsx';
const Auth=createProviderAuth(React);window.state={connected:false,phase:'idle'};window.actions=[];
const request=async action=>{window.actions.push(action);if(action==='start')window.state={connected:false,phase:'pending',authorizationUrl:'https://auth.openai.com/api/accounts/authorize?state=fixture'};if(action==='logout'||action==='cancel')window.state={connected:false,phase:'idle'};return window.state;};
function Host(){const[mode,setMode]=useState('subscription');return <Auth mode={mode} onMode={setMode} request={request}/>};createRoot(document.getElementById('root')).render(<><Host/><Host/></>);`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
  });
  await page.setContent(
    '<style>body{background:#17171c;color:#eee;font:14px system-ui;margin:8px}#root{max-width:380px}button{font:inherit}</style><div id="root"></div>',
  );
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  const first = page.locator(".lingo-sofa-auth").nth(0),
    second = page.locator(".lingo-sofa-auth").nth(1);
  await first
    .getByRole("button", { name: "使用 ChatGPT 登录", exact: true })
    .click();
  await expect(second.getByRole("link", { name: /继续前往/ })).toBeVisible();
  await expect(first.getByRole("link")).toHaveAttribute(
    "href",
    /auth.openai.com/,
  );
  await page.evaluate(() => {
    (window as unknown as { state: unknown }).state = {
      connected: true,
      phase: "idle",
    };
  });
  await expect(second.getByRole("status")).toContainText("已连接");
  await first
    .getByRole("button", { name: "退出本机登录", exact: true })
    .click();
  await expect(second.getByRole("status")).toContainText("尚未连接");
  await first
    .getByRole("button", { name: "使用 ChatGPT 登录", exact: true })
    .click();
  await first.getByRole("button", { name: "取消登录", exact: true }).click();
  await expect(first.getByRole("link")).toHaveCount(0);
  await first.getByRole("button", { name: "API Key", exact: true }).click();
  await expect(
    first.getByText("使用你的 ChatGPT 订阅", { exact: true }),
  ).toHaveCount(0);
  await first
    .getByRole("button", { name: "ChatGPT 订阅", exact: true })
    .click();
  await page.setViewportSize({ width: 300, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".cache/ui/provider-auth-dark.png",
    fullPage: true,
  });
  await page.addStyleTag({ content: "body{background:#fff;color:#24242b}" });
  const colors = await second
    .getByRole("button", { name: "ChatGPT 订阅", exact: true })
    .evaluate((el) => ({
      color: getComputedStyle(el).color,
      background: getComputedStyle(document.body).backgroundColor,
    }));
  expect(colors).toEqual({
    color: "rgb(36, 36, 43)",
    background: "rgb(255, 255, 255)",
  });
  await page.screenshot({
    path: ".cache/ui/provider-auth-light.png",
    fullPage: true,
  });
});
