import { useEffect, useState, type FormEvent } from "react";
import { browser } from "wxt/browser";
import {
  settingsSchema,
  type Settings,
  type Reply,
  type UsageRecord,
  type BudgetSnapshot,
} from "@lingo-sofa/protocol";
import { summarize, period, budgetStatus } from "@lingo-sofa/translation-core";
import {
  formatTokens,
  formatCost,
  formatSpeed,
  formatPricing,
} from "@lingo-sofa/ui-shared";

async function send<T>(message: unknown): Promise<T> {
  const reply = (await browser.runtime.sendMessage(message)) as T & {
    ok?: boolean;
    error?: string;
  };
  if (reply?.ok === false) throw new Error(reply.error ?? "操作失败");
  return reply;
}
export function App() {
  const [settings, setSettings] = useState<Settings>(settingsSchema.parse({}));
  const [usage, setUsage] = useState<UsageRecord[]>([]);
  const [executionSettings, setExecutionSettings] = useState<Settings>(
    settingsSchema.parse({}),
  );
  const [budgetSnapshots, setBudgetSnapshots] = useState<BudgetSnapshot[]>();
  const [shareBudget, setShareBudget] = useState(false);
  const [bridgeError, setBridgeError] = useState("");
  const [sharedUsage, setSharedUsage] = useState(false);
  const [queue, setQueue] = useState({ running: 0, pending: 0 });
  const [sessionStats, setSessionStats] = useState<{
    tokens: number;
    cost: number | null;
    messages: number;
  }>();
  const [sourceFilter, setSourceFilter] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [context, setContext] = useState("");
  const [tabId, setTabId] = useState<number | undefined>();
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<{ question: string; answer: string }[]>(
    [],
  );
  const [sessionId, setSessionId] = useState(crypto.randomUUID());
  const [running, setRunning] = useState<string | undefined>();
  const [range, setRange] = useState("session");
  const [cacheStats, setCacheStats] = useState<{
    hits: number;
    lookups: number;
    ratio: number | null;
  }>({ hits: 0, lookups: 0, ratio: null });
  const [scopeFilter, setScopeFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [glossary, setGlossary] = useState("");
  const [balance, setBalance] = useState<string>("未查询");
  const [autoOrigin, setAutoOrigin] = useState("");
  const [priceInput, setPriceInput] = useState("");
  function applyState(data: {
    settings: Settings;
    usage: UsageRecord[];
    bridgeUsage?: UsageRecord[];
    budgets?: BudgetSnapshot[];
    shareBudget?: boolean;
    cacheStats?: { hits: number; lookups: number; ratio: number | null };
    executionSettings?: Settings;
    bridgeError?: string;
    sharedUsage?: boolean;
    queue?: { running: number; pending: number };
    hasKey: boolean;
  }) {
    setExecutionSettings(data.executionSettings ?? data.settings);
    setUsage(
      data.settings.mode === "bridge" ? (data.bridgeUsage ?? []) : data.usage,
    );
    setBridgeError(data.bridgeError ?? "");
    setSharedUsage(data.sharedUsage ?? false);
    setCacheStats(data.cacheStats ?? { hits: 0, lookups: 0, ratio: null });
    setBudgetSnapshots(data.budgets);
    setShareBudget(data.shareBudget ?? false);
    setQueue(data.queue ?? { running: 0, pending: 0 });
    setHasKey(data.hasKey);
  }
  useEffect(() => {
    void send<{ settings: Settings; usage: UsageRecord[]; hasKey: boolean }>({
      action: "state",
    })
      .then((data) => {
        applyState(data);
        setSettings(data.settings);
        const prices = data.settings.model.prices;
        setPriceInput(
          prices
            ? [
                prices.input,
                prices.output,
                prices.cacheRead,
                prices.cacheWrite,
              ].join(",")
            : "",
        );

        setGlossary(
          data.settings.glossary
            .map((term) => `${term.source} = ${term.target}`)
            .join("\n"),
        );
      })
      .catch((reason: Error) => setError(reason.message));
    const interval = setInterval(() => {
      void send<{ settings: Settings; usage: UsageRecord[]; hasKey: boolean }>({
        action: "state",
      })
        .then(applyState)
        .catch(() => undefined);
    }, 2_000);
    return () => clearInterval(interval);
  }, []);
  async function act(operation: () => Promise<void>) {
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
    }
  }
  function update<K extends keyof Settings>(field: K, value: Settings[K]) {
    setSettings((current) => ({ ...current, [field]: value }));
  }
  async function page(command: string) {
    if (command === "context" && running) throw new Error("请先停止当前问答");
    if (command === "context" && tabId)
      await send({
        action: "clear-session",
        tabId,
        request: { kind: "clear-session", sessionId },
      });
    const reply = await send<{
      ok?: boolean;
      text?: string;
      selection?: string;
    }>({ action: "page", command });
    if (command === "context") {
      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab?.id) throw new Error("页面不可用");
      setTabId(tab.id);
      setSessionStats(undefined);
      setContext(reply.selection || reply.text || "");
      setTurns([]);
      setSessionId(crypto.randomUUID());
    } else
      setNotice(
        command === "stop" ? "已恢复原页面" : "翻译任务已开始，可随时关闭",
      );
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    await act(async () => {
      const terms = glossary
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          const index = line.indexOf("=");
          if (index <= 0) throw new Error("术语表请使用 原词 = 译词，每行一项");
          return {
            source: line.slice(0, index).trim(),
            target: line.slice(index + 1).trim(),
          };
        });
      const values = priceInput.split(",").map((value) => value.trim());
      if (
        priceInput.trim() &&
        (values.length !== 4 ||
          values.some(
            (value) =>
              !value || !Number.isFinite(Number(value)) || Number(value) < 0,
          ))
      )
        throw new Error(
          "单价请填写四个非负数：输入、输出、缓存读、缓存写；或留空使用默认计价",
        );
      const next = settingsSchema.parse({
        ...settings,
        glossary: terms,
        model: {
          ...settings.model,
          prices: priceInput.trim()
            ? {
                input: Number(values[0]),
                output: Number(values[1]),
                cacheRead: Number(values[2]),
                cacheWrite: Number(values[3]),
              }
            : null,
        },
      });
      const origins = [
        ...new Set([
          ...(next.mode === "direct"
            ? [`${new URL(next.model.endpoint).origin}/*`]
            : []),
          ...next.autoOrigins.map((origin) => `${origin}/*`),
        ]),
      ];
      if (origins.length && !(await browser.permissions.request({ origins })))
        throw new Error("需要授权选择的模型端点和自动翻译网站");
      await send({
        action: "save",
        settings: next,
        ...(key ? { apiKey: key } : {}),
      });
      setSettings(next);
      setBalance("未查询");
      setKey("");
      setHasKey(hasKey || Boolean(key));
      setNotice("设置已保存，API Key 仅在本次浏览器会话保留");
    });
  }
  async function ask(event: FormEvent) {
    event.preventDefault();
    if (!tabId || !context.trim() || !question.trim() || running) return;
    const requestId = crypto.randomUUID();
    const prompt = question;
    setRunning(requestId);
    setSessionStats(undefined);
    await act(async () => {
      const reply = await send<Reply>({
        action: "ask",
        tabId,
        request: {
          kind: "ask",
          requestId,
          sessionId,
          context,
          question: prompt,
        },
      });
      if (reply.ok) {
        setSessionStats(reply.sessionStats);
        setTurns((current) => [
          ...current,
          { question: prompt, answer: reply.text ?? "" },
        ]);
        setQuestion("");
      }
    });
    setRunning(undefined);
  }
  const today = period(Date.now(), settings.timeZone);
  const filtered = bridgeError
    ? []
    : usage.filter(
        (record) =>
          (!scopeFilter || record.scope === scopeFilter) &&
          (!modelFilter || record.model === modelFilter) &&
          (!sourceFilter || record.sourceKind === sourceFilter) &&
          (!providerFilter || record.provider === providerFilter) &&
          (range === "qa"
            ? record.sessionId === sessionId
            : range === "session" ||
              (range === "day"
                ? period(record.timestamp, settings.timeZone).day === today.day
                : period(record.timestamp, settings.timeZone).month ===
                  today.month)),
      );
  const totals = summarize(filtered);
  const budgets = bridgeError
    ? []
    : (budgetSnapshots ?? budgetStatus(usage, executionSettings));
  const trend = [
    ...new Set(
      filtered.map((record) => period(record.timestamp, settings.timeZone).day),
    ),
  ]
    .sort()
    .slice(-30)
    .map((day) => ({
      day,
      ...summarize(
        filtered.filter(
          (record) => period(record.timestamp, settings.timeZone).day === day,
        ),
      ),
    }));
  return (
    <main id="top">
      <a className="skip-link" href="#translate">
        跳到翻译操作
      </a>
      <header className="brand-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            文
          </span>
          <div>
            <h1>LingoSofa</h1>
            <p>原文在上，理解在旁。</p>
          </div>
        </div>
        <span className="mode-badge">
          {settings.mode === "bridge" ? "本地 Bridge" : "模型直连"}
        </span>
      </header>
      <nav className="page-nav" aria-label="页面导航">
        <a href="#translate">翻译与问答</a>
        <a href="#usage">用量</a>
        <a
          href="#settings"
          onClick={() => {
            const panel = document.getElementById("settings");
            if (panel instanceof HTMLDetailsElement) panel.open = true;
          }}
        >
          设置
        </a>
      </nav>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <section
        id="translate"
        tabIndex={-1}
        className="translation-card"
        aria-label="页面翻译"
      >
        <div className="section-heading">
          <div>
            <span className="eyebrow">阅读助手</span>
            <h2>让理解，就在原文旁边。</h2>
          </div>
        </div>
        <p className="muted">翻译当前页面或选中文字，随时恢复原页面。</p>
        <div className="actions">
          <button
            className="primary"
            onClick={() => void act(() => page("page"))}
          >
            翻译页面
          </button>
          <button onClick={() => void act(() => page("selection"))}>
            翻译选中
          </button>
          <button onClick={() => void act(() => page("stop"))}>关闭翻译</button>
        </div>
        <button
          className="context-action"
          onClick={() => void act(() => page("context"))}
        >
          预览文章 / 选中内容并提问
        </button>
      </section>
      {tabId && (
        <section
          className="qa-card"
          aria-label="内容问答"
          aria-busy={Boolean(running)}
        >
          <h2>先确认发送范围</h2>
          {sessionStats && (
            <p>
              Pi 会话汇总（同一消耗的另一视图）：
              {formatTokens(sessionStats.tokens)} tokens ·{" "}
              {formatCost(sessionStats.cost)} · {sessionStats.messages} 条消息
            </p>
          )}
          <label>
            上下文预览
            <textarea value={context} readOnly rows={6} />
          </label>
          <p>
            只发送此处内容及当前问答记录。页面未提取到正文时，请先选中需要询问的内容。
          </p>
          <div aria-live="polite">
            {turns.map((turn, index) => (
              <div className="conversation-turn" key={index}>
                <p>
                  <strong>你：</strong>
                  {turn.question}
                </p>
                <p className="answer">{turn.answer}</p>
              </div>
            ))}
          </div>
          <form onSubmit={(event) => void ask(event)}>
            <label>
              问题
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                required
                maxLength={16_000}
              />
            </label>
            <button
              className="primary"
              disabled={Boolean(running) || !context || !question.trim()}
            >
              提问
            </button>
            {running && (
              <span className="muted" role="status">
                正在生成回答…
              </span>
            )}
            {running && (
              <button
                type="button"
                onClick={() =>
                  void act(async () => {
                    await send({
                      action: "cancel",
                      tabId,
                      request: { kind: "cancel", requestId: running },
                    });
                  })
                }
              >
                停止
              </button>
            )}
          </form>
          <button
            disabled={Boolean(running)}
            onClick={() =>
              void act(async () => {
                await send({
                  action: "clear-session",
                  tabId,
                  request: { kind: "clear-session", sessionId },
                });
                setTurns([]);
                setSessionStats(undefined);
                setSessionId(crypto.randomUUID());
              })
            }
          >
            新建 / 清理会话
          </button>
        </section>
      )}
      <section id="usage" aria-label="用量监控">
        <h2>用量与预算</h2>
        {bridgeError && <p role="alert">{bridgeError}</p>}
        <p>
          当前模型：{bridgeError ? "未知" : executionSettings.model.model} ·
          排队 {bridgeError ? "未知" : queue.pending} / 运行{" "}
          {bridgeError ? "未知" : queue.running}
        </p>
        {settings.mode === "bridge" && (
          <p>
            {sharedUsage
              ? "Bridge 已启用跨端共享统计"
              : "仅当前扩展的 Bridge 用量；跨端统计未启用"}
            。预算与提醒使用 Bridge 配置；
            {shareBudget
              ? "跨端预算共享已启用"
              : "预算仅限当前前端，跨端共享未启用"}
            。
          </p>
        )}
        {budgets.map((budget) => (
          <p
            key={`${budget.window}:${budget.metric}`}
            role={budget.warning ? "status" : undefined}
          >
            {budget.window === "day" ? "日" : "月"}
            {budget.metric === "tokens" ? " token" : "费用"}预算：
            {budget.used === null
              ? "消耗未知"
              : `${budget.used.toFixed(2)} / ${budget.limit}`}{" "}
            ·{" "}
            {budget.ratio === null
              ? "不可计算"
              : `${Math.round(budget.ratio * 100)}%`}
            {budget.warning ? " · 达到提醒阈值或需要处理未知消耗" : ""}
          </p>
        ))}
        <div className="metric-grid stats" aria-label="用量摘要">
          <div>
            <span>输入 tokens</span>
            <strong>{formatTokens(bridgeError ? null : totals.input)}</strong>
          </div>
          <div>
            <span>输出 tokens</span>
            <strong>{formatTokens(bridgeError ? null : totals.output)}</strong>
          </div>
          <div>
            <span>估算费用 · USD</span>
            <strong>{formatCost(bridgeError ? null : totals.cost)}</strong>
          </div>
          <div>
            <span>生成速度</span>
            <strong>{formatSpeed(bridgeError ? null : totals.tps)}</strong>
          </div>
        </div>
        {queue.running > 0 && <p role="status">运行中，用量正在统计…</p>}
        <p>
          本地译文缓存：{cacheStats.hits} / {cacheStats.lookups} 段命中（
          {cacheStats.ratio === null
            ? "不可用"
            : `${Math.round(cacheStats.ratio * 100)}%`}
          ）；仅当前执行进程保留的范围，不计入模型账单。
        </p>
        <details className="usage-filters">
          <summary>筛选用量记录</summary>
          <div className="form-grid">
            <label>
              查看范围
              <select
                value={range}
                onChange={(event) => setRange(event.target.value)}
              >
                <option value="session">当前可观测记录</option>
                <option value="qa">当前问答会话</option>
                <option value="day">今日</option>
                <option value="month">本月</option>
              </select>
            </label>
            <label>
              页面 / 频道范围
              <select
                value={scopeFilter}
                onChange={(event) => setScopeFilter(event.target.value)}
              >
                <option value="">全部已观测范围</option>
                {[...new Set(usage.map((record) => record.scope))].map(
                  (scope) => (
                    <option key={scope} value={scope}>
                      {scope.includes("web")
                        ? `${scope.includes("web-qa") ? "文章问答" : "网页翻译"} · ${scope.match(/web(?:-qa)?:\d+:(https?:\/\/[^/|]+):[^:|]+$/)?.[1] ?? "页面"}`
                        : `Discord · 频道 ${scope.split(":").at(-1)}`}
                    </option>
                  ),
                )}
              </select>
            </label>
            <label>
              模型
              <select
                value={modelFilter}
                onChange={(event) => setModelFilter(event.target.value)}
              >
                <option value="">全部模型</option>
                {[...new Set(usage.map((record) => record.model))].map(
                  (model) => (
                    <option key={model}>{model}</option>
                  ),
                )}
              </select>
            </label>
            <label>
              来源
              <select
                value={sourceFilter}
                onChange={(event) => setSourceFilter(event.target.value)}
              >
                <option value="">全部</option>
                <option value="web">浏览器</option>
                <option value="discord">Discord</option>
              </select>
            </label>
            <label>
              供应商
              <select
                value={providerFilter}
                onChange={(event) => setProviderFilter(event.target.value)}
              >
                <option value="">全部</option>
                {[...new Set(usage.map((record) => record.provider))].map(
                  (provider) => (
                    <option key={provider}>{provider}</option>
                  ),
                )}
              </select>
            </label>
          </div>
        </details>
        <details>
          <summary>每日趋势（当前可观测记录）</summary>
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>请求</th>
                <th>Tokens</th>
                <th>估算费用</th>
              </tr>
            </thead>
            <tbody>
              {trend.map((day) => (
                <tr key={day.day}>
                  <td>{day.day}</td>
                  <td>{day.requests}</td>
                  <td>{day.tokens}</td>
                  <td>{formatCost(day.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
        <p>
          {executionSettings.persistUsage
            ? `本地保留 ${executionSettings.retentionDays} 天`
            : "仅当前浏览器会话；未启用历史持久化"}{" "}
          · {totals.requests} 次请求 · {totals.unknown} 次消耗未知
        </p>
        <p>
          日 token 预算：
          {settings.dailyTokens === null
            ? "未设置"
            : formatTokens(settings.dailyTokens)}
          ；月预算：
          {settings.monthlyTokens === null
            ? "未设置"
            : formatTokens(settings.monthlyTokens)}
        </p>
        <details>
          <summary>请求明细</summary>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>模型 / 状态</th>
                  <th>Input / Output</th>
                  <th>缓存</th>
                  <th>首译文 / 耗时</th>
                  <th>TPS / 费用</th>
                </tr>
              </thead>
              <tbody>
                {filtered
                  .slice(-100)
                  .reverse()
                  .map((record) => (
                    <tr key={record.requestId}>
                      <td>
                        {record.model}
                        <br />
                        {record.status}
                      </td>
                      <td>
                        {record.usage
                          ? `${record.usage.input + record.usage.cacheRead + record.usage.cacheWrite} / ${record.usage.output}`
                          : "未知"}
                        {record.usage?.reasoning !== undefined && (
                          <>
                            <br />
                            思考 {record.usage.reasoning}（Output 子集）
                          </>
                        )}
                      </td>
                      <td>
                        {record.usage
                          ? `${record.usage.cacheRead} 读 / ${record.usage.cacheWrite} 写`
                          : "未知"}
                        <br />
                        模型缓存命中率{" "}
                        {record.usage &&
                        record.usage.input +
                          record.usage.cacheRead +
                          record.usage.cacheWrite >
                          0
                          ? `${Math.round((record.usage.cacheRead / (record.usage.input + record.usage.cacheRead + record.usage.cacheWrite)) * 100)}%`
                          : "不可用"}
                      </td>
                      <td>
                        {record.firstTextMs === null
                          ? "不可用"
                          : `${Math.round(record.firstTextMs)}ms`}{" "}
                        / {Math.round(record.durationMs)}ms
                      </td>
                      <td>
                        {formatSpeed(record.tps)}
                        <br />
                        {formatCost(
                          record.costKnown
                            ? (record.usage?.cost.total ?? null)
                            : null,
                        )}
                        <br />
                        <small>{formatPricing(record.pricing)}</small>
                        {record.pricing?.sourceUrl && (
                          <>
                            {" "}
                            ·{" "}
                            <a
                              href={record.pricing.sourceUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              价格来源
                            </a>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </details>
        <details className="help-panel">
          <summary>费用与统计如何计算</summary>
          <p>
            费用按请求开始时的官方峰/谷费率、Pi
            目录或用户单价估算（USD），不代表账单实扣。官方价格核对时间见每条记录；跨时段请求以开始时间估算，预算预留按峰时上限。TPS
            为客户端观测平均单请求吞吐。模型缓存与本地译文缓存分开，未知值不视作免费。
          </p>
        </details>
        <div className="account-summary">
          <p>供应商余额：{balance}；订阅额度 / 重置时间：未提供</p>
          <button
            onClick={() =>
              void act(async () => {
                const reply = await send<{
                  unavailable?: boolean;
                  data?: {
                    balance_infos?: {
                      currency: string;
                      total_balance: string;
                    }[];
                  };
                  updatedAt?: number;
                }>({ action: "balance" });
                setBalance(
                  reply.unavailable
                    ? "当前执行模式未提供账户数据"
                    : `${reply.data?.balance_infos?.map((info) => `${info.total_balance} ${info.currency}`).join(" / ") ?? "未知"}（DeepSeek 官方，${new Date(reply.updatedAt ?? Date.now()).toLocaleString()} 更新）`,
                );
              })
            }
          >
            查询余额
          </button>
        </div>
        <button
          className="quiet danger"
          disabled={Boolean(running)}
          onClick={() =>
            void act(async () => {
              await send({ action: "clear" });
              setUsage([]);
              setTurns([]);
              setSessionStats(undefined);
              setSessionId(crypto.randomUUID());
            })
          }
        >
          清除缓存、会话与用量
        </button>
      </section>
      <details id="settings" className="settings-card">
        <summary>模型、网站与隐私设置</summary>
        <form onSubmit={(event) => void save(event)}>
          <fieldset>
            <legend>模型连接</legend>
            <p className="muted">
              直连密钥仅在当前浏览器会话保留。本地模式的模型与预算由 Bridge
              管理。
            </p>
            <label>
              目标语言
              <input
                value={settings.targetLanguage}
                onChange={(event) =>
                  update("targetLanguage", event.target.value)
                }
                required
              />
            </label>
            <label>
              运行方式
              <select
                value={settings.mode}
                onChange={(event) =>
                  update("mode", event.target.value as Settings["mode"])
                }
              >
                <option value="direct">直接调用模型</option>
                <option value="bridge">本地 Pi Bridge</option>
              </select>
            </label>
            <label>
              供应商
              <select
                value={settings.model.provider}
                onChange={(event) =>
                  update("model", {
                    ...settings.model,
                    provider: event.target
                      .value as Settings["model"]["provider"],
                  })
                }
              >
                <option value="deepseek">DeepSeek</option>
                <option value="openai-compatible">OpenAI 兼容端点</option>
              </select>
            </label>
            <label>
              模型名称
              <input
                value={settings.model.model}
                onChange={(event) =>
                  update("model", {
                    ...settings.model,
                    model: event.target.value,
                  })
                }
                required
              />
            </label>
            <label>
              模型端点
              <input
                value={settings.model.endpoint}
                onChange={(event) =>
                  update("model", {
                    ...settings.model,
                    endpoint: event.target.value,
                  })
                }
                type="url"
                required
              />
            </label>
            <label>
              API Key（{hasKey ? "已设置" : "未设置"}）
              <input
                type="password"
                value={key}
                autoComplete="off"
                onChange={(event) => setKey(event.target.value)}
                placeholder="仅在本次浏览器会话保留"
              />
            </label>
            <button
              type="button"
              onClick={() =>
                void act(async () => {
                  await send({ action: "forget-key" });
                  setHasKey(false);
                })
              }
            >
              清除 API Key
            </button>
          </fieldset>
          <fieldset>
            <legend>阅读偏好</legend>
            <label>
              自动翻译网站
              <input
                value={autoOrigin}
                onChange={(event) => setAutoOrigin(event.target.value)}
                placeholder="https://example.com"
              />
            </label>
            <button
              type="button"
              onClick={() =>
                void act(async () => {
                  const origin = new URL(autoOrigin).origin;
                  update("autoOrigins", [
                    ...new Set([...settings.autoOrigins, origin]),
                  ]);
                  setAutoOrigin("");
                })
              }
            >
              添加网站（保存后授权）
            </button>
            <ul>
              {settings.autoOrigins.map((origin) => (
                <li key={origin}>
                  {origin}{" "}
                  <button
                    type="button"
                    onClick={() =>
                      update(
                        "autoOrigins",
                        settings.autoOrigins.filter((item) => item !== origin),
                      )
                    }
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
            <p>
              自动翻译会发送已授权网站的可见正文到上述模型端点。手动翻译只处理当前页面。
            </p>
            <label>
              术语表（每行 原词 = 译词）
              <textarea
                value={glossary}
                onChange={(event) => setGlossary(event.target.value)}
                rows={4}
              />
            </label>
          </fieldset>
          <fieldset>
            <legend>预算与计价</legend>
            <div className="form-grid">
              {(
                [
                  "dailyTokens",
                  "monthlyTokens",
                  "dailyCost",
                  "monthlyCost",
                ] as const
              ).map((field) => (
                <label key={field}>
                  {
                    {
                      dailyTokens: "日 token 预算",
                      monthlyTokens: "月 token 预算",
                      dailyCost: "日费用预算（USD）",
                      monthlyCost: "月费用预算（USD）",
                    }[field]
                  }
                  <input
                    type="number"
                    min="0"
                    step={field.endsWith("Cost") ? "0.01" : "1"}
                    value={settings[field] ?? ""}
                    onChange={(event) =>
                      update(
                        field,
                        event.target.value ? Number(event.target.value) : null,
                      )
                    }
                  />
                </label>
              ))}
            </div>
            <label>
              单价（每百万 tokens，USD；留空使用官方或目录价格）
              <input
                placeholder="input,output,cacheRead,cacheWrite"
                value={priceInput}
                onChange={(event) => setPriceInput(event.target.value)}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={settings.strictBudget}
                onChange={(event) =>
                  update("strictBudget", event.target.checked)
                }
              />
              消耗未知时暂停预算任务
            </label>
          </fieldset>
          <fieldset>
            <legend>隐私与历史</legend>
            <label>
              <input
                type="checkbox"
                checked={settings.persistUsage}
                onChange={(event) =>
                  update("persistUsage", event.target.checked)
                }
              />
              本地保存用量历史（不保存正文）
            </label>
            <label>
              历史保留天数
              <input
                type="number"
                min="1"
                max="90"
                value={settings.retentionDays}
                onChange={(event) =>
                  update("retentionDays", Number(event.target.value))
                }
              />
            </label>
            <label>
              预算提醒阈值
              <input
                type="number"
                min="0.1"
                max="1"
                step="0.05"
                value={settings.warningRatio}
                onChange={(event) =>
                  update("warningRatio", Number(event.target.value))
                }
              />
            </label>
            <label>
              统计时区
              <input
                value={settings.timeZone}
                onChange={(event) => update("timeZone", event.target.value)}
              />
            </label>
          </fieldset>
          <button className="primary" type="submit">
            授权并保存设置
          </button>
        </form>
      </details>
      <footer className="page-footer">
        <button onClick={() => void browser.runtime.openOptionsPage()}>
          在完整页面中打开
        </button>
        <p>PDF、封闭 Shadow DOM、跨域 iframe 和浏览器内置页暂不支持。</p>
      </footer>
    </main>
  );
}
