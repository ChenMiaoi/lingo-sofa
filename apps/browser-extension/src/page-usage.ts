import {
  formatCost,
  formatExchangeRate,
  formatTokens,
} from "@lingo-sofa/ui-shared";
import type { PageUsageSnapshot } from "./page-usage-data.js";

export const pageUsageStyles = `
.usage-pane{width:340px;padding:18px}.usage-pane .heading{padding-bottom:12px}.usage-heading{display:flex;align-items:center;gap:8px}.usage-heading strong{font-size:15px}.usage-pane .back{border:0;padding:0;width:28px;height:30px;background:transparent;font-size:20px}.usage-scope{font-size:11px;color:var(--ls-muted);margin:14px 0 10px}.usage-total{padding:16px;border:1px solid var(--line);border-radius:10px;background:var(--soft)}.usage-total span{display:block;color:var(--ls-muted);font-size:11px}.usage-total strong{display:block;font-size:28px;line-height:1.4;letter-spacing:-.6px;font-variant-numeric:tabular-nums;margin:5px 0}.usage-total small{color:var(--ls-muted);font-size:11px}.usage-metrics{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0}.usage-metrics>div{padding:10px 12px;border:1px solid var(--line);border-radius:9px;min-width:0}.usage-metrics span{display:block;color:var(--ls-muted);font-size:11px}.usage-metrics strong{display:block;margin-top:4px;font-size:16px;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.usage-meta{font-size:11px;color:var(--ls-muted);line-height:1.7;margin:12px 0}.usage-meta:empty{display:none}.usage-message{font-size:12px;line-height:1.7;color:var(--ls-muted);margin:16px 0;overflow-wrap:anywhere}.usage-message[role=alert]{color:var(--ls-error)}.usage-message:empty{display:none}.usage-footer{display:flex;justify-content:space-between;align-items:center;gap:12px;border-top:1px solid var(--line);padding-top:12px;font-size:11px;color:var(--ls-muted)}.usage-footer button{font-size:11px}.usage-more{display:block;width:100%;margin-top:12px;font-size:12px}.usage-total strong:empty:after{content:"—"}.usage-models{max-height:180px;overflow:auto}.usage-models>div{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;padding:10px 0;border-bottom:1px solid var(--line)}.usage-models strong{font-size:12px;overflow-wrap:anywhere}.usage-models span{font-size:12px;font-variant-numeric:tabular-nums}.usage-models small{grid-column:1/-1;color:var(--ls-muted);font-size:10px;overflow-wrap:anywhere}
`;

