import { browser } from "wxt/browser";
import {
  settingsSchema,
  usageRecordSchema,
  type Settings,
  type UsageRecord,
} from "@lingo-sofa/protocol";
export async function readSettings(): Promise<Settings> {
  const data = await browser.storage.local.get("settings");
  return settingsSchema.parse(data.settings ?? { mode: "direct" });
}
export function mergeSettingsPatch(
  settings: Settings,
  patch: unknown,
): Settings {
  const parsed = settingsSchema.partial().parse(patch);
  // Optional schema defaults still materialize; only explicitly submitted keys may change.
  const supplied = Object.fromEntries(
    Object.entries(parsed).filter(([key]) =>
      Object.hasOwn(patch as object, key),
    ),
  );
  return settingsSchema.parse({ ...settings, ...supplied });
}
export async function records(settings: Settings): Promise<UsageRecord[]> {
  const data = await (
    settings.persistUsage ? browser.storage.local : browser.storage.session
  ).get("usage");
  return usageRecordSchema.array().parse(data.usage ?? []);
}
