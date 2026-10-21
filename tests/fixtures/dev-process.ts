import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const [mode, log, pidFile] = process.argv.slice(2);
if (mode === "startup-fail") process.exit(7);
if (mode === "app-fail") process.exit(9);
if (mode === "app") {
  appendFileSync(log!, "app\n");
} else if (mode === "stall") {
  setInterval(() => {}, 1000);
} else if (mode === "server") {
  writeFileSync(`${pidFile}.parent`, String(process.pid));
  const child = spawn(process.execPath, [import.meta.filename, "stall"], {
    stdio: "ignore",
  });
  writeFileSync(pidFile!, String(child.pid));
  appendFileSync(log!, "ready\n");
  process.send?.("lingo-sofa:dev-ready");
  setInterval(() => {}, 1000);
} else if (mode === "crashing-server") {
  writeFileSync(log!, "ready\n");
  process.send?.("lingo-sofa:dev-ready");
  setInterval(() => {
    if (readFileSync(log!, "utf8").includes("app\n")) process.exit(8);
  }, 25);
} else if (mode === "waiting-app") {
  const child = spawn(process.execPath, [import.meta.filename, "stall"], {
    stdio: "ignore",
  });
  writeFileSync(pidFile!, String(child.pid));
  appendFileSync(log!, "app\n");
  setInterval(() => {}, 1000);
}
