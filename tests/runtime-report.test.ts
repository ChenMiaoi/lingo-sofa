import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import {
  collectRuntimeOutput,
  forwardRuntimeOutput,
} from "../scripts/runtime-output";
import {
  parseRuntimeReport,
  runtimePassed,
  runtimeThreads,
} from "../scripts/runtime-report";

const names = [
  "operating_system_reaps_worker_and_descendant_when_rust_host_is_killed",
  "actual_host_crash_recovers_pending_and_preserves_committed_terminal",
];
const report = (cases: string, count = 2) =>
  `<testsuites tests="${count}"><testsuite>${cases}</testsuite></testsuites>`;
const successful = names
  .map(
    (name) =>
      `<testcase classname="runtime::host" name="${name}" time="0.125"/>`,
  )
  .join("");

test("JUnit preserves identity and per-test durations and distinguishes failures", () => {
  const tests = parseRuntimeReport(report(successful));
  expect(tests.map((test) => test.name)).toEqual(names);
  expect(tests[0]?.durationMs).toBe(125);
  expect(runtimePassed(tests, 0)).toBe(true);
  expect(runtimePassed(tests, 1)).toBe(false);
  for (const result of ["failure", "error", "skipped"]) {
    const failed = parseRuntimeReport(
      report(
        `<testcase classname="a" name="x" time="1"><${result}/></testcase>`,
        1,
      ),
    );
    expect(failed[0]?.passed).toBe(false);
  }
});

test("missing critical tests, corrupt and incomplete reports fail closed", () => {
  expect(
    runtimePassed(
      parseRuntimeReport(report(successful).replace(names[0]!, "other")),
      0,
    ),
  ).toBe(false);
  for (const xml of [
    "",
    report("", 0),
    report(successful, 3),
    report(successful + successful, 4),
    report('<testcase classname="a" name="x"/>', 1),
    report('<testcase classname="a" name="x" time="NaN"/>', 1),
  ])
    expect(() => parseRuntimeReport(xml)).toThrow();
});

test("runtime concurrency is bounded and supports a serial baseline", () => {
  expect(runtimeThreads(undefined)).toBe(2);
  expect(runtimeThreads("1")).toBe(1);
  expect(runtimeThreads("2")).toBe(2);
  for (const value of ["0", "3", "-1", "NaN", ""])
    expect(() => runtimeThreads(value)).toThrow();
});

