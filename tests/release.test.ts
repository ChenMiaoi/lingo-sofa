import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

it.each([
  "valid",
  "tampered",
  "unlisted",
  "credential",
  "version",
  "traversal",
] as const)("release integrity verification: %s", async (scenario) => {
  const directory = await mkdtemp(join(tmpdir(), "lingo-release-integrity-"));
  const files: Record<string, string> = {
    "release-review.json": JSON.stringify({
      publicReleaseReady: false,
      version: "0.1.0",
      packages: [{ documents: ["licenses/test/LICENSE"] }],
      licenseIssues: [],
    }),
    "browser/manifest.json": JSON.stringify({
      version: "0.1.0",
      manifest_version: 3,
    }),
    "licenses/test/LICENSE": "Fixture license text",
    "licenses/Node.js/LICENSE": "Fixture runtime license",
    "licenses/Vencord-GPL-3.0-or-later.txt": "Fixture host license",
    "source.tar": "Fixture artifact bytes",
    LICENSE: "Fixture project license",
    "THIRD_PARTY_NOTICES.md": "Fixture notices",
  };
  try {
    if (scenario === "credential") files[".env"] = "API_KEY=fixture-only";
    if (scenario === "version")
      files["browser/manifest.json"] = JSON.stringify({
        version: "9.0.0",
        manifest_version: 3,
      });
    const sums: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      await mkdir(dirname(join(directory, name)), { recursive: true });
      await writeFile(join(directory, name), content);
      sums.push(
        `${createHash("sha256").update(content).digest("hex")}  ${name}`,
      );
    }
    if (scenario === "traversal") sums.push(`${"0".repeat(64)}  ../outside`);
    await writeFile(join(directory, "SHA256SUMS"), sums.join("\n") + "\n");
    if (scenario === "tampered")
      await writeFile(join(directory, "LICENSE"), "Changed after review");
    if (scenario === "unlisted")
      await writeFile(join(directory, "extra.txt"), "Not reviewed");
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/verify-release.mjs"), directory],
      { encoding: "utf8" },
    );
    if (scenario === "valid") {
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Verified 8 checksums");
    } else {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        {
          tampered: "Checksum mismatch",
          unlisted: "Unlisted file",
          credential: "Credential file",
          version: "Invalid review status",
          traversal: "Invalid or duplicate checksum path",
        }[scenario],
      );
    }
    expect(
      await readFile(join(directory, "licenses/test/LICENSE"), "utf8"),
    ).toBe("Fixture license text");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
