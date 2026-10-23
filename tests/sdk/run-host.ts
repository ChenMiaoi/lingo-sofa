import {
  parseRuntimeReport,
  runtimePassed,
  runtimeThreads,
  type RuntimeTest,
} from "../../scripts/runtime-report";
import { testKeychain } from "./test-keychain";
import { resolve, join } from "node:path";
import { mkdir, writeFile, readFile, copyFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { root, cleanEnv, run } from "../../scripts/process";
import { prepareWorkerFixture } from "./worker-fixture";
import { collectRuntimeOutput } from "../../scripts/runtime-output";
const started = performance.now();
const threads = runtimeThreads(process.env.LINGOSOFA_TEST_THREADS);
const packaged = process.argv.includes("--packaged");
const profile = packaged ? "packaged" : "source";
const output = resolve(root, ".cache/runtime-tests");
await mkdir(output, { recursive: true });
await rm(join(output, `${profile}.json`), { force: true });
const env = cleanEnv();
for (const [name, variable] of [
  ["worker", "WORKER"],
  ["fault-worker", "FAULT"],
] as const) {
  const source = resolve(root, `tests/fixtures/${name}.ts`);
  const prepared = await prepareWorkerFixture(
    source,
    join(output, name),
    packaged,
  );
  env[`W0_${variable}_PROGRAM`] = prepared.program;
  env[`W0_${variable}_ARGS`] = JSON.stringify(prepared.args);
}
const workerPrepared = performance.now();
const cargoPackages = [
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
  ...(process.platform === "darwin"
    ? ["--features", "lingo-sofa-omp-client/test-keychain"]
    : []),
];
// A cold dependency build must not consume the test execution deadline.
await run([
  "cargo",
  "nextest",
  "run",
  ...cargoPackages,
  "--profile",
  profile,
  "--no-run",
  "--timings",
]);
const compiled = performance.now();
await copyFile(
  resolve(root, "target/cargo-timings/cargo-timing.html"),
  join(output, `${profile}-build.html`),
);
const junit = resolve(root, `target/nextest/${profile}/junit.xml`);
await rm(junit, { force: true });
const keychain = await testKeychain();
if (keychain) env.LINGOSOFA_TEST_KEYCHAIN = keychain.path;
const executionStarted = performance.now();
const child = Bun.spawn(
  [
    "cargo",
    "nextest",
    "run",
    ...cargoPackages,
    "--profile",
    profile,
    "--test-threads",
    String(threads),
    "--color",
    "never",
  ],
  {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  },
);
const timer = setTimeout(() => {
  process.stderr.write("Runtime test execution exceeded 360 seconds.\n");
  child.kill();
}, 360000);
let code: number | null;
try {
  code = await collectRuntimeOutput(
    child,
    process.stdout,
    process.stderr,
    join(output, `${profile}.stdout.log`),
    join(output, `${profile}.stderr.log`),
  );
} finally {
  clearTimeout(timer);
  await keychain?.dispose();
}
const executed = performance.now();
let tests: RuntimeTest[] = [];
try {
  tests = parseRuntimeReport(await readFile(junit, "utf8"));
  await copyFile(junit, join(output, `${profile}.junit.xml`));
} catch {
  process.stderr.write("Runtime JUnit report is missing or invalid.\n");
}
// Nextest does not run rustdoc tests; retain Cargo's documentation-test coverage.
await run(["cargo", "test", ...cargoPackages, "--doc"]);
const passed = runtimePassed(tests, code);
const timings = {
  workerPreparationMs: Math.round(workerPrepared - started),
  compilationMs: Math.round(compiled - workerPrepared),
  executionMs: Math.round(executed - executionStarted),
  documentationMs: Math.round(performance.now() - executed),
  totalMs: Math.round(performance.now() - started),
};
process.stdout.write(
  JSON.stringify(
    {
      profile,
      threads,
      passed,
      timings,
      slowestTests: [...tests]
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 10),
    },
    null,
    2,
  ) + "\n",
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
      passed,
      platform: process.platform,
      arch: process.arch,
      packaged,
      threads,
      timings,
      tests,
      hashes,
    },
    null,
    2,
  ) + "\n",
);
if (!passed)
  process.stderr.write(
    "Runtime validation failed or required host tests did not run.\n",
  );
process.exit(passed ? 0 : code || 1);
