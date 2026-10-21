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
