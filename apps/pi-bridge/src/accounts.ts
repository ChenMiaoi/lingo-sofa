import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type ModelConfig,
  type StoredAccount,
  type ProviderUpdate,
  resolveTranslationEngine,
  type TranslationEngine,
  type AccountImport,
} from "@lingo-sofa/protocol";

import {
  accountStateSchema as schema,
  planAccountUpdate,
  accountKey,
  planAccountImport,
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
    authenticated = false,
    engine?: TranslationEngine,
  ) {
    this.ready = this.load(model, apiKey, authenticated, engine);
  }
  private async load(
    model: ModelConfig,
    apiKey: string,
    authenticated: boolean,
    engine?: TranslationEngine,
  ) {
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
    if (!this.state.translationEngine) {
      this.state.translationEngine = resolveTranslationEngine(
        engine,
        Boolean(accountKey(this.state, this.state.translation)) ||
          this.state.translation.authMode === "subscription" ||
          authenticated,
      );
      await this.commit(this.state);
    }
  }
  get translation() {
    return this.state.translation;
  }
  get translationEngine() {
    return this.state.translationEngine;
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
  planImport(migration: AccountImport) {
    return planAccountImport(this.state, migration, randomUUID);
  }
  imported(migrationId: string) {
    return this.state.completedImports?.includes(migrationId) ?? false;
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
