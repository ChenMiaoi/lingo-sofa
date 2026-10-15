import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
const root = resolve(import.meta.dirname, "..");
const install = process.argv.includes("--install");
if (process.argv.slice(2).some((argument) => argument !== "--install"))
  throw new Error("Usage: npm run setup:discord -- [--install]");
// Build and type-check against the pinned host before invoking its own installer.
execFileSync(process.execPath, [join(root, "scripts/verify-vencord.mjs")], {
  cwd: root,
  stdio: "inherit",
});
if (install) {
  console.log(
    "Opening the official Vencord installer for this custom build. Select the Discord installation to modify; close Discord first.",
  );
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules/pnpm/bin/pnpm.cjs"),
      "--dir",
      join(root, ".cache/vencord"),
      "--config.manage-package-manager-versions=false",
      "inject",
    ],
    { cwd: root, stdio: "inherit" },
  );
  console.log(
    "Follow the Vencord installer result above, restart Discord, and enable LingoSofa. Opening the installer alone does not confirm a successful installation.",
  );
} else
  console.log(
    "Custom Vencord build prepared. To install it into Discord, close Discord and run npm run setup:discord -- --install. This modifies the selected Discord client using the official Vencord installer.",
  );
