import { it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import {
  collectAssistantRelease,
  releasePlatforms,
  validateReleaseVersion,
  validateReleaseSourceFiles,
  versionFromTag,
  writeReleaseChecksums,
} from "../scripts/release-utils.js";

it.each([
  "0.1.0",
  "v0.1",
  "v01.1.0",
  "v1.2.3-rc.1",
  "v1.2.3+build",
  "v1.2.3\n",
  "v1.2.3;echo unsafe",
])("rejects unsupported release tag %j", (tag) => {
  expect(() => versionFromTag(tag)).toThrow("Release tag");
});
it.each([
  ".env",
  "nested/.env.production",
  "accounts.json",
  "provider.json",
  "runtime-connection.json",
  "runtime-install.json",
  "nested/.provider-temp.json",
])("rejects local secrets and machine state in source archives: %s", (path) => {
  expect(() =>
    validateReleaseSourceFiles([
      ".env.example",
      "apps/pi-bridge/src/accounts.ts",
      path,
    ]),
  ).toThrow("cannot enter a source release");
});
it("allows source files and the public environment example", () => {
  expect(() =>
    validateReleaseSourceFiles([
      ".env.example",
      "apps/pi-bridge/src/config.ts",
      "package-lock.json",
    ]),
  ).not.toThrow();
});
it("checks every application and shared package against the tag, excluding the private workspace-root version", async () => {
  const root = await mkdtemp(join(tmpdir(), "lingo-release-version-"));
  try {
    for (const group of ["apps", "packages"]) {
      await mkdir(join(root, group, "example"), { recursive: true });
      await writeFile(
        join(root, group, "example/package.json"),
        '{"version":"0.1.0"}',
      );
    }
    await writeFile(
      join(root, "package.json"),
      '{"version":"0.0.0","private":true}',
    );
    expect(await validateReleaseVersion(root, "v0.1.0")).toBe("0.1.0");
    await writeFile(
      join(root, "packages/example/package.json"),
      '{"version":"0.2.0"}',
    );
    await expect(validateReleaseVersion(root, "v0.1.0")).rejects.toThrow(
      "packages/example/package.json version 0.2.0",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
async function nativeFixtures(input: string) {
  for (const target of releasePlatforms) {
    const directory = `lingo-sofa-assistant-0.1.0-${target}`;
    const data = Buffer.from(`fixture:${target}`);
    const sha256 = createHash("sha256").update(data).digest("hex");
    await writeFile(join(input, `${directory}.tar.gz`), data);
    await writeFile(
      join(input, `${directory}.json`),
      JSON.stringify({
        version: "0.1.0",
        assets: {
          [target]: {
            directory,
            url: `https://github.com/ChenMiaoi/lingo-sofa/releases/download/v0.1.0/${directory}.tar.gz`,
            sha256,
          },
        },
      }),
    );
  }
}
it.each([
  "valid",
  "missing",
  "tampered",
  "version",
  "url",
  "unexpected",
] as const)(
  "collects all platform archives before enabling automatic installation: %s",
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), "lingo-release-collect-"));
    const input = join(root, "native");
    const output = join(root, "assets");
    await mkdir(input);
    try {
      await nativeFixtures(input);
      const archive = join(
        input,
        "lingo-sofa-assistant-0.1.0-linux-x64.tar.gz",
      );
      const manifest = join(input, "lingo-sofa-assistant-0.1.0-linux-x64.json");
      if (scenario === "missing") await rm(archive);
      if (scenario === "tampered")
        await writeFile(archive, "altered after the native smoke test");
      if (scenario === "unexpected")
        await writeFile(join(input, ".env"), "fixture-only");
      if (scenario === "version" || scenario === "url") {
        const value = JSON.parse(await readFile(manifest, "utf8"));
        if (scenario === "version") value.version = "9.0.0";
        else
          value.assets["linux-x64"].url = "https://untrusted.example/download";
        await writeFile(manifest, JSON.stringify(value));
      }
      if (scenario !== "valid") {
        await expect(
          collectAssistantRelease(input, output, "0.1.0"),
        ).rejects.toThrow();
        await expect(
          readFile(join(output, "assistant-release.json")),
        ).rejects.toThrow();
        return;
      }
      const release = await collectAssistantRelease(input, output, "0.1.0");
      expect(Object.keys(release.assets)).toEqual([...releasePlatforms]);
      await writeReleaseChecksums(output);
      const sums = (await readFile(join(output, "SHA256SUMS"), "utf8"))
        .trim()
        .split("\n");
      expect(sums).toHaveLength(releasePlatforms.length + 1);
      for (const line of sums) {
        const [hash, path] = line.split("  ");
        expect(
          createHash("sha256")
            .update(await readFile(join(output, path!)))
            .digest("hex"),
        ).toBe(hash);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
it("keeps the workflow matrix, version checks and publication dependency chain consistent", async () => {
  const workflow = parse(
    await readFile(".github/workflows/release.yml", "utf8"),
  );
  expect(workflow.on.push.tags).toEqual(["v[0-9]*"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  const jobs = workflow.jobs;
  expect(jobs.assistant.needs).toBe("validate");
  expect(
    jobs.assistant.strategy.matrix.include
      .map((entry: { target: string }) => entry.target)
      .sort(),
  ).toEqual([...releasePlatforms]);
  const nativeCommands = jobs.assistant.steps.map(
    (step: { run?: string }) => step.run ?? "",
  );
  expect(
    nativeCommands.indexOf(
      "npm run package:native --workspace @lingo-sofa/pi-bridge",
    ),
  ).toBeLessThan(
    nativeCommands.indexOf(
      "npm test -- tests/bridge.test.ts tests/assistant-installer.test.ts",
    ),
  );
  expect(jobs.assemble.needs).toEqual(["validate", "assistant"]);
  expect(jobs.windows.needs).toBe("assemble");
  expect(jobs.windows["runs-on"]).toBe("windows-2022");
  expect(
    jobs.windows.steps.some((step: { run?: string }) =>
      step.run?.includes("npm run package:windows"),
    ),
  ).toBe(true);
  expect(jobs.publish.needs).toEqual(["validate", "assemble", "windows"]);
  expect(jobs.publish.permissions).toEqual({ contents: "write" });
  const publish = jobs.publish.steps.at(-1).run as string;
  expect(publish).toContain("--verify-tag");
  expect(publish).not.toContain("--clobber");
  const ci = parse(await readFile(".github/workflows/ci.yml", "utf8"));
  expect(ci.on.push.branches).toEqual(["**"]);
});

it("profiles Windows on demand with read-only permissions and full installer verification", async () => {
  const workflow = parse(
    await readFile(".github/workflows/windows-profile.yml", "utf8"),
  );
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.jobs.windows["runs-on"]).toBe("windows-2022");
  const commands = workflow.jobs.windows.steps
    .map((step: { run?: string }) => step.run ?? "")
    .join("\n");
  expect(commands).toContain("npm run verify:assistant");
  expect(commands).toContain("npm run package:windows");
  expect(commands).toContain("git archive");
  expect(commands).not.toMatch(/gh release|git push|release:assemble/);
});
