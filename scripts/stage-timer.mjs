import { performance } from "node:perf_hooks";

// Print boundaries before work starts so a failed or stalled phase remains identifiable.
export function createStageTimer(scope) {
  const started = performance.now();
  let active;
  function end() {
    if (!active) return;
    console.log(
      `[timing] ${scope}: ${active.name} elapsed=${(performance.now() - active.started).toFixed(1)}ms`,
    );
    active = undefined;
  }
  return {
    start(name) {
      end();
      active = { name, started: performance.now() };
      console.log(`[timing] ${scope}: ${name} start`);
    },
    finish() {
      end();
      console.log(
        `[timing] ${scope}: total elapsed=${(performance.now() - started).toFixed(1)}ms`,
      );
    },
  };
}
