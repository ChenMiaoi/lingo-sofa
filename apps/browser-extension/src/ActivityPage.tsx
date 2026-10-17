import { historyPageSize, type HistoryPage } from "./history-page.js";
import { pollWhileVisible } from "./visible-polling.js";
import * as React from "react";
import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import type { Settings, UsageRecord } from "@lingo-sofa/protocol";
import { PricingPreferences } from "./PricingPreferences.js";
import { RequestHistory, requestStatuses } from "./RequestHistory.js";
import type { PageUsageSnapshot } from "./page-usage-data.js";
import { summarizeAvailableUsage } from "./page-usage-data.js";
import {
  formatUsageBilling,
  formatUsageTokens,
  formatExchangeRate,
} from "@lingo-sofa/ui-shared";

interface ActivityState {
  settings: Settings;
  historyPage?: HistoryPage;
  allUsage?: PageUsageSnapshot;
  executionSettings?: Settings;
  usage: UsageRecord[];
  bridgeUsage?: UsageRecord[];
  bridgeError?: string;
  summaryError?: string;
  sharedUsage?: boolean;
  queue?: { running: number; pending: number };
  cacheStats?: { hits: number; lookups: number; ratio: number | null };
  translationCacheStats?: {
    hits: number;
    lookups: number;
    ratio: number | null;
  };
}
export function ActivityPage({ section }: { section: "usage" | "history" }) {
  const [state, setState] = useState<ActivityState>();
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [range, setRange] = useState("all");
  const [source, setSource] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [scope, setScope] = useState("");
  const [status, setStatus] = useState("");
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [balance, setBalance] = useState("未查询");
  const [querying, setQuerying] = useState(false);
  useEffect(
    () =>
      pollWhileVisible(
        async () => {
          const reply = await browser.runtime.sendMessage({
            action: "state",
            includeUsageSummary: section === "usage",
            ...(section === "history"
              ? {
                  historyQuery: {
                    offset,
                    range,
                    source,
                    provider,
                    model,
                    scope,
                    status,
                  },
                }
              : {}),
          });
          if (reply?.ok === false) throw new Error(reply.error);
          return reply as ActivityState;
        },
        (reply) => {
          setState(reply);
          setRefreshError("");
        },
        () =>
          setRefreshError(
            "无法更新用量，已读取的数据会保留；页面可见时自动重试。",
          ),
      ),
    [section, offset, range, source, provider, model, scope, status],
  );
  const settings = state?.executionSettings ?? state?.settings;
  const bridgeError = state?.bridgeError;
  const unavailable =
    !state ||
    Boolean(bridgeError) ||
    (section === "usage" && Boolean(state.summaryError));
  const page = state?.historyPage;
  const records = bridgeError ? [] : (page?.records ?? []);
  const total = page?.total ?? 0;
  const noHistory =
    section === "history" && !unavailable && page?.allCount === 0;
  const extraFilterCount = [source, provider, model, scope].filter(
    Boolean,
  ).length;
  const filtersActive =
    range !== "all" || Boolean(status) || extraFilterCount > 0;
  const resetFilters = () => {
    setRange("all");
    setSource("");
    setProvider("");
    setModel("");
    setScope("");
    setStatus("");
    setOffset(0);
  };
  const pageOffset = page?.offset ?? 0;
  const timeZone = settings?.timeZone ?? "Asia/Shanghai";
  const summary =
    state?.allUsage ??
    (state?.settings.mode === "direct"
      ? summarizeAvailableUsage(state.usage, "direct")
      : undefined);
  const totals = summary?.totals;
  const billing = totals ? formatUsageBilling(totals) : undefined;
  const filter = (
    label: string,
    value: string,
    change: (value: string) => void,
    options: React.ReactNode,
  ) => (
    <label>
      {label}
      <select
        aria-label={label}
        value={value}
        onChange={(event) => {
          change(event.target.value);
          setOffset(0);
        }}
      >
        {options}
      </select>
    </label>
  );
  const historyPage = section === "history";
  return (
    <section
      className="ls-activity"
      aria-label={historyPage ? "请求历史" : "用量监控"}
    >
      <header className="ls-design-heading ls-activity-heading">
        <div>
          <h1>{historyPage ? "请求历史" : "用量与费用"}</h1>
          <p>
            {historyPage
              ? "回看翻译与问答的请求状态、耗时和消耗。这里不保存正文。"
              : summary?.coverage === "all-clients"
                ? "全部客户端的累计消耗，按模型汇总并按 API 单价计算。"
                : summary
                  ? "本浏览器的累计消耗，按模型汇总并按 API 单价计算。"
                  : "按模型查看翻译与问答的累计消耗。"}
          </p>
        </div>
        <span className="ls-status-chip">
          {state?.settings.mode === "direct" ? "模型直连" : "本地助手"}
        </span>
      </header>
      {error && <p role="alert">{error}</p>}
      {refreshError && <p role="alert">{refreshError}</p>}
      {bridgeError && <p role="alert">{bridgeError}</p>}
      {state?.summaryError && <p role="alert">{state.summaryError}</p>}
      {!state && !refreshError && <p role="status">正在读取用量…</p>}
      {noHistory && (
        <div className="ls-design-card ls-history-first-run">
          <EmptyState filtered={false} unavailable={false} />
          <a href="#translation">查看翻译偏好 →</a>
          {filtersActive && (
            <button type="button" onClick={resetFilters}>
              清除筛选
            </button>
          )}
        </div>
      )}
      {historyPage && state && !unavailable && !noHistory && (
        <div className="ls-activity-filters" aria-label="筛选用量记录">
          <div className="ls-activity-primary-filters">
            {filter(
              "查看范围",
              range,
              setRange,
              <>
                <option value="all">全部可用记录</option>
                <option value="day">今日</option>
                <option value="month">本月</option>
              </>,
            )}
            {filter(
              "请求状态",
              status,
              setStatus,
              <>
                <option value="">全部状态</option>
                {Object.entries(requestStatuses).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </>,
            )}
            <button
              type="button"
              aria-expanded={moreFiltersOpen}
              onClick={() => setMoreFiltersOpen((open) => !open)}
            >
              更多筛选{extraFilterCount ? ` · ${extraFilterCount}` : ""}
            </button>
            {filtersActive && (
              <button type="button" onClick={resetFilters}>
                清除筛选
              </button>
            )}
          </div>
          {moreFiltersOpen && (
            <div className="ls-activity-toolbar" id="ls-history-extra-filters">
              {filter(
                "来源",
                source,
                setSource,
                <>
                  <option value="">全部来源</option>
                  <option value="web">浏览器</option>
                  <option value="discord">Discord</option>
                </>,
              )}
              {filter(
                "供应商",
                provider,
                setProvider,
                <>
                  <option value="">全部供应商</option>
                  {(page?.providers ?? []).map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </>,
              )}
              {filter(
                "模型",
                model,
                setModel,
                <>
                  <option value="">全部模型</option>
                  {(page?.models ?? []).map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </>,
              )}
              {filter(
                "页面 / 频道范围",
                scope,
                setScope,
                <>
                  <option value="">全部范围</option>
                  {(page?.scopes ?? []).map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </>,
              )}
            </div>
          )}
        </div>
      )}
      {!noHistory && state && (
        <p className="ls-activity-caption">
          {unavailable
            ? "用量暂不可用"
            : `${historyPage ? total : (totals?.requests ?? 0)} 次请求 · ${historyPage ? "请求明细" : summary?.coverage === "all-clients" ? "全部客户端" : "本浏览器直连"}`}{" "}
          ·{" "}
          {settings?.persistUsage
            ? `本地保留 ${settings.retentionDays} 天`
            : "仅当前会话"}{" "}
          · {timeZone}
        </p>
      )}
      {!historyPage && (
        <>
          <div className="ls-activity-metrics" aria-label="用量摘要">
            <div className="ls-cost-metric">
              <span>累计 API 费用 · 人民币</span>
              <strong title={formatExchangeRate()}>
                {unavailable ? "暂不可用" : (billing?.amount ?? "正在读取…")}
              </strong>
              <small>
                {billing?.pending
                  ? billing.amount === "待计费"
                    ? "等待用量或单价"
                    : "已知费用；另有请求待计费"
                  : "按每次请求的价格计算"}
              </small>
            </div>
            <div>
              <span>总 Tokens</span>
              <strong>
                {formatUsageTokens(
                  unavailable ? null : (totals?.tokens ?? null),
                  totals?.unknown,
                )}
              </strong>
              <small>
                {totals?.unknown
                  ? `${totals.unknown} 次请求用量未知`
                  : `${summary?.models.length ?? 0} 个模型的累计消耗`}
              </small>
            </div>
            <div>
              <span>输入 tokens</span>
              <strong>
                {formatUsageTokens(
                  unavailable ? null : (totals?.input ?? null),
                  totals?.unknown,
                )}
              </strong>
              <small>包含模型缓存读写</small>
            </div>
            <div>
              <span>输出 tokens</span>
              <strong>
                {formatUsageTokens(
                  unavailable ? null : (totals?.output ?? null),
                  totals?.unknown,
                )}
              </strong>
              <small>模型生成的内容</small>
            </div>
          </div>
          <div className="ls-design-card ls-trend-card">
            <div className="ls-card-heading">
              <div>
                <h2>分模型消耗</h2>
                <p>全部可用记录 · 同一模型跨客户端合并</p>
              </div>
              <a href="#history">查看请求历史 →</a>
            </div>
            {summary?.models.length ? (
              <div className="ls-table-scroll">
                <table aria-label="分模型消耗">
                  <thead>
                    <tr>
                      <th>模型 / 供应商</th>
                      <th>输入 Tokens</th>
                      <th>输出 Tokens</th>
                      <th>总 Tokens / 请求</th>
                      <th>API 费用</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.models.map((model) => {
                      const modelBilling = formatUsageBilling(model);
                      return (
                        <tr key={JSON.stringify([model.provider, model.model])}>
                          <td>
                            <strong>{model.model}</strong>
                            <small>{model.provider}</small>
                          </td>
                          <td>
                            {formatUsageTokens(model.input, model.unknown)}
                          </td>
                          <td>
                            {formatUsageTokens(model.output, model.unknown)}
                          </td>
                          <td>
                            {formatUsageTokens(model.tokens, model.unknown)}
                            <small>{model.requests} 次请求</small>
                          </td>
                          <td>
                            {modelBilling.amount}
                            <small>
                              {modelBilling.pending ||
                                `$${(model.cost ?? model.knownCost).toFixed(6)} USD`}
                            </small>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState filtered={false} unavailable={unavailable} />
            )}
          </div>
          {billing?.pending && (
            <p className="ls-info-note">{billing.pending}</p>
          )}
          <div className="ls-activity-secondary">
            <div className="ls-design-card">
              <h2>运行与缓存</h2>
              <p>
                当前翻译：
                {unavailable
                  ? "未知"
                  : settings?.translationEngine === "bing"
                    ? "必应翻译"
                    : settings?.translationEngine === "google"
                      ? "谷歌翻译"
                      : settings?.model.model}
              </p>
              <dl>
                <div>
                  <dt>排队 / 运行</dt>
                  <dd>
                    {unavailable || !state?.queue
                      ? "未知"
                      : `${state?.queue?.pending ?? 0} / ${state?.queue?.running ?? 0}`}
                  </dd>
                </div>
                <div>
                  <dt>当前会话缓存</dt>
                  <dd>
                    {unavailable || !state?.cacheStats
                      ? "未知"
                      : `${state?.cacheStats?.hits ?? 0} / ${state?.cacheStats?.lookups ?? 0} 段命中`}
                  </dd>
                </div>
                <div>
                  <dt>跨页面译文缓存</dt>
                  <dd>{`${state?.translationCacheStats?.hits ?? 0} / ${state?.translationCacheStats?.lookups ?? 0} 段命中`}</dd>
                </div>
              </dl>
              <p>本地缓存命中不发起模型请求，不增加 API 费用。</p>
              {Boolean(state?.queue?.running) && (
                <p role="status">运行中，用量正在统计…</p>
              )}
            </div>
            <div className="ls-design-card">
              <h2>供应商账户</h2>
              <p>供应商余额：{balance}</p>
              <p>订阅额度 / 重置时间：未提供</p>
              <button
                disabled={querying || unavailable}
                onClick={() => {
                  setQuerying(true);
                  void browser.runtime
                    .sendMessage({ action: "balance" })
                    .then((reply) => {
                      if (reply?.ok === false) throw new Error(reply.error);
                      setBalance(
                        reply.unavailable
                          ? "当前执行模式未提供供应商数据"
                          : `${reply.data?.balance_infos?.map((info: { total_balance: string; currency: string }) => `${info.total_balance} ${info.currency}`).join(" / ") ?? "未知"}（DeepSeek 官方，${new Date(reply.updatedAt ?? Date.now()).toLocaleString()} 更新）`,
                      );
                    })
                    .catch((reason: Error) => setError(reason.message))
                    .finally(() => setQuerying(false));
                }}
              >
                {querying ? "正在查询…" : "查询余额"}
              </button>
            </div>
          </div>
          <details className="ls-design-card ls-billing-help">
            <summary>费用与统计如何计算</summary>
            <p>
              {formatExchangeRate()}
              。费用按 API 实际用量与每次请求的价格快照计算；订阅调用按 API
              等值记账，缺少用量或单价的请求单独列为待计费。TPS
              为客户端观测平均单请求吞吐。
            </p>
            <p>
              {summary?.coverage === "all-clients"
                ? "汇总本地助手全部客户端与本浏览器直连记录；请求明细仍遵循原有隔离设置。"
                : "当前为模型直连模式，仅汇总本浏览器记录；切换本地助手后可合并全部客户端。"}
            </p>
          </details>
          {state?.settings.mode === "direct" && (
            <PricingPreferences
              key={`${state.settings.model.accountId}:${state.settings.model.provider}:${state.settings.model.model}:${state.settings.model.endpoint}`}
              model={state.settings.model}
            />
          )}
        </>
      )}
      {historyPage && state && !noHistory && (
        <div className="ls-design-card ls-history-card">
          <div className="ls-card-heading">
            <h2>
              请求明细 <span className="ls-count">{total}</span>
            </h2>
            <a href="#privacy">保存与清理设置 →</a>
          </div>
          {total ? (
            <>
              <RequestHistory records={records} timeZone={timeZone} />
              <div className="ls-history-footer">
                <span>
                  显示 {pageOffset + 1}–{pageOffset + records.length} / {total}{" "}
                  条
                </span>
                <button
                  disabled={pageOffset === 0}
                  onClick={() =>
                    setOffset(Math.max(0, pageOffset - historyPageSize))
                  }
                >
                  上一页
                </button>
                <button
                  disabled={pageOffset + records.length >= total}
                  onClick={() => setOffset(pageOffset + historyPageSize)}
                >
                  下一页
                </button>
              </div>
            </>
          ) : (
            <EmptyState
              filtered={(page?.allCount ?? 0) > 0}
              unavailable={unavailable}
            />
          )}
        </div>
      )}
    </section>
  );
}
function EmptyState({
  filtered,
  unavailable,
}: {
  filtered: boolean;
  unavailable: boolean;
}) {
  return (
    <div className="ls-activity-empty">
      <span aria-hidden="true">{filtered ? "⌕" : "↗"}</span>
      <h3>
        {unavailable
          ? "暂时无法读取记录"
          : filtered
            ? "没有符合筛选条件的记录"
            : "还没有请求记录"}
      </h3>
      <p>
        {unavailable
          ? "连接恢复后会自动更新，可在连接方式中检查本地助手。"
          : filtered
            ? "试试调整时间、来源或模型筛选。"
            : "在网页中翻译或提问后，用量与请求状态会显示在这里。"}
      </p>
    </div>
  );
}
