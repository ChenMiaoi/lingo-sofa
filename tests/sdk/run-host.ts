import { resolve, join } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { compile, root, cleanEnv } from "../../scripts/process";
const packaged = process.argv.includes("--packaged");
const output = resolve(root, ".cache/runtime-tests");
await mkdir(output, { recursive: true });
const env = cleanEnv();
for (const [name, variable] of [
  ["worker", "WORKER"],
  ["fault-worker", "FAULT"],
] as const) {
  const source = resolve(root, `tests/fixtures/${name}.ts`);
  if (packaged) {
    const program = join(output, `${name}.exe`);
    await compile(source, program);
    env[`W0_${variable}_PROGRAM`] = program;
    env[`W0_${variable}_ARGS`] = "[]";
  } else {
    env[`W0_${variable}_PROGRAM`] = process.execPath;
    env[`W0_${variable}_ARGS`] = JSON.stringify([
      "run",
      "--no-env-file",
      source,
    ]);
  }
}
const child = Bun.spawn(
  [
    "cargo",
    "test",
    "--locked",
    "-p",
    "lingo-sofa-core",
    "-p",
    "lingo-sofa-selection-helper",
    "-p",
    "lingo-sofa-omp-client",
    "-p",
    "lingo-sofa-app-services",
    "-p",
    "lingo-sofa-runtime-tests",
    "--",
    "--test-threads=1",
  ],
  { cwd: root, env, stdout: "pipe", stderr: "pipe" },
);
const timer = setTimeout(() => child.kill(), 360000);
const [stdout, stderr, code] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);
clearTimeout(timer);
const tests = [...stdout.matchAll(/^test ([\w:]+) \.\.\. (ok|FAILED)$/gm)].map(
  (m) => ({ name: m[1], passed: m[2] === "ok" }),
);
const files = [
  "Cargo.toml",
  "Cargo.lock",
  "apps/omp-worker/src/runtime.ts",
  "apps/omp-worker/src/worker.ts",
  "apps/omp-worker/src/ipc.ts",
  "crates/core/src/scheduler.rs",
  "crates/omp-client/src/client.rs",
  "crates/app-services/src/lib.rs",
  "crates/selection-helper/src/main.rs",
  "apps/desktop/src-tauri/src/shell.rs",
];
const hashes = Object.fromEntries(
  await Promise.all(
    files.map(async (file) => [
      file,
      createHash("sha256")
        .update(await readFile(resolve(root, file)))
        .digest("hex"),
    ]),
  ),
);
await writeFile(
  join(output, `${packaged ? "packaged" : "source"}.json`),
  JSON.stringify(
    {
      passed: code === 0 && tests.length > 0 && tests.every((t) => t.passed),
      packaged,
      tests,
      hashes,
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exit(code ?? 1);
