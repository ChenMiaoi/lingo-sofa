import React, { useEffect, useRef, useState } from "react";
import {
  errorMessage,
  type LoadUsageReport,
  type UsageReport,
  type UsageTotals,
} from "./api";

const colors = ["#91a7ba", "#9ba98b", "#b3a289", "#9f95b2", "#ad9696"];
const id = (row: UsageReport["models"][number]) =>
  JSON.stringify([row.provider, row.model]);
const number = (value: number) => value.toLocaleString("en-US");
function money(totals: UsageTotals) {
  if (!totals.pricedCalls) return "未知";
  return moneyValue(totals.estimatedCost);
}
function moneyValue(amount: number) {
  const value = Math.max(0, amount);
  return value > 0 && value < 0.00000001
    ? "<0.00000001"
    : value.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 8,
      });
}
function Breakdown({ totals }: { totals: UsageTotals }) {
  const states = [
    ["待回报", totals.pending],
    ["部分回报", totals.partial],
    ["用量未知", totals.unknown],
    ["未发出", totals.notDispatched],
  ].filter(([, value]) => Number(value) > 0);
  return (
    <div className="usage-dashboard-breakdown">
      <dl>
        {(
          [
            ["输入", totals.input],
            ["输出", totals.output],
            ["缓存读取", totals.cacheRead],
            ["缓存写入", totals.cacheWrite],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{number(value)}</dd>
          </div>
        ))}
      </dl>
      {states.length > 0 && (
        <p>{states.map(([label, value]) => `${label} ${value}`).join(" · ")}</p>
      )}
      {totals.unpriced > 0 && <p>未定价 {totals.unpriced} 次</p>}
    </div>
  );
}
export function UsageSettings({
  active,
  loadReport,
}: {
  active: boolean;
  loadReport: LoadUsageReport;
}) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [tab, setTab] = useState<"overview" | "models">("overview");
  const [measure, setMeasure] = useState<"tokens" | "cost">("tokens");
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    pending.current = true;
    setLoading(true);
    setError("");
    void loadReport()
      .then(
        (value) => {
          if (!disposed) setReport(value);
        },
        (reason) => {
          if (!disposed) setError(errorMessage(reason));
        },
      )
      .finally(() => {
        if (!disposed) {
          pending.current = false;
          setLoading(false);
        }
      });
    return () => {
      disposed = true;
      pending.current = false;
    };
  }, [active, loadReport, reload]);
  const models = report?.models ?? [];
  const value = (totals: UsageTotals) =>
    measure === "tokens"
      ? totals.totalTokens
      : totals.pricedCalls
        ? Math.max(0, totals.estimatedCost)
        : 0;
  const ranked = [...models].sort(
    (a, b) =>
      value(b.totals) - value(a.totals) ||
      (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0),
  );
  const colorMap = new Map(
    [...models]
      .sort((a, b) => (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0))
      .map((row, index) => [id(row), colors[index % colors.length]!]),
  );
  const total = models.reduce((sum, row) => sum + value(row.totals), 0);
  const positive = ranked.filter((row) => value(row.totals) > 0);
  const parts = positive.slice(0, 5).map((row) => ({
    key: id(row),
    name: row.model,
    provider: row.provider,
    value: value(row.totals),
    color: colorMap.get(id(row))!,
  }));
  if (positive.length > 5)
    parts.push({
      key: "others",
      name: `其他 ${positive.length - 5} 个模型`,
      provider: "",
      value: positive.slice(5).reduce((sum, row) => sum + value(row.totals), 0),
      color: "#6e737b",
    });
  const filtered = models.filter((row) =>
    `${row.provider} ${row.model}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const percent = (amount: number) => {
    const share = total ? (amount / total) * 100 : 0;
    return share > 0 && share < 0.1 ? "<0.1%" : `${share.toFixed(1)}%`;
  };
  return (
    <section
      className="usage-settings settings-group"
      hidden={!active}
      aria-label="用量与费用"
    >
      <div className="usage-dashboard-toolbar">
        <div
          className="usage-dashboard-tabs"
          role="tablist"
          aria-label="用量视图"
        >
          {(["overview", "models"] as const).map((key, index) => (
            <button
              role="tab"
              id={`usage-${key}-tab`}
              aria-controls={`usage-${key}-panel`}
              aria-selected={tab === key}
              tabIndex={tab === key ? 0 : -1}
              ref={(el) => {
                tabs.current[index] = el;
              }}
              onClick={() => setTab(key)}
              onKeyDown={(event) => {
                if (
                  ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
                ) {
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? 1
                        : 1 - index;
                  setTab(next === 0 ? "overview" : "models");
                  tabs.current[next]?.focus();
                }
              }}
              key={key}
            >
              {key === "overview" ? "概览" : "模型明细"}
            </button>
          ))}
        </div>
        <button
          className="usage-dashboard-refresh"
          disabled={loading}
          onClick={() => {
            if (pending.current) return;
            pending.current = true;
            setReload((v) => v + 1);
          }}
        >
          {loading ? "读取中…" : error ? "重试读取" : "刷新"}
        </button>
      </div>
      <p className="usage-dashboard-caption">本机累计</p>
      {loading && (
        <p className="usage-dashboard-status" role="status">
          {report ? "正在刷新，保留上次数据…" : "正在读取用量…"}
        </p>
      )}
      {error && (
        <p className="usage-dashboard-status" role="alert">
          {report ? "刷新失败，保留上次数据。" : "读取失败。"}
          {error}
        </p>
      )}
      {report && (
        <>
          <div
            hidden={tab !== "overview"}
            role="tabpanel"
            id="usage-overview-panel"
            aria-labelledby="usage-overview-tab"
          >
            <dl className="usage-dashboard-metrics">
              <div className="usage-dashboard-primary">
                <dt>
                  已知估算 <small>USD</small>
                </dt>
                <dd>{money(report.totals)}</dd>
              </div>
              <div>
                <dt>Token</dt>
                <dd>{number(report.totals.totalTokens)}</dd>
              </div>
              <div>
                <dt>模型调用</dt>
                <dd>{number(report.totals.calls)}</dd>
              </div>
            </dl>
            {!!(
              report.totals.unpriced ||
              report.totals.pending ||
              report.totals.partial ||
              report.totals.unknown
            ) && (
              <p className="usage-dashboard-status">
                {!!report.totals.unpriced && (
                  <>{report.totals.unpriced} 次费用未知</>
                )}
                {report.totals.pending +
                  report.totals.partial +
                  report.totals.unknown >
                0
                  ? `${report.totals.unpriced ? " · " : ""}部分用量未完整回报`
                  : ""}
              </p>
            )}
            <section
              className="usage-dashboard-distribution"
              aria-label="模型分布"
            >
              <div className="usage-dashboard-chart-header">
                <h3>模型分布</h3>
                <div className="usage-dashboard-measures" aria-label="分布指标">
                  <button
                    aria-pressed={measure === "tokens"}
                    onClick={() => setMeasure("tokens")}
                  >
                    Token
                  </button>
                  <button
                    aria-pressed={measure === "cost"}
                    onClick={() => setMeasure("cost")}
                  >
                    估算费用
                  </button>
                </div>
              </div>
              {total > 0 ? (
                <>
                  <div className="usage-dashboard-stack" aria-hidden="true">
                    {parts.map((part) => (
                      <span
                        key={part.key}
                        style={{
                          width: `${(part.value / total) * 100}%`,
                          background: part.color,
                        }}
                      />
                    ))}
                  </div>
                  <ol className="usage-dashboard-legend">
                    {parts.map((part) => (
                      <li key={part.key}>
                        <span
                          className="usage-dashboard-dot"
                          style={{ background: part.color }}
                          aria-hidden="true"
                        />
                        <span className="usage-dashboard-identity">
                          <strong>{part.name}</strong>
                          {part.provider && <small>{part.provider}</small>}
                        </span>
                        <span className="usage-dashboard-amount">
                          {measure === "tokens"
                            ? number(part.value)
                            : moneyValue(part.value)}
                          <small>{percent(part.value)}</small>
                        </span>
                      </li>
                    ))}
                  </ol>
                </>
              ) : (
                <p className="usage-dashboard-empty">
                  {!models.length
                    ? "暂无本机调用记录"
                    : measure === "cost"
                      ? report.totals.pricedCalls
                        ? "已知估算为 0，暂无费用分布"
                        : "暂无可估算费用"
                      : "暂无已报告 Token"}
                </p>
              )}
              {measure === "cost" &&
                total > 0 &&
                report.totals.unpriced > 0 && (
                  <p className="usage-dashboard-caption">占比仅含已知估算。</p>
                )}
            </section>
          </div>
          <div
            hidden={tab !== "models"}
            role="tabpanel"
            id="usage-models-panel"
            aria-labelledby="usage-models-tab"
          >
            <div className="usage-dashboard-filter">
              <input
                aria-label="筛选用量模型"
                placeholder="筛选服务商或模型"
                ref={input}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && (
                <button
                  onClick={() => {
                    setQuery("");
                    input.current?.focus();
                  }}
                >
                  清空
                </button>
              )}
            </div>
            <div className="usage-dashboard-table-heading">
              <span>模型 / 服务商</span>
              <span>Token</span>
              <span>估算 · USD</span>
              <span>调用</span>
            </div>
            <div className="usage-dashboard-table">
              {filtered.map((row) => (
                <details className="usage-dashboard-model-row" key={id(row)}>
                  <summary>
                    <span className="usage-dashboard-identity">
                      <strong>{row.model}</strong>
                      <small>{row.provider}</small>
                    </span>
                    <span className="usage-dashboard-cell">
                      <small>Token</small>
                      {number(row.totals.totalTokens)}
                    </span>
                    <span className="usage-dashboard-cell">
                      <small>估算 · USD</small>
                      {money(row.totals)}
                      {row.totals.pricedCalls > 0 &&
                        row.totals.unpriced > 0 && <em>+ 未知</em>}
                    </span>
                    <span className="usage-dashboard-cell">
                      <small>调用</small>
                      {number(row.totals.calls)}
                    </span>
                  </summary>
                  <Breakdown totals={row.totals} />
                </details>
              ))}
            </div>
            {!filtered.length && (
              <p className="usage-dashboard-empty">
                {models.length ? "没有匹配的模型" : "暂无本机调用记录"}
              </p>
            )}
          </div>
          <details className="usage-dashboard-notes">
            <summary>Token 明细</summary>
            <Breakdown totals={report.totals} />
          </details>
          <details className="usage-dashboard-notes">
            <summary>统计说明</summary>
            <p>调用含生成与压缩，未发出不计次。</p>
            <p>美元估算以账单为准，未知不代表免费；用量状态与未定价可重叠。</p>
          </details>
        </>
      )}
    </section>
  );
}
