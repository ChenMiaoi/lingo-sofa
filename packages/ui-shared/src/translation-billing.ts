import { formatCost, formatExchangeRate } from "./currency.js";
import type { TranslationBilling } from "@lingo-sofa/protocol";
import { formatPricing } from "./pricing.js";

export function formatTranslationBilling(billing?: TranslationBilling): {
  text: string;
  title: string;
} {
  if (!billing)
    return {
      text: "Token 用量未知 · 费用未知",
      title: "翻译服务未返回用量信息；未知不代表免费。",
    };
  if (billing.source === "cache")
    return {
      text: "缓存命中 · 本次 0 Tokens · ¥0",
      title: "复用已有译文，本次未调用模型；不代表此前翻译免费。",
    };
  const tokens =
    billing.tokens === null
      ? "Token 用量未知"
      : `${new Intl.NumberFormat("zh-CN").format(billing.tokens)} Tokens`;
  const cost = billing.cost === null ? "费用未知" : formatCost(billing.cost);
  return {
    text: `${billing.batchSize > 1 ? `同批 ${billing.batchSize} 段合计 · ` : ""}${tokens} · ${billing.billingMode === "subscription" ? "API 等值 " : ""}${cost}`,
    title: `${billing.billingMode === "subscription" ? "ChatGPT 订阅：按实际 Tokens 与 API 单价折算，不代表订阅账单实扣。" : ""}${billing.batchSize > 1 ? "供应商仅提供整批计量，各段显示同一批用量，不能逐段累加。" : "本次翻译请求的供应商用量。"} 费用为人民币估算，不代表账单实扣。美元原值：${billing.cost === null ? "未知" : billing.cost.toPrecision(7) + " USD"}。${formatExchangeRate()} ${formatPricing(billing.pricing)}`,
  };
}

export function appendTranslationBilling(
  element: HTMLElement,
  billing?: TranslationBilling,
): void {
  const note = element.ownerDocument.createElement("span");
  const formatted = formatTranslationBilling(billing);
  note.className = "lingo-sofa-inline-usage";
  note.textContent = formatted.text;
  note.title = formatted.title;
  note.style.cssText =
    "display:block;margin-block-start:0.35em;font-size:0.75em;font-weight:400;line-height:1.5;color:inherit";
  element.append(note);
}
