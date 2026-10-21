import { testKeychain } from "./test-keychain";
import { runtime } from "../../scripts/platform";
import { resolve, join } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { compile, root, cleanEnv, run } from "../../scripts/process";
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
    const program = join(output, `${name}${runtime.executableSuffix}`);
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
const cargoTest = [
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
  ...(process.platform === "darwin"
    ? ["--features", "lingo-sofa-omp-client/test-keychain"]
    : []),
];
// A cold dependency build must not consume the test execution deadline.
await run([...cargoTest, "--no-run"]);
const keychain = await testKeychain();
if (keychain) env.LINGOSOFA_TEST_KEYCHAIN = keychain.path;
const child = Bun.spawn([...cargoTest, "--", "--test-threads=1"], {
  cwd: root,
  env,
  stdout: "pipe",
  stderr: "pipe",
});
const timer = setTimeout(() => {
  process.stderr.write("Runtime test execution exceeded 360 seconds.\n");
  child.kill();
}, 360000);
const [stdout, stderr, code] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);
clearTimeout(timer);
await keychain?.dispose();
const tests = [...stdout.matchAll(/^test ([\w:]+) \.\.\. (ok|FAILED)$/gm)].map(
  (m) => ({ name: m[1], passed: m[2] === "ok" }),
);
const requiredTests = [
  "operating_system_reaps_worker_and_descendant_when_rust_host_is_killed",
  "actual_host_crash_recovers_pending_and_preserves_committed_terminal",
];
const passed =
  code === 0 &&
  tests.length > 0 &&
  tests.every((t) => t.passed) &&
  requiredTests.every((name) =>
    tests.some((test) => test.name === name && test.passed),
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
      tests,
      hashes,
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(stdout);
process.stderr.write(stderr);
if (!passed)
  process.stderr.write(
    "Runtime validation failed or required host tests did not run.\n",
  );
process.exit(passed ? 0 : code || 1);
