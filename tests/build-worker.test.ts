import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  compile,
  root,
  cleanEnv,
  desktopToolCommand,
} from "../scripts/process";
import { runtime } from "../scripts/platform";
import { prepareWorkerFixture } from "./sdk/worker-fixture";

test("JavaScript runtime fixtures load native addons and emitted assets without cwd dotenv", async () => {
  const cache = join(root, ".cache");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "source fixture 测试-"));
  try {
    const sdk = Bun.resolveSync("@oh-my-pi/pi-coding-agent", root);
    const native = Bun.resolveSync("@oh-my-pi/pi-natives", sdk).replaceAll(
      "\\",
      "/",
    );
    const source = join(directory, "probe.ts");
    await writeFile(join(directory, "probe.txt"), "synthetic emitted asset");
    await writeFile(
      source,
      `
      import * as native from ${JSON.stringify(native)};
      import asset from "./probe.txt" with { type: "file" };
      console.log(JSON.stringify({ native: typeof native.matchesKey,
        asset: await Bun.file(new URL(asset, import.meta.url)).text(),
        configuration: process.env.LINGOSOFA_RUNTIME_CONFIG_PROBE ?? "isolated",
        mode: process.env.NODE_ENV }));
    `,
    );
    const prepared = await prepareWorkerFixture(
      source,
      join(directory, "new", "nested", "probe"),
      false,
    );
    await writeFile(
      join(directory, ".env"),
      "LINGOSOFA_RUNTIME_CONFIG_PROBE=dotenv-loaded\n",
    );
    const env = cleanEnv();
    delete env.LINGOSOFA_RUNTIME_CONFIG_PROBE;
    const child = Bun.spawn([prepared.program, ...prepared.args], {
      cwd: directory,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr, output: JSON.parse(stdout) }).toEqual({
      code: 0,
      stderr: "",
      output: {
        native: "function",
        asset: "synthetic emitted asset",
        configuration: "isolated",
        mode: "production",
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("standalone runtimes build with native paths and ignore working-directory configuration", async () => {
  const cache = join(root, ".cache");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "standalone runtime 测试-"));
  try {
    const program = join(directory, `probe${runtime.executableSuffix}`);
    const source = join(directory, "entry.ts");
    await copyFile(join(root, "tests/fixtures/standalone-runtime.ts"), source);
    await compile(source, program);
    await Promise.all([
      writeFile(
        join(directory, ".env"),
        "LINGOSOFA_RUNTIME_CONFIG_PROBE=dotenv-loaded\n",
      ),
      writeFile(join(directory, "bunfig.toml"), 'preload = ["./preload.ts"]\n'),
      writeFile(
        join(directory, "preload.ts"),
        'process.env.LINGOSOFA_RUNTIME_CONFIG_PROBE = "preload-loaded";\n',
      ),
    ]);
    const env = cleanEnv();
    delete env.LINGOSOFA_RUNTIME_CONFIG_PROBE;
    const child = Bun.spawn([program], {
      cwd: directory,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr, output: JSON.parse(stdout) }).toEqual({
      code: 0,
      stderr: "",
      output: { configuration: "isolated", mode: "production" },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test.each(["vite", "tauri"] as const)(
  "the installed %s CLI runs from a Unicode path without a package runner",
  async (tool) => {
    const cache = join(root, ".cache");
    await mkdir(cache, { recursive: true });
    const directory = await mkdtemp(join(cache, "desktop tool 中文 spaces-"));
    try {
      const child = Bun.spawn([...desktopToolCommand(tool), "--version"], {
        cwd: directory,
        env: cleanEnv(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout.toLowerCase()).toContain(tool);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
