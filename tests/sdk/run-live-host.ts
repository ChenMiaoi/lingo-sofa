import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { compile } from "../../scripts/process";

if (!process.argv.includes("--live"))
  throw new Error("Explicit --live opt-in required");
const dual = process.argv.includes("--dual");
const key = process.env.API_KEY;
if (!key) throw new Error("Load API_KEY from the local .env");
const repository = resolve(import.meta.dir, "../..");
const output = join(repository, ".cache/runtime-tests");
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) =>
      value !== undefined &&
      !/key|token|secret|password|credential/i.test(name),
  ),
) as Record<string, string>;
const redact = (text: string) => text.replaceAll(key, "[redacted]");
async function prepare(command: string[]) {
  const child = Bun.spawn(command, {
    cwd: repository,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(redact(`Preparation failed: ${stdout}\n${stderr}`));
}
// Compile and run offline regressions first. These children never receive the key.
await prepare([
  process.execPath,
  "run",
  "--no-env-file",
  join(import.meta.dir, "run-host.ts"),
  "--packaged",
]);
await prepare([
  "cargo",
  "build",
  "--locked",
  "-p",
  "lingo-sofa-runtime-tests",
  "--bin",
  "w0-live",
]);
await mkdir(output, { recursive: true });
await compile(
  join(repository, "apps/omp-worker/src/worker.ts"),
  join(output, "live-worker.exe"),
);
env.W0_WORKER_PROGRAM = join(output, "live-worker.exe");
env.W0_WORKER_ARGS = "[]";
const executable = join(repository, "target/debug/w0-live.exe");
const child = Bun.spawn([executable, ...(dual ? ["--dual"] : [])], {
  cwd: repository,
  env,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
child.stdin.write(key);
child.stdin.end();
const timer = setTimeout(() => child.kill(), 180000);
const [stdout, stderr, code] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);
clearTimeout(timer);
const report = JSON.parse(redact(stdout));
report.recordedAt = new Date().toISOString();
report.execution = {
  scenario: dual ? "dual-saturation" : "queued",
  compiledWorker: true,
  rustHost: true,
  exitCode: code,
  sdk: "18.12.3",
  bun: Bun.version,
};
const inputs = [
  "Cargo.lock",
  "bun.lock",
  "apps/omp-worker/src/worker.ts",
  "apps/omp-worker/src/runtime.ts",
  "crates/omp-client/src/client.rs",
  "tests/runtime/src/validation.rs",
];
report.hashes = {};
for (const file of inputs)
  report.hashes[file] = createHash("sha256")
    .update(await readFile(join(repository, file)))
    .digest("hex");
report.hashes["worker.exe"] = createHash("sha256")
  .update(await readFile(env.W0_WORKER_PROGRAM))
  .digest("hex");
report.hashes["w0-live.exe"] = createHash("sha256")
  .update(await readFile(executable))
  .digest("hex");
await writeFile(
  join(output, dual ? "deepseek-dual-live.json" : "deepseek-live.json"),
  JSON.stringify(report, null, 2) + "\n",
);
if (stderr.trim())
  process.stderr.write(
    "Rust host emitted diagnostics (raw content suppressed).\n",
  );
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exit(code ?? 1);
