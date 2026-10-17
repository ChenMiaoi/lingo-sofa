export function formatTokens(value: number | null): string {
  return value === null ? "未知" : new Intl.NumberFormat("zh-CN").format(value);
}
export function formatUsageTokens(value: number | null, unknown = 0): string {
  if (value === null || (unknown > 0 && value === 0)) return "未知";
  return `${formatTokens(value)}${unknown > 0 ? " + 未知" : ""}`;
}
export {
  formatCost,
  formatUsageBilling,
  formatExchangeRate,
  usdCnySnapshot,
} from "./currency.js";
export function formatSpeed(value: number | null): string {
  return value === null ? "不可用" : `${value.toFixed(1)} tokens/s`;
}
export { formatPricing } from "./pricing.js";
export {
  renderTranslationMarkdown,
  inlineTranslationStyle,
} from "./markdown.js";
export {
  formatTranslationBilling,
  appendTranslationBilling,
} from "./translation-billing.js";
export { createProviderAuth } from "./provider-auth.js";
export { providerAuthStyles } from "./provider-auth-styles.js";
export { createModelPreferences } from "./model-preferences.js";
export { createAISettings, type AISettingsClient } from "./ai-settings.js";
export { createAskModelSelector } from "./ask-model-selector.js";

export { designStyles } from "./design-styles.js";
export { askStyles } from "./ask-styles.js";
export {
  attachAskWindow,
  placeAskWindow,
  textAnchorRect,
  registerAskShortcut,
  type AskAnchorRect,
} from "./ask-window.js";

export {
  themeStyles,
  themeDeclarations,
  themeAliases,
  type ColorTheme,
} from "./theme.js";

export { createProviderEditor } from "./provider-editor.js";
export { thinkingNames, translationLanguages } from "./preference-labels.js";
