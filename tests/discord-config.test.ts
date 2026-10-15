import { expect, it } from "vitest";
import { mkdtemp, mkdir, cp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";

it("loads the Discord source config in a clean checkout without a Vencord cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "lingo-config-"));
  const app = join(root, "apps/discord-vencord");
  try {
    await mkdir(join(app, "src"), { recursive: true });
    await cp(resolve("tsconfig.json"), join(root, "tsconfig.json"));
    await cp(
      resolve("apps/discord-vencord/tsconfig.json"),
      join(app, "tsconfig.json"),
    );
    await writeFile(
      join(app, "src/client.ts"),
      "export const ready: boolean = true;\n",
    );
    const config = ts.readConfigFile(
      join(app, "tsconfig.json"),
      ts.sys.readFile,
    );
    expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, app);
    expect(parsed.errors).toEqual([]);
    expect(parsed.fileNames).toContain(join(app, "src/client.ts"));
    expect(parsed.options.jsx).toBe(ts.JsxEmit.Preserve);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
