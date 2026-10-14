import { tsImport } from "tsx/esm/api";
const { startDaemon } = await tsImport(
  "../../apps/pi-bridge/src/daemon.ts",
  import.meta.url,
);
const daemon = await startDaemon(globalThis.process.env.LINGO_SOFA_HOME);
globalThis.process.once("SIGTERM", () => {
  void daemon.stop();
});
