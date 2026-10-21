import { resolve } from "node:path";
import {
  localIdentity,
  signBinary,
  signRuntime,
  signingCommand,
} from "./macos-signing";
import { root, run } from "./process";

if (process.platform !== "darwin")
  throw new Error("Local app signing requires macOS");
const identity = await localIdentity();
if (!identity) throw new Error("Run npm run signing:setup first");
await run([
  process.execPath,
  "scripts/desktop.ts",
  "build",
  "--debug",
  "--bundles",
  "app",
]);
const bundle = resolve(root, "target/debug/bundle/macos/LingoSofa.app");
await signRuntime(identity, resolve(bundle, "Contents/Resources/runtime"));
await signBinary(bundle, identity, "com.lingosofa.desktop");
await signingCommand([
  "/usr/bin/codesign",
  "--verify",
  "--deep",
  "--strict",
  bundle,
]);
console.log(`Signed local application: ${bundle}`);
if (process.argv.includes("--launch")) await run(["/usr/bin/open", bundle]);
