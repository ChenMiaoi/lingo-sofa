import { localIdentity, signBinary, signingCommand } from "./macos-signing";
import { cleanEnv } from "./process";

const identity = await localIdentity();
if (!identity) throw new Error("Run npm run signing:setup first");
const executable = process.argv[2];
if (!executable) throw new Error("Expected a Cargo executable");
await signingCommand([
  "/usr/bin/security",
  "unlock-keychain",
  "-p",
  identity.password,
  identity.keychain,
]);
await signBinary(executable, identity, "com.lingosofa.desktop");
// Cargo/Tauri must own the actual application PID. A spawned child can survive
// a forced watcher restart and block the new version through single-instance.
if (!process.execve)
  throw new Error("This macOS runtime requires process.execve");
process.execve(executable, [executable, ...process.argv.slice(3)], cleanEnv());