test("runtime output reaches the console and log before a failed child exits, preserving split UTF-8 bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lingo-runtime-output-"));
  const log = join(directory, "output.log");
  const destination = new PassThrough();
  const chunks: Buffer[] = [];
  let early!: () => void;
  const earlyOutput = new Promise<void>((resolve) => {
    early = resolve;
  });
  destination.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length >= Buffer.byteLength("首🛋️")) early();
  });
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const bytes = Buffer.from("首🛋️");
       process.stdout.write(bytes.subarray(0, 4));
       setTimeout(() => process.stdout.write(bytes.subarray(4)), 25);
       process.stdin.once("data", () => {
         process.stdout.write("末尾\\n");
         process.stdin.pause();
         process.exitCode = 7;
       });`,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  );
  const timeout = setTimeout(() => child.kill(), 30_000);
  const forwarded = forwardRuntimeOutput(child.stdout, destination, log);
  try {
    await Promise.race([
      earlyOutput,
      child.exited.then(() => {
        throw new Error("Child exited before its early output was observed");
      }),
    ]);
    expect(child.exitCode).toBeNull();
    expect(await readFile(log, "utf8")).toBe("首🛋️");
    child.stdin.write("finish\n");
    child.stdin.end();
    expect(await child.exited).toBe(7);
    await forwarded;
    expect(Buffer.concat(chunks).toString("utf8")).toBe("首🛋️末尾\n");
    expect(await readFile(log, "utf8")).toBe("首🛋️末尾\n");
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
    await forwarded;
    destination.destroy();
    await rm(directory, { recursive: true, force: true });
  }
}, 45_000);

test("runtime log and destination failures terminate and reap the child", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "lingo-runtime-output-error-"),
  );
  try {
    for (const fault of ["log", "destination"]) {
      const destination =
        fault === "destination"
          ? new Writable({
              write(_chunk, _encoding, callback) {
                callback(new Error("synthetic destination failure"));
              },
            })
          : new PassThrough();
      const stderr = new PassThrough();
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          'process.stdout.write("alive"); setInterval(() => {}, 1000);',
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const timeout = setTimeout(() => child.kill(), 30_000);
      try {
        await expect(
          collectRuntimeOutput(
            child,
            destination,
            stderr,
            fault === "log" ? directory : join(directory, "stdout.log"),
            join(directory, "stderr.log"),
          ),
        ).rejects.toThrow(
          fault === "destination" ? "synthetic destination failure" : undefined,
        );
        expect(child.killed).toBe(true);
        expect(() => process.kill(child.pid, 0)).toThrow();
      } finally {
        clearTimeout(timeout);
        child.kill();
        await child.exited;
        destination.destroy();
        stderr.destroy();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 45_000);

interface CheckJob {
  strategy: {
    "fail-fast": boolean;
    matrix: { include: { os: string; name: string }[] };
  };
  steps: {
    name?: string;
    if?: string;
    run?: string;
    uses?: string;
    with?: Record<string, unknown>;
  }[];
}

test("source and packaged CI jobs retain every platform and validation command", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(
      new URL("../.github/workflows/check.yml", import.meta.url),
    ).text(),
  ) as { jobs: Record<string, CheckJob> };
  const commands = {
    desktop: [
      "bun install --frozen-lockfile",
      "npm run lint",
      "npm run format:check",
      "npm run typecheck",
      "npm test",
      "cargo fmt --all --check",
      "npm run test:runtime",
      "npm run build:worker",
      "bun scripts/test-region-selector.ts",
      "cargo test --locked -p lingo-sofa-ocr-helper",
      "npm run build:web",
      "cargo test --locked -p lingo-sofa-desktop --timings",
      "cargo clippy --workspace --all-targets --timings -- -D warnings",
      "cargo build --locked -p lingo-sofa-desktop --timings",
      "npm run test:sdk",
      "npm run bundle -- --debug",
      "npm.cmd run bundle -- --debug --config '${{ github.workspace }}/.github/tauri-windows-ci.json'",
    ],
    packaged: [
      "bun install --frozen-lockfile",
      "npm run test:sdk -- --packaged",
      "npm run test:runtime:packaged",
    ],
  };
  for (const scope of ["desktop", "packaged"] as const) {
    const job = workflow.jobs[scope]!;
    expect(job.strategy["fail-fast"]).toBe(false);
    expect(job.strategy.matrix.include.map((entry) => entry.os).sort()).toEqual(
      ["macos-26", "macos-26-intel", "windows-2025"],
    );
    const actual = job.steps.flatMap((step) => (step.run ? [step.run] : []));
    for (const command of commands[scope]) expect(actual).toContain(command);
    for (const command of commands[
      scope === "desktop" ? "packaged" : "desktop"
    ])
      if (command !== "bun install --frozen-lockfile")
        expect(actual).not.toContain(command);
    expect(
      job.steps.find((step) => step.uses === "Swatinem/rust-cache@v2")?.with?.[
        "cache-bin"
      ],
    ).toBe(false);
  }
});

test("only Windows check bundles use ZLIB and packaged jobs never save the shared Bun cache", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(
      new URL("../.github/workflows/check.yml", import.meta.url),
    ).text(),
  ) as { jobs: Record<string, CheckJob> };
  const steps = workflow.jobs.desktop!.steps;
  expect(
    steps.find((step) => step.run === "npm run bundle -- --debug")?.if,
  ).toBe("runner.os != 'Windows'");
  expect(
    steps.find((step) => step.name === "Build Windows debug installer"),
  ).toMatchObject({
    if: "runner.os == 'Windows'",
    run: "npm.cmd run bundle -- --debug --config '${{ github.workspace }}/.github/tauri-windows-ci.json'",
  });
  expect(
    await Bun.file(
      new URL("../.github/tauri-windows-ci.json", import.meta.url),
    ).json(),
  ).toEqual({
    $schema: "https://schema.tauri.app/config/2",
    bundle: { windows: { nsis: { compression: "zlib" } } },
  });
  const release = await Bun.file(
    new URL("../.github/workflows/release.yml", import.meta.url),
  ).text();
  expect(release).not.toContain("tauri-windows-ci.json");
  const releaseWorkflow = Bun.YAML.parse(release) as {
    jobs: Record<string, { steps: CheckJob["steps"] }>;
  };
  expect(
    releaseWorkflow.jobs.build!.steps.find(
      (step) => step.uses === "tauri-apps/tauri-action@v1",
    )?.with?.args,
  ).toBe("--config src-tauri/tauri.release.conf.json");
  for (const file of ["tauri.conf.json", "tauri.release.conf.json"]) {
    const config = (await Bun.file(
      new URL(`../apps/desktop/src-tauri/${file}`, import.meta.url),
    ).json()) as { bundle: { windows?: { nsis?: { compression?: string } } } };
    expect(config.bundle.windows?.nsis?.compression ?? "lzma").toBe("lzma");
  }
  const shared = steps.find((step) => step.name === "Cache Bun downloads")!;
  const packaged = workflow.jobs.packaged!.steps;
  const restored = packaged.find(
    (step) => step.name === "Restore Bun downloads",
  )!;
  expect(shared.uses).toBe("actions/cache@v4");
  expect(restored.uses).toBe("actions/cache/restore@v4");
  expect(restored.with).toEqual(shared.with);
  expect(
    packaged.some((step) =>
      ["actions/cache@v4", "actions/cache/save@v4"].includes(step.uses ?? ""),
    ),
  ).toBe(false);
  expect(
    packaged.some((step) => step.run === "bun install --frozen-lockfile"),
  ).toBe(true);
});
