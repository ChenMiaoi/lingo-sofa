import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type ModelConfig,
  type StoredAccount,
  type ProviderUpdate,
} from "@lingo-sofa/protocol";

import {
  accountStateSchema as schema,
  planAccountUpdate,
  accountKey,
  type AccountState as State,
} from "@lingo-sofa/provider-pi/accounts";

/** One atomic file owns account credentials and both independent defaults. */
export class ProviderAccounts {
  private state!: State;
  readonly ready: Promise<void>;
  constructor(
    private directory: string,
    model: ModelConfig,
    apiKey: string,
  ) {
    this.ready = this.load(model, apiKey);
  }
  private async load(model: ModelConfig, apiKey: string) {
    try {
      this.state = schema.parse(
        JSON.parse(
          await readFile(join(this.directory, "accounts.json"), "utf8"),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof SyntaxError) {
          error.message = "Malformed supplier accounts JSON";
          error.stack = "SyntaxError: Malformed supplier accounts JSON";
        }
        throw new Error("Cannot read saved supplier accounts", {
          cause: error,
        });
      }
      // Migrate the previous single credential without returning it to a client.
      const accounts: StoredAccount[] = apiKey
        ? [
            {
              id: model.accountId ?? randomUUID(),
              name: model.provider,
              model,
              apiKey,
            },
          ]
        : [];
      this.state = { accounts, translation: model, ask: model };
      await this.commit(this.state);
    }
  }
  get translation() {
    return this.state.translation;
  }
  get ask() {
    return this.state.ask;
  }
  list() {
    return this.state.accounts.map(({ id, name, model, apiKey }) => ({
      keyConfigured: Boolean(apiKey) || model.authMode === "subscription",
      id,
      name,
      model,
    }));
  }
  key(model: ModelConfig) {
    return accountKey(this.state, model);
  }
  plan(update: ProviderUpdate) {
    return planAccountUpdate(this.state, update, randomUUID);
  }
  keyFrom(state: State, model: ModelConfig) {
    return accountKey(state, model);
  }
  async commit(state: State) {
    const temporary = join(this.directory, `.accounts-${randomUUID()}.json`);
    try {
      await writeFile(temporary, JSON.stringify(schema.parse(state)), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, join(this.directory, "accounts.json"));
      this.state = state;
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