export function createPageUsage(
  document: Document,
  actions: {
    load: () => Promise<PageUsageSnapshot>;
    back: () => void;
    close: () => void;
    settings: () => Promise<unknown>;
  },
) {
  const panel = document.createElement("section");
  panel.className = "pane usage-pane";
  panel.hidden = true;
  panel.setAttribute("aria-label", "全部用量与费用");
  panel.innerHTML = `<div class="heading"><div class="usage-heading"><button type="button" class="back" aria-label="返回快捷菜单">‹</button><strong>用量与费用</strong></div><button type="button" class="close" aria-label="收起用量与费用">×</button></div><p class="usage-scope">全部客户端 · 按模型汇总</p><p class="usage-message" role="status"></p><div class="usage-content" hidden><div class="usage-total"><span>累计 API 费用 · 人民币</span><strong></strong><small>实际 Tokens × API 单价</small></div><div class="usage-metrics"><div><span>总 Tokens</span><strong data-metric="tokens"></strong></div><div><span>请求次数</span><strong data-metric="requests"></strong></div><div><span>输入 / 输出</span><strong data-metric="inout"></strong></div><div><span>使用模型</span><strong data-metric="models"></strong></div></div><div class="usage-models" aria-label="分模型用量"></div><p class="usage-meta"></p></div><div class="usage-footer"><span class="usage-updated">打开时自动更新</span><button type="button" class="usage-refresh">刷新</button></div><button type="button" class="usage-more">查看详细用量与历史 ↗</button>`;
  const message = panel.querySelector<HTMLElement>(".usage-message")!;
  const content = panel.querySelector<HTMLElement>(".usage-content")!;
  const refreshButton =
    panel.querySelector<HTMLButtonElement>(".usage-refresh")!;
  const updated = panel.querySelector<HTMLElement>(".usage-updated")!;
  let visible = false;
  let revision = 0;
  let pending = false;
  let lastUrl = "";
  let timer: ReturnType<typeof setInterval> | undefined;
  let hasData = false;
  function metric(name: string, text: string) {
    panel.querySelector<HTMLElement>(`[data-metric=${name}]`)!.textContent =
      text;
  }
  async function refresh() {
    if (!visible || pending) return;
    if (lastUrl !== document.location.href) {
      hasData = false;
      content.hidden = true;
      lastUrl = document.location.href;
    }
    const current = revision;
    const url = lastUrl;
    pending = true;
    refreshButton.disabled = true;
    if (!hasData) {
      message.setAttribute("role", "status");
      message.textContent = "正在读取累计用量…";
    }
    try {
      const usage = await actions.load();
      if (!visible || current !== revision || url !== document.location.href)
        return;
      content.hidden = false;
      hasData = true;
      panel.querySelector<HTMLElement>(".usage-total strong")!.textContent =
        formatCost(usage.totals.cost);
      panel.querySelector<HTMLElement>(".usage-total")!.title =
        formatExchangeRate();
      metric("tokens", formatTokens(usage.totals.tokens));
      metric("requests", String(usage.totals.requests));
      metric(
        "inout",
        `${formatTokens(usage.totals.input)} / ${formatTokens(usage.totals.output)}`,
      );
      metric("models", String(usage.models.length));
      panel.querySelector<HTMLElement>(".usage-scope")!.textContent =
        usage.coverage === "all-clients"
          ? "全部客户端 · 全部可用记录"
          : "本浏览器直连 · 全部可用记录";
      const rows = panel.querySelector<HTMLElement>(".usage-models")!;
      rows.replaceChildren();
      for (const model of usage.models) {
        const row = document.createElement("div");
        const name = document.createElement("strong");
        const cost = document.createElement("span");
        const detail = document.createElement("small");
        name.textContent = model.model;
        cost.textContent = formatCost(model.cost);
        detail.textContent = `${model.provider} · ${formatTokens(model.tokens)} tokens · ${model.requests} 次请求`;
        row.append(name, cost, detail);
        rows.append(row);
      }
      panel.querySelector<HTMLElement>(".usage-total small")!.textContent =
        usage.totals.cost === null
          ? `已知费用 ${formatCost(usage.totals.knownCost)}，总额尚不完整`
          : `API 原值 $${usage.totals.cost.toFixed(6)} · 按请求单价计算`;
      panel.querySelector<HTMLElement>(".usage-meta")!.textContent =
        usage.totals.unknown || usage.totals.unpriced
          ? `${usage.totals.unknown} 次用量未知，${usage.totals.unpriced} 次缺少单价；未知部分不计作免费。`
          : "输入、输出与缓存分别按 API 单价计算；订阅调用按 API 等值折算。本地译文缓存命中不产生新费用。";
      message.setAttribute("role", "status");
      message.textContent = usage.totals.requests
        ? ""
        : "还没有请求，翻译或提问后会显示累计用量。";
      updated.textContent = `${usage.mode === "bridge" ? "本地助手" : "模型直连"} · 已更新`;
    } catch (reason) {
      if (!visible || current !== revision) return;
      message.setAttribute("role", "alert");
      message.textContent = hasData
        ? "更新失败，当前显示上次读取的用量。可稍后刷新。"
        : reason instanceof Error && reason.message.includes("更新本地助手")
          ? reason.message
          : "暂时无法读取用量，请检查模型连接后刷新。";
      updated.textContent = "更新失败";
    } finally {
      if (current === revision) {
        pending = false;
        refreshButton.disabled = false;
      }
    }
  }
  function setVisible(open: boolean) {
    visible = open;
    revision++;
    pending = false;
    if (timer) clearInterval(timer);
    if (open) {
      lastUrl = "";
      updated.textContent = "正在更新…";
      void refresh();
      timer = setInterval(() => void refresh(), 2_000);
    }
  }
  panel.querySelector<HTMLButtonElement>(".back")!.onclick = actions.back;
  panel.querySelector<HTMLButtonElement>(".close")!.onclick = actions.close;
  refreshButton.onclick = () => void refresh();
  panel.querySelector<HTMLButtonElement>(".usage-more")!.onclick = () => {
    void actions.settings().catch(() => {
      message.setAttribute("role", "alert");
      message.textContent = "无法打开完整用量页，请重试。";
    });
  };
  return { panel, setVisible, destroy: () => setVisible(false) };
}
