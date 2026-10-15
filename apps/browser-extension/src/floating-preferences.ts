export interface FloatingPreferences {
  side: "left" | "right";
  y: number;
  autoHide: boolean;
}

export function readFloatingPreferences(value: unknown): FloatingPreferences {
  const stored =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    side: stored.side === "left" ? "left" : "right",
    y:
      typeof stored.y === "number" &&
      Number.isFinite(stored.y) &&
      stored.y >= 0 &&
      stored.y <= 1
        ? stored.y
        : 0.68,
    autoHide: typeof stored.autoHide === "boolean" ? stored.autoHide : true,
  };
}

export function parseFloatingPatch(
  value: unknown,
): Partial<FloatingPreferences> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("无效的悬浮入口偏好");
  const patch = value as Record<string, unknown>;
  if (
    Object.keys(patch).some(
      (key) => !["side", "y", "autoHide"].includes(key),
    ) ||
    ("side" in patch && patch.side !== "left" && patch.side !== "right") ||
    ("y" in patch &&
      (typeof patch.y !== "number" ||
        !Number.isFinite(patch.y) ||
        patch.y < 0 ||
        patch.y > 1)) ||
    ("autoHide" in patch && typeof patch.autoHide !== "boolean")
  )
    throw new Error("无效的悬浮入口偏好");
  return patch as Partial<FloatingPreferences>;
}
