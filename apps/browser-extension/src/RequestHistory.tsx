import { Fragment, useState } from "react";
import type { UsageRecord } from "@lingo-sofa/protocol";
import { apiCost } from "@lingo-sofa/translation-core";
import {
  formatCost,
  formatPricing,
  formatSpeed,
  formatTokens,
} from "@lingo-sofa/ui-shared";

export const requestStatuses = {
  success: "已完成",
  failed: "失败",
  cancelled: "已取消",
  unknown: "结果未知",
};

export function RequestHistory({
  records,
  timeZone,
}: {
  records: UsageRecord[];
  timeZone: string;
}) {
  const [expanded, setExpanded] = useState<string>();
  return (
    <div className="ls-table-scroll ls-request-list">
      <table aria-label="请求明细">
        <thead>
          <tr>
            <th>时间 / 来源</th>
            <th>模型 / 状态</th>
            <th>用量</th>
            <th>费用</th>
            <th>
              <span className="ls-sr-only">操作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => {
            const open = expanded === record.requestId;
            const detailId = `ls-request-${encodeURIComponent(record.requestId)}`;
            return (
              <Fragment key={record.requestId}>
                <tr className="ls-request-row">
                  <td data-label="时间">
                    <time dateTime={new Date(record.timestamp).toISOString()}>
                      {new Date(record.timestamp).toLocaleString("zh-CN", {
                        timeZone,
                      })}
                    </time>
                    <small>
                      {record.sourceKind === "web" ? "浏览器" : "Discord"} ·{" "}
                      {record.provider}
                    </small>
                  </td>
                  <td className="ls-request-model">
                    <strong>{record.model}</strong>
                    <small>
                      <span
                        className={`ls-request-status ls-request-${record.status}`}
                      >
                        {requestStatuses[record.status]}
                      </span>
                      {record.billingMode === "subscription" &&
                        " · ChatGPT 订阅"}
                      {record.billingMode === "free" && " · 免 Key 翻译"}
                    </small>
                  </td>
                  <td data-label="用量">
                    {record.billingMode === "free"
                      ? `${record.characters ?? 0} 字符`
                      : record.usage
                        ? `${formatTokens(record.usage.totalTokens)} Tokens`
                        : "未知"}
                  </td>
                  <td data-label="费用">{formatCost(apiCost(record))}</td>
                  <td className="ls-request-action">
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-controls={open ? detailId : undefined}
                      onClick={() =>
                        setExpanded(open ? undefined : record.requestId)
                      }
                    >
                      {open ? "收起明细" : "查看明细"}
                    </button>
                  </td>
                </tr>
                {open && (
                  <tr className="ls-request-detail-row" id={detailId}>
                    <td colSpan={5}>
                      <dl
                        className="ls-request-details"
                        aria-label="请求技术明细"
                      >
                        <div>
                          <dt>输入 / 输出 Tokens</dt>
                          <dd>
                            {record.billingMode === "free"
                              ? "不适用"
                              : record.usage
                                ? `${formatTokens(record.usage.input + record.usage.cacheRead + record.usage.cacheWrite)} / ${formatTokens(record.usage.output)}`
                                : "未知"}
                          </dd>
                        </div>
                        <div>
                          <dt>缓存读取 / 写入</dt>
                          <dd>
                            {record.billingMode === "free"
                              ? "不适用"
                              : record.usage
                                ? `${formatTokens(record.usage.cacheRead)} / ${formatTokens(record.usage.cacheWrite)}`
                                : "未知"}
                          </dd>
                        </div>
                        {record.usage?.reasoning !== undefined && (
                          <div>
                            <dt>思考 Tokens（输出的一部分）</dt>
                            <dd>{formatTokens(record.usage.reasoning)}</dd>
                          </div>
                        )}
                        <div>
                          <dt>首译文 / 总耗时</dt>
                          <dd>
                            {record.firstTextMs === null
                              ? "不可用"
                              : `${Math.round(record.firstTextMs)}ms`}{" "}
                            / {Math.round(record.durationMs)}ms
                          </dd>
                        </div>
                        <div>
                          <dt>生成速度</dt>
                          <dd>{formatSpeed(record.tps)}</dd>
                        </div>
                        {record.billingMode !== "free" && (
                          <div className="ls-request-pricing">
                            <dt>计价依据</dt>
                            <dd>
                              {formatPricing(record.pricing)}{" "}
                              {record.pricing?.sourceUrl && (
                                <a
                                  href={record.pricing.sourceUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  价格来源 ↗
                                </a>
                              )}
                            </dd>
                          </div>
                        )}
                      </dl>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
