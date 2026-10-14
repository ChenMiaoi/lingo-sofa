/* global chrome, crypto, URL, AbortSignal */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, cp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { bridgeConfigSchema } from "../apps/pi-bridge/src/config.ts";
import { createBridge } from "../apps/pi-bridge/src/server.ts";
import { replySchema } from "@lingo-sofa/protocol";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { resolveModel } from "@lingo-sofa/provider-pi/browser";
import { measure } from "@lingo-sofa/provider-pi";

// Opt-in only. Neither credentials nor private account amounts are written to the report.
process.loadEnvFile(".env");
const key = process.env.API_KEY;
assert(key, "Configure API_KEY locally in .env before running this check");
assert(
  ["darwin", "linux"].includes(process.platform),
  "Native registration check currently supports macOS/Linux",
);
const directory = await mkdtemp(join(tmpdir(), "lingo-real-"));
const extension = join(directory, "extension");
const bridgeHome = join(directory, "bridge");
const token = crypto.randomUUID() + crypto.randomUUID();
const config = bridgeConfigSchema.parse({
  settings: {
    mode: "bridge",
    model: {
      provider: "deepseek",
      model: "deepseek-flash",
      endpoint: "https://api.deepseek.com",
      maxOutputTokens: 512,
      timeoutMs: 45000,
    },
  },
});
const report = {
  model: config.settings.model.model,
  checkedAt: new Date().toISOString(),
  checks: {},
};
const site = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(
    "<article><p>Hello, LingoSofa! Use <code>fetch()</code> to read a URL.</p></article>",
  );
});
let context, bridge, nativeManifest;
let phase = "browser translation";
try {
  await mkdir(bridgeHome, { mode: 0o700 });
  await cp(resolve("apps/browser-extension/.output/chrome-mv3"), extension, {
    recursive: true,
  });
  const manifest = JSON.parse(
    await readFile(join(extension, "manifest.json"), "utf8"),
  );
  // Test-copy permissions avoid automating a production browser's permission prompts.
  manifest.host_permissions = [
    "http://127.0.0.1/*",
    "https://api.deepseek.com/*",
  ];
  await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
  await new Promise((done) => site.listen(0, "127.0.0.1", done));
  const siteUrl = `http://127.0.0.1:${site.address().port}`;
  context = await chromium.launchPersistentContext(join(directory, "profile"), {
    channel: "chromium",
    headless: true,
    env: { ...process.env, LINGO_SOFA_HOME: bridgeHome },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html?view=activity`);
  await options.evaluate(
    async ({ key, model }) => {
      const state = await chrome.runtime.sendMessage({ action: "state" });
      const saved = await chrome.runtime.sendMessage({
        action: "save",
        settings: { ...state.settings, model },
        apiKey: key,
      });
      if (saved.ok === false)
        throw new Error("Unable to configure test extension");
    },
    { key, model: config.settings.model },
  );
  const page = await context.newPage();
  await page.goto(siteUrl);
  await options.evaluate(() =>
    chrome.runtime.sendMessage({ action: "page", command: "page" }),
  );
  await page
    .locator("[data-lingo-sofa='translation']")
    .waitFor({ timeout: 45000 });
  assert.match(
    await page.locator("[data-lingo-sofa='translation']").innerText(),
    /[\u4e00-\u9fff]/u,
  );
  assert.equal(await page.locator("code").innerText(), "fetch()");
  const direct = await options.evaluate(() =>
    chrome.runtime.sendMessage({ action: "state" }),
  );
  const metric = direct.usage.at(-1);
  assert(
    metric.costKnown &&
      metric.usage?.totalTokens > 0 &&
      metric.pricing?.source === "official",
  );
  report.checks.mv3Translation = {
    usage: metric.usage,
    pricing: metric.pricing,
    durationMs: metric.durationMs,
  };
  const balance = await options.evaluate(() =>
    chrome.runtime.sendMessage({ action: "balance" }),
  );
  assert(
    Array.isArray(balance.data?.balance_infos),
    "Balance query did not return account data",
  );
  report.checks.balance = {
    available: true,
    currencies: balance.data.balance_infos.map((info) => info.currency),
    updatedAt: balance.updatedAt,
  };

  phase = "native registration";
  config.allowedExtensions = [id];
  bridge = createBridge(
    config,
    key,
    token,
    Date.now() + 10 * 60_000,
    bridgeHome,
  );
  await new Promise((done) => bridge.server.listen(0, "127.0.0.1", done));
  config.port = bridge.server.address().port;
  await writeFile(join(bridgeHome, "config.json"), JSON.stringify(config), {
    mode: 0o600,
  });
  await writeFile(
    join(bridgeHome, "pairing.json"),
    JSON.stringify({ token, expiresAt: Date.now() + 10 * 60_000 }),
    { mode: 0o600 },
  );
  const nativeDir = join(directory, "profile/NativeMessagingHosts");
  await mkdir(nativeDir, { recursive: true });
  const path = join(nativeDir, "com.lingosofa.bridge.json");
  await writeFile(
    path,
    JSON.stringify({
      name: "com.lingosofa.bridge",
      description: "Temporary LingoSofa acceptance host",
      type: "stdio",
      path: resolve("apps/pi-bridge/dist/lingo-sofa-native-host"),
      allowed_origins: [`chrome-extension://${id}/`],
    }),
    { flag: "wx", mode: 0o600 },
  );
  nativeManifest = path;
  await options.evaluate(async () => {
    await chrome.runtime.sendMessage({ action: "page", command: "stop" });
    const state = await chrome.runtime.sendMessage({ action: "state" });
    // This test copy has required fixture permissions, which cannot be revoked by the normal save flow.
    await chrome.storage.local.set({
      settings: { ...state.settings, mode: "bridge" },
    });
  });
  phase = "native question";
  const preview = await options.evaluate(() =>
    chrome.runtime.sendMessage({ action: "page", command: "context" }),
  );
  assert(preview.text?.includes("fetch()"));
  const sessionId = crypto.randomUUID();
  const replies = [];
  for (const question of [
    "Translate the selected sentence into Simplified Chinese.",
    "Which function was mentioned? Answer briefly in Chinese.",
  ]) {
    const reply = replySchema.parse(
      await options.evaluate(
        async ({ context, sessionId, question }) => {
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find((tab) =>
            tab.url?.startsWith("http://127.0.0.1"),
          );
          return chrome.runtime.sendMessage({
            action: "ask",
            tabId: tab.id,
            request: {
              kind: "ask",
              requestId: crypto.randomUUID(),
              sessionId,
              context,
              question,
            },
          });
        },
        { context: preview.text, sessionId, question },
      ),
    );
    assert(
      reply.ok && reply.text,
      reply.ok ? "Native Pi SDK question failed" : reply.error,
    );
    assert(
      reply.metrics?.usage?.totalTokens > 0 &&
        reply.metrics.pricing?.source === "official",
    );
    replies.push(reply);
  }
  assert.match(replies[1].text, /fetch/u);
  assert.equal(
    replies[1].sessionStats.tokens,
    replies.reduce((sum, reply) => sum + reply.metrics.usage.totalTokens, 0),
  );
  assert(
    Math.abs(
      replies[1].sessionStats.cost -
        replies.reduce((sum, reply) => sum + reply.metrics.usage.cost.total, 0),
    ) < 1e-10,
  );
  assert.equal(
    bridge.sessions.stats(
      `chrome-extension://${id}|${bridge.service.ledger.list()[0].scope.split("|").slice(1).join("|")}|${sessionId}`,
    ).toolCalls,
    0,
  );
  report.checks.nativeSdk = {
    turns: replies.map((reply) => reply.metrics),
    sessionStats: replies[1].sessionStats,
  };

  phase = "thinking stream";
  const resolved = resolveModel(config.settings.model);
  const stream = streamSimple(
    resolved.model,
    {
      messages: [
        {
          role: "user",
          content: "Compute 17 + 25. Reply with the number only.",
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: key,
      reasoning: "low",
      maxTokens: 512,
      maxRetries: 0,
      timeoutMs: 45000,
    },
  );
  let thinking = false;
  for await (const event of stream)
    if (event.type === "thinking_delta" && event.delta) thinking = true;
  const final = await stream.result();
  assert.equal(
    final.stopReason,
    "stop",
    "Thinking request failed or exceeded the output limit",
  );
  assert(thinking, "Provider did not return a thinking stream");
  report.checks.thinking = measure(
    final,
    0,
    null,
    null,
    null,
    0,
    true,
    resolved.pricing,
  );
  phase = "non-streaming completion";
  const nonstream = await globalThis.fetch(
    "https://api.deepseek.com/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.settings.model.model,
        messages: [
          {
            role: "user",
            content:
              "Translate hello into Simplified Chinese. Reply with the translation only.",
          },
        ],
        stream: false,
        thinking: { type: "disabled" },
        max_tokens: 128,
      }),
      signal: AbortSignal.timeout(45000),
    },
  );
  assert(nonstream.ok, `Non-streaming HTTP status ${nonstream.status}`);
  const nonstreamData = await nonstream.json();
  assert.match(
    nonstreamData.choices?.[0]?.message?.content ?? "",
    /[\u4e00-\u9fff]/u,
  );
  assert(nonstreamData.usage?.total_tokens > 0);
  report.checks.nonstreaming = {
    status: nonstream.status,
    usage: nonstreamData.usage,
  };
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    JSON.stringify(
      {
        success: false,
        completedChecks: report.checks,
        phase,
        error: String(
          error instanceof Error ? error.message : "Acceptance failed",
        )
          .split(key)
          .join("[redacted]")
          .split(token)
          .join("[redacted]")
          .slice(0, 600),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await context?.close();
  if (bridge) {
    bridge.server.closeAllConnections();
    await new Promise((done) => bridge.server.close(done));
  }
  site.closeAllConnections();
  await new Promise((done) => site.close(done));
  if (nativeManifest) await rm(nativeManifest);
  await rm(directory, { recursive: true, force: true });
}
