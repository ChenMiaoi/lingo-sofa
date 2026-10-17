export const cleanupLabels = {
  "browser-data": "浏览器会话与用量",
  "translation-cache": "浏览器译文缓存",
  "assistant-data": "本地助手中的浏览器会话与用量",
} as const;
export type CleanupTarget = keyof typeof cleanupLabels;
export interface CleanupResult {
  target: CleanupTarget;
  ok: boolean;
  error?: string;
}
export async function runDataCleanup(
  steps: Partial<Record<CleanupTarget, () => Promise<void>>>,
  targets: unknown = Object.keys(steps),
): Promise<CleanupResult[]> {
  if (
    !Array.isArray(targets) ||
    !targets.length ||
    targets.some(
      (target) => typeof target !== "string" || !Object.hasOwn(steps, target),
    )
  )
    throw new Error("无效的清理项目");
  const results: CleanupResult[] = [];
  for (const target of new Set(targets as CleanupTarget[])) {
    try {
      await steps[target]!();
      results.push({ target, ok: true });
    } catch (error) {
      results.push({
        target,
        ok: false,
        error: error instanceof Error ? error.message : "清理未完成，请重试",
      });
    }
  }
  return results;
}
