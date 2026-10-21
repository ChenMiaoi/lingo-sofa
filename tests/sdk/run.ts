import { runtime } from "../../scripts/platform";
import {
  mkdir,
  mkdtemp,
  readFile,
  copyFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";

const repository = resolve(import.meta.dir, "../..");
const output = join(repository, ".cache/sdk-tests");
await mkdir(output, { recursive: true });
const live = process.argv.includes("--live");
const packaged = process.argv.includes("--packaged");
const liveKey = live ? process.env.API_KEY : undefined;
if (live && !liveKey)
  throw new Error("Set API_KEY via the local .env before opting into --live");
const env: Record<string, string> = {};
for (const key of [
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "SystemDrive",
  "COMSPEC",
  "TEMP",
  "TMP",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
]) {
  if (process.env[key]) env[key] = process.env[key]!;
}
env.PATH =
  process.platform === "win32"
    ? `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`
    : "/usr/bin:/bin:/usr/sbin:/sbin";
if (liveKey) env.W0_LIVE_KEY = liveKey;
let command: string[];
let directory = repository;
let packaging: unknown;
if (packaged) {
  const executable = join(output, `omp-probe${runtime.executableSuffix}`);
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      "--no-env-file",
      "--compile",
      `--target=${runtime.target}`,
      "--external",
      "omp-legacy-pi-modules",
      "--outfile",
      executable,
      join(import.meta.dir, "probe.ts"),
    ],
    { cwd: repository, env, stdout: "pipe", stderr: "pipe" },
  );
  const [buildOut, buildErr, buildCode] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ]);
  if (buildCode !== 0)
    throw new Error(`Bun compile failed: ${buildOut}\n${buildErr}`);
  directory = await mkdtemp(join(tmpdir(), "lingo-sofa-omp-detached-"));
  const native = Bun.resolveSync(
    runtime.nativePackage,
    join(repository, "apps/omp-worker/src/worker.ts"),
  );
  command = [join(directory, `omp-probe${runtime.executableSuffix}`)];
  await Promise.all([
    copyFile(executable, command[0]!),
    copyFile(native, join(directory, basename(native))),
  ]);
  const nativeBytes = await readFile(native);
  const exeBytes = await readFile(executable);
  packaging = {
    standaloneDirectory: true,
    pathContainsBun: false,
    executableBytes: (await stat(executable)).size,
    nativeBytes: nativeBytes.length,
    executableSha256: createHash("sha256").update(exeBytes).digest("hex"),
    nativeSha256: createHash("sha256").update(nativeBytes).digest("hex"),
    layout: [`omp-probe${runtime.executableSuffix}`, basename(native)],
    legacyExtensionModule:
      "external; disabled legacy-extension path is outside W0 scope",
  };
} else {
  command = [
    process.execPath,
    "run",
    "--no-env-file",
    join(import.meta.dir, "probe.ts"),
  ];
}
const start = performance.now();
const child = Bun.spawn(command, {
  cwd: directory,
  env,
  stdout: "pipe",
  stderr: "pipe",
});
const timer = setTimeout(() => child.kill(), live ? 180000 : 60000);
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);
clearTimeout(timer);
const redact = (text: string) =>
  liveKey ? text.replaceAll(liveKey, "[redacted]") : text;
if (!stdout.trim())
  throw new Error(
    `Probe produced no report (exit ${exitCode}): ${redact(stderr).slice(0, 1800)}`,
  );
const report = JSON.parse(redact(stdout));
report.execution = {
  compiled: packaged,
  live,
  exitCode,
  elapsedMs: Math.round(performance.now() - start),
  packaging,
};
const reportPath = join(
  output,
  `${packaged ? "packaged" : "source"}-${live ? "live" : "offline"}.json`,
);
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
process.stderr.write(redact(stderr));
process.stdout.write(
  JSON.stringify(
    {
      passed: report.passed,
      report: reportPath,
      checks: report.results.map(
        (result: { name: string; passed: boolean }) => ({
          name: result.name,
          passed: result.passed,
        }),
      ),
      execution: report.execution,
    },
    null,
    2,
  ) + "\n",
);
process.exit(exitCode ?? 1);
