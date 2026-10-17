import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { modelUpdateSchema } from "@lingo-sofa/protocol";

// Credentials belong to the Bridge, never Vencord's persisted settings.
export async function readProviderSettings(directory: string) {
  try {
    return modelUpdateSchema.parse(
      JSON.parse(await readFile(join(directory, "provider.json"), "utf8")),
    );
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (reason instanceof SyntaxError) {
      // JSON parser errors can quote fragments containing a credential.
      reason.message = "Malformed provider JSON";
      reason.stack = "SyntaxError: Malformed provider JSON";
    }
    throw new Error("Cannot read saved provider configuration", {
      cause: reason,
    });
  }
}
export async function saveProviderSettings(
  directory: string,
  value: import("zod").infer<typeof modelUpdateSchema>,
) {
  const temporary = join(directory, `.provider-${randomUUID()}.json`);
  try {
    await writeFile(temporary, JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, join(directory, "provider.json"));
  } finally {
    await rm(temporary, { force: true });
  }
}
