import { Window } from "happy-dom";

export interface RuntimeTest {
  suite: string;
  name: string;
  passed: boolean;
  durationMs: number;
}

export function runtimeThreads(value: string | undefined): number {
  if (value !== undefined && value !== "1" && value !== "2")
    throw new Error("LINGOSOFA_TEST_THREADS must be 1 or 2");
  return Number(value ?? "2");
}

export function parseRuntimeReport(xml: string): RuntimeTest[] {
  const window = new Window();
  const document = new window.DOMParser().parseFromString(xml, "text/xml");
  const root = document.documentElement;
  if (root?.tagName !== "testsuites") throw new Error("Invalid JUnit report");
  const tests = [...document.querySelectorAll("testcase")].map((element) => {
    const name = element.getAttribute("name");
    const suite = element.getAttribute("classname");
    const seconds = element.getAttribute("time");
    const durationMs = Number(seconds) * 1000;
    if (
      !name ||
      !suite ||
      seconds === null ||
      !Number.isFinite(durationMs) ||
      durationMs < 0
    )
      throw new Error("Incomplete JUnit test result");
    return {
      suite,
      name,
      durationMs,
      passed: !element.querySelector("failure, error, skipped"),
    };
  });
  if (!tests.length || tests.length !== Number(root.getAttribute("tests")))
    throw new Error("JUnit test count mismatch");
  if (
    new Set(tests.map((test) => `${test.suite}::${test.name}`)).size !==
    tests.length
  )
    throw new Error("Duplicate JUnit test result");
  return tests;
}

export function runtimePassed(
  tests: RuntimeTest[],
  exitCode: number | null,
): boolean {
  return (
    exitCode === 0 &&
    tests.length > 0 &&
    tests.every((test) => test.passed) &&
    [
      "operating_system_reaps_worker_and_descendant_when_rust_host_is_killed",
      "actual_host_crash_recovers_pending_and_preserves_committed_terminal",
    ].every((name) => tests.some((test) => test.name === name))
  );
}
