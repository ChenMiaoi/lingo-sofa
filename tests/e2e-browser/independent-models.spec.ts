import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { modelServer } from "../fixtures/model-server.js";
import type { ProviderCatalog } from "@lingo-sofa/protocol";
type ExtensionApi = typeof import("wxt/browser").browser;

test("saves multiple accounts, separates defaults and keeps credentials after reopening Chromium", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lingo-independent-"));
  const first = await modelServer();
  const second = await modelServer();
  const extension = join(directory, "extension");
  await cp(resolve("apps/browser-extension/.output/chrome-mv3"), extension, {
    recursive: true,
  });
  const manifest = JSON.parse(
    await readFile(join(extension, "manifest.json"), "utf8"),
  );
  manifest.host_permissions = ["http://127.0.0.1/*"];
  await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
  const launch = () =>
    chromium.launchPersistentContext(join(directory, "profile"), {
      channel: "chromium",
      headless: true,
      viewport: { width: 1280, height: 1000 },
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    });
  let context = await launch();
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const id = new URL(worker.url()).host;
    await worker.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      await api.storage.local.set({ settings: { mode: "direct" } });
    });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/options.html`);
    await page
      .getByRole("navigation", { name: "设置导航" })
      .getByRole("button", { name: "供应商", exact: true })
      .click();
    const connection = page.getByRole("region", { name: "连接服务商" });
    for (const [endpoint, key] of [
      [first.endpoint, "work-fixture-key"],
      [second.endpoint, "personal-fixture-key"],
    ]) {
      await connection.getByRole("button", { name: "添加供应商" }).click();
      await expect(
        connection.getByLabel("账户名称", { exact: true }),
      ).toHaveCount(0);
      await connection
        .getByRole("combobox", { name: "供应商", exact: true })
        .selectOption("openai-compatible");
      await connection.getByLabel("API 地址", { exact: true }).fill(endpoint!);
      await connection.getByLabel("API Key", { exact: true }).fill(key!);
      await connection.getByRole("button", { name: "保存配置" }).click();
      await expect(connection.getByRole("status")).toContainText(
        "供应商已保存",
      );
      await expect(
        connection.getByLabel("API Key", { exact: true }),
      ).toHaveValue("");
    }
    const catalog = await page.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      return (await api.runtime.sendMessage({
        action: "provider-catalog",
      })) as ProviderCatalog;
    });
    expect(catalog.accounts).toHaveLength(2);
    expect(JSON.stringify(catalog)).not.toContain("fixture-key");
    const work = catalog.accounts.find(
      (item) => item.model.endpoint === first.endpoint,
    )!;
    const personal = catalog.accounts.find(
      (item) => item.model.endpoint === second.endpoint,
    )!;
    await mkdir(".cache/ui", { recursive: true });
    await page.screenshot({
      path: ".cache/ui/ai-workspace-accounts.png",
      fullPage: true,
    });
    await expect(connection.getByLabel("模型", { exact: true })).toHaveCount(0);
    await expect(
      connection.getByRole("navigation", { name: "AI 配置导航" }),
    ).toHaveCount(0);
    await connection.getByRole("button", { name: "完成", exact: true }).click();
    await page.getByRole("button", { name: "翻译模型", exact: true }).click();
    await connection
      .getByLabel("已配置供应商", { exact: true })
      .selectOption(work.id);
    await connection.getByLabel("模型", { exact: true }).fill("fixture");
    await expect(
      connection.getByRole("button", { name: "保存配置" }),
    ).toBeEnabled();
    await connection.getByRole("button", { name: "保存配置" }).click();
    await expect(connection.getByRole("status")).toContainText("不影响 Ask");
    await connection.getByRole("button", { name: "完成", exact: true }).click();
    await page
      .getByRole("button", { name: "Ask 默认模型", exact: true })
      .click();
    await connection
      .getByLabel("已配置供应商", { exact: true })
      .selectOption(personal.id);
    await connection.getByLabel("模型", { exact: true }).fill("fixture-next");
    await connection.getByRole("button", { name: "保存配置" }).click();
    await expect(connection.getByRole("status")).toContainText(
      "已有会话保持原配置",
    );
    const configured = await page.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      return (await api.runtime.sendMessage({
        action: "provider-catalog",
      })) as ProviderCatalog;
    });
    expect(configured.model.accountId).toBe(work.id);
    expect(configured.askModel?.accountId).toBe(personal.id);
    await connection.getByRole("button", { name: "完成", exact: true }).click();
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator(".workspace-header")).toHaveCount(1);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await page.screenshot({
        path: `.cache/ui/ai-workspace-${theme}.png`,
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
      await expect(page.locator(".workspace-header")).toHaveCount(1);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await page.screenshot({
        path: `.cache/ui/ai-workspace-${theme}-narrow.png`,
        fullPage: true,
      });
      await page.setViewportSize({ width: 1280, height: 1000 });
    }
    await page.getByRole("button", { name: "翻译偏好", exact: true }).click();
    await page.getByLabel("目标语言", { exact: true }).selectOption("English");
    await expect(page.getByRole("status")).toContainText("所有更改已保存");
    await page.screenshot({
      path: ".cache/ui/figma-settings-translation.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "外观", exact: true }).click();
    await page.getByLabel("颜色主题", { exact: true }).selectOption("light");
    await expect(page.getByRole("status")).toHaveText("外观已保存");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.getByLabel("搜索设置").fill("隐私");
    await expect(page.getByRole("navigation").getByRole("button")).toHaveCount(
      1,
    );
    await page.getByLabel("搜索设置").fill("");
    await context.close();
    context = await launch();
    const restoredWorker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const restoredId = new URL(restoredWorker.url()).host;
    const restoredPage = await context.newPage();
    await restoredPage.goto(`chrome-extension://${restoredId}/options.html`);
    await expect(
      restoredPage.getByLabel("翻译模型", { exact: true }),
    ).toHaveValue(`${work.id}:fixture`);
    const restored = await restoredPage.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { chrome: ExtensionApi })
        .chrome;
      return (await api.runtime.sendMessage({
        action: "provider-catalog",
      })) as ProviderCatalog;
    });
    await expect(restoredPage.locator("html")).toHaveAttribute(
      "data-theme",
      "light",
    );
    const restoredSettings = await restoredPage.evaluate(async () =>
      (
        globalThis as typeof globalThis & { chrome: ExtensionApi }
      ).chrome.runtime.sendMessage({ action: "state" }),
    );
    expect(restoredSettings.settings.targetLanguage).toBe("English");
    expect(restored.accounts).toHaveLength(2);
    expect(restored.askModel?.accountId).toBe(personal.id);
  } finally {
    await context.close();
    await first.close();
    await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps Ask model selections independent and preserves each session's selection when defaults refresh", async ({
  page,
}) => {
  const { build } = await import("esbuild");
  const bundle = await build({
    stdin: {
      contents: `import React,{useState,useCallback} from "react";
import {createRoot} from "react-dom/client";
import {createAskModelSelector} from "./packages/ui-shared/src/index.ts";
const Selector=createAskModelSelector(()=>React);
const base={authMode:"api_key",provider:"deepseek",model:"deepseek-flash",endpoint:"https://api.deepseek.com",thinkingLevel:"low",timeoutMs:30000,maxOutputTokens:0,prices:null};
const catalog={model:base,askModel:base,accounts:[],keyConfigured:true,piAuth:false,providers:[{id:"deepseek",name:"DeepSeek",models:[{id:"deepseek-flash",endpoint:base.endpoint,thinkingLevels:["off","low","high","max"],api:"openai-completions"}]},{id:"openai",name:"OpenAI",models:[{id:"gpt-4o",endpoint:"https://api.openai.com/v1",thinkingLevels:["off"],api:"openai-responses"}]}]};
function Chat({id}){const [model,setModel]=useState();const load=useCallback(async()=>catalog,[]);return <section data-testid={id}><Selector load={load} model={model} onChange={setModel}/></section>;}
createRoot(document.getElementById("root")).render(<><Chat id="one"/><Chat id="two"/></>);`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
  });
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  const one = page.getByTestId("one");
  const two = page.getByTestId("two");
  await one.locator("summary").click();
  await two.locator("summary").click();
  await expect(two.getByLabel("思考强度", { exact: true })).toHaveValue("low");
  await one.getByLabel("供应商", { exact: true }).selectOption("openai");
  await expect(one.getByLabel("模型", { exact: true })).toHaveValue("gpt-4o");
  await expect(one.getByLabel("思考强度", { exact: true })).toHaveValue("");
  await expect(two.getByLabel("模型", { exact: true })).toHaveValue(
    "deepseek-flash",
  );
  await expect(two.getByLabel("思考强度", { exact: true })).toHaveValue("low");
  await one.getByRole("button", { name: "刷新供应商与模型" }).click();
  await expect(one.getByLabel("模型", { exact: true })).toHaveValue("gpt-4o");
  await two.getByLabel("思考强度", { exact: true }).selectOption("max");
  await expect(one.getByLabel("思考强度", { exact: true })).toHaveValue("");
  await expect(two.getByLabel("思考强度", { exact: true })).toHaveValue("max");
  await page.screenshot({
    path: ".cache/ui/ask-independent-selectors.png",
    fullPage: true,
  });
});
