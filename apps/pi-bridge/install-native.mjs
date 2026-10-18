import { readFile, access, copyFile, chmod, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { browserRegistration } from "./native-registration.mjs";
const extensions = process.argv.slice(2);
if (extensions.some((id) => !/^[a-p]{32}$/.test(id)))
  throw new Error("Invalid extension ID");
const builtBinary = resolve(
  `dist/lingo-sofa-native-host${process.platform === "win32" ? ".exe" : ""}`,
);
await access(builtBinary);
execFileSync(process.execPath, ["install-runtime.mjs", ...extensions], {
  stdio: "inherit",
});
const assistantHome = resolve(
  process.env.LINGO_SOFA_HOME ?? join(homedir(), ".config/lingo-sofa"),
);
const binary = join(
  assistantHome,
  `lingo-sofa-native-host${process.platform === "win32" ? ".exe" : ""}`,
);
await copyFile(builtBinary, `${binary}.tmp`);
await chmod(`${binary}.tmp`, 0o755);
await rename(`${binary}.tmp`, binary);
const config = JSON.parse(
  await readFile(join(assistantHome, "config.json"), "utf8"),
);
const register = await browserRegistration(assistantHome, config);
await register();
console.log(
  "The local runtime and extension allowlist are installed. Keep the installed assistant directory and Node path in place.",
);
