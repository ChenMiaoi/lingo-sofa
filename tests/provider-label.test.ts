import { expect, it } from "vitest";
import { accountStateSchema, modelConfigSchema } from "@lingo-sofa/protocol";
import { planAccountUpdate } from "../packages/provider-pi/src/accounts.js";
import { providerConnectionLabel } from "../packages/ui-shared/src/provider-label.js";
it("keeps named and unnamed same-endpoint accounts identifiable after a key update", () => {
  const model = modelConfigSchema.parse({
    provider: "deepseek",
    model: "fixture",
    endpoint: "https://api.deepseek.com",
  });
  const accounts = ["Work", "Personal", "deepseek", "deepseek"].map(
    (name, index) => {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      return {
        id,
        name,
        model: { ...model, accountId: id },
        apiKey: "synthetic-key",
      };
    },
  );
  const state = accountStateSchema.parse({
    accounts,
    translation: accounts[0]!.model,
    ask: accounts[1]!.model,
  });
  const providers = [{ id: "deepseek", name: "DeepSeek", models: [] }];
  const labels = (items: typeof accounts) =>
    items.map((item) =>
      providerConnectionLabel(item, { accounts: items, providers }),
    );
  const before = labels(accounts);
  expect(before.slice(0, 2)).toEqual(["Work", "Personal"]);
  expect(before[2]).not.toBe(before[3]);
  const next = planAccountUpdate(
    state,
    {
      target: "account",
      model: accounts[0]!.model,
      apiKey: "replacement-key",
      accountName: "Work",
    },
    () => {
      throw new Error("Unexpected new account");
    },
  );
  expect(next.accounts.map((item) => item.id)).toEqual(
    accounts.map((item) => item.id),
  );
  expect(labels(next.accounts as typeof accounts)).toEqual(before);
});
