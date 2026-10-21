import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// A separate keychain contains only generated fixture material. Never change
// the user's default keychain; the wrapping key is always randomly generated.
export async function testKeychain(trustedExecutables?: string[]) {
  if (process.platform !== "darwin") return undefined;
  const directory = await mkdtemp(join(tmpdir(), "lingo-sofa-test-keychain-"));
  const path = join(directory, "fixtures.keychain-db");
  const password = randomBytes(24).toString("hex");
  async function security(args: string[]) {
    const child = Bun.spawn(["/usr/bin/security", ...args], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    if (await child.exited)
      throw new Error(`Test keychain setup failed: ${stderr}`);
  }
  try {
    await security(["create-keychain", "-p", password, path]);
    await security(["unlock-keychain", "-p", password, path]);
    await security([
      "add-generic-password",
      ...(trustedExecutables
        ? trustedExecutables.flatMap((path) => ["-T", path])
        : ["-A"]),
      "-a",
      "vault-key-v1",
      "-s",
      "com.lingosofa.desktop.credentials",
      "-w",
      randomBytes(16).toString("hex"),
      path,
    ]);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    path,
    async dispose() {
      try {
        await security(["delete-keychain", path]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
