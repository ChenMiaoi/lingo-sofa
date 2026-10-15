import { browser } from "wxt/browser";
import {
  settingsSchema,
  usageRecordSchema,
  type Settings,
  type UsageRecord,
} from "@lingo-sofa/protocol";
export async function readSettings(): Promise<Settings> {
  const data = await browser.storage.local.get("settings");
  return settingsSchema.parse(data.settings ?? {});
}
export async function records(settings: Settings): Promise<UsageRecord[]> {
  const data = await (
    settings.persistUsage ? browser.storage.local : browser.storage.session
  ).get("usage");
  return usageRecordSchema.array().parse(data.usage ?? []);
}
