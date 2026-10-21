import { expect, test } from "bun:test";
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
